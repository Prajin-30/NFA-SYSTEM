import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { DB } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_FILE = path.join(__dirname, '..', 'data', 'db.json');

function emptyDb(): DB {
  return {
    users: [],
    departments: [],
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
  };
}

class Store {
  private db: DB;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    if (fs.existsSync(DATA_FILE)) {
      this.db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      this.db.budget_uploads ||= [];
      this.db.budget_changes ||= [];
    } else {
      this.db = emptyDb();
      this.persist();
    }
  }

  /** Read-only snapshot access */
  get data(): DB {
    return this.db;
  }

  /**
   * Run a mutation against the DB and persist atomically.
   * Serialized via writeQueue so financial mutations never interleave
   * (this is our stand-in for a DB transaction on a single-process JSON store).
   */
  async transact<T>(fn: (db: DB) => T): Promise<T> {
    let result!: T;
    this.writeQueue = this.writeQueue.then(() => {
      // snapshot for rollback-on-error
      const snapshot = JSON.stringify(this.db);
      try {
        result = fn(this.db);
        this.persist();
      } catch (err) {
        this.db = JSON.parse(snapshot);
        throw err;
      }
    });
    await this.writeQueue;
    return result;
  }

  private persist() {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }
}

export const store = new Store();
