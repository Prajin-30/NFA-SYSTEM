import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { DB } from './types.js';
import { getDbPool, withTransaction } from './db/pool.js';
import { loadAllFromPostgres, persistDiffToPostgres } from './db/sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_FILE = path.join(__dirname, '..', 'data', 'db.json');

function emptyDb(): DB {
  return {
    users: [],
    departments: [],
    schools: [],
    financial_years: [],
    budget_types: [],
    budget_categories: [],
    department_budgets: [],
    projects: [],
    nfas: [],
    nfa_items: [],
    approvals: [],
    budget_transactions: [],
    audit_logs: [],
    excel_sync_records: [],
    budget_uploads: [],
    budget_changes: [],
    resource_person_bank_details: [],
    purchase_invoices: [],
    event_revenues: [],
    event_revenue_reminders: [],
    revoked_tokens: [],
  };
}

class Store {
  private db: DB;
  private writeQueue: Promise<void> = Promise.resolve();
  public initPromise: Promise<void> | null = null;
  public readonly isPostgres: boolean;

  // Safe reference indices for static metadata (departments, schools, categories, financial years)
  // Strictly NEVER used for dynamic financial balances or approval states
  private departmentMap: Map<string, any> = new Map();
  private schoolMap: Map<string, any> = new Map();
  private categoryMap: Map<string, any> = new Map();
  private fyMap: Map<string, any> = new Map();

  private rebuildReferenceIndices(): void {
    this.departmentMap.clear();
    for (const d of this.db.departments || []) {
      this.departmentMap.set(d.id, d);
    }
    this.schoolMap.clear();
    for (const s of this.db.schools || []) {
      this.schoolMap.set(s.id, s);
      if (s.code) this.schoolMap.set(s.code.toUpperCase(), s);
    }
    this.categoryMap.clear();
    for (const c of this.db.budget_categories || []) {
      this.categoryMap.set(c.id, c);
    }
    this.fyMap.clear();
    for (const f of this.db.financial_years || []) {
      this.fyMap.set(f.id, f);
      if (f.label) this.fyMap.set(f.label, f);
    }
  }

  constructor() {
    this.isPostgres = Boolean(process.env.DATABASE_URL || process.env.DATA_SOURCE === 'postgres');

    if (fs.existsSync(DATA_FILE)) {
      try {
        this.db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      } catch {
        this.db = emptyDb();
      }
      this.db.budget_uploads ||= [];
      this.db.budget_changes ||= [];
      this.db.budget_subcategories ||= [];
      this.db.resource_person_bank_details ||= [];
      this.db.purchase_invoices ||= [];
      this.db.event_revenues ||= [];
      this.db.event_revenue_reminders ||= [];
      this.db.schools ||= [];
      if (this.db.schools.length === 0) {
        this.db.schools = [
          { id: '11111111-0000-0000-0000-000000000001', code: 'SOET', name: 'School of Engineering and Technology', campus: 'Bengaluru – Kengeri Campus' },
          { id: '11111111-0000-0000-0000-000000000002', code: 'SOA', name: 'School of Arts', campus: 'Bengaluru Central Campus' },
          { id: '11111111-0000-0000-0000-000000000003', code: 'SBM', name: 'School of Business and Management', campus: 'Bengaluru Central Campus' },
          { id: '11111111-0000-0000-0000-000000000004', code: 'SPS', name: 'School of Psychological Sciences', campus: 'Bengaluru Bannerghatta Road Campus' },
        ];
      }
      const soetId = this.db.schools[0]?.id;
      if (soetId && Array.isArray(this.db.departments)) {
        this.db.departments.forEach((d) => {
          if (d.category !== 'coe' && !d.code.startsWith('COE-') && !d.school_id) {
            d.school_id = soetId;
          }
        });
      }
      this.db.mock_emails ||= [];
      this.db.revoked_tokens ||= [];
    } else {
      this.db = emptyDb();
    }

    this.rebuildReferenceIndices();

    if (this.isPostgres) {
      this.initPromise = this.loadFromPostgres();
    }
  }

  /**
   * Hydrates in-memory cache directly from authoritative Supabase PostgreSQL tables.
   * Throws DATABASE_UNAVAILABLE if connection fails in production mode (no silent fallback).
   */
  async loadFromPostgres(): Promise<void> {
    try {
      try {
        const { runMigrations } = await import('./db/migrate.js');
        await runMigrations();
      } catch (mErr: any) {
        console.warn('[MIGRATIONS] Auto-run migrations notice:', mErr.message);
      }
      const client = await getDbPool().connect();
      try {
        this.db = await loadAllFromPostgres(client);
        this.rebuildReferenceIndices();
        console.log(`[STORE] Authoritative dataset loaded from Supabase PostgreSQL (${this.db.nfas.length} NFAs, ${this.db.department_budgets.length} budgets).`);
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error('[STORE FATAL] Failed to connect to Supabase PostgreSQL database:', err.message);
      if (this.isPostgres) {
        throw new Error(`DATABASE_UNAVAILABLE: Authoritative Supabase PostgreSQL connection failed: ${err.message}`);
      }
    }
  }

  /** Fast O(1) department lookup */
  getDepartment(id: string): any | undefined {
    return this.departmentMap.get(id);
  }

  /** Fast O(1) school lookup by ID or uppercase code */
  getSchool(idOrCode: string): any | undefined {
    return this.schoolMap.get(idOrCode) || this.schoolMap.get(idOrCode.toUpperCase());
  }

  /** Fast O(1) budget category lookup */
  getBudgetCategory(id: string): any | undefined {
    return this.categoryMap.get(id);
  }

  /** Fast O(1) financial year lookup by ID or label */
  getFinancialYear(idOrLabel: string): any | undefined {
    return this.fyMap.get(idOrLabel);
  }

  /** Read-only snapshot access */
  get data(): DB {
    return this.db;
  }

  /**
   * Run a mutation against the DB and persist atomically.
   * In PostgreSQL mode, persists mutated entities to PostgreSQL inside withTransaction.
   * In offline local mode, persists to data/db.json.
   */
  async transact<T>(fn: (db: DB) => T | Promise<T>): Promise<T> {
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch (err: any) {
        throw err;
      }
    }

    let result!: T;
    this.writeQueue = this.writeQueue.then(async () => {
      const snapshot = JSON.stringify(this.db);
      const beforeDb: DB = JSON.parse(snapshot);
      try {
        result = await fn(this.db);
        if (this.isPostgres) {
          await withTransaction(async (client) => {
            await persistDiffToPostgres(client, beforeDb, this.db);
          });
        } else {
          this.persist();
        }
        this.rebuildReferenceIndices();
      } catch (err) {
        this.db = JSON.parse(snapshot);
        this.rebuildReferenceIndices();
        throw err;
      }
    });
    await this.writeQueue;
    return result;
  }

  private persist() {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    try {
      fs.renameSync(tmp, DATA_FILE);
    } catch (err: any) {
      if (err.code === 'EPERM' || err.code === 'EBUSY') {
        fs.copyFileSync(tmp, DATA_FILE);
        try { fs.unlinkSync(tmp); } catch { }
      } else {
        throw err;
      }
    }
  }
}

export const store = new Store();
