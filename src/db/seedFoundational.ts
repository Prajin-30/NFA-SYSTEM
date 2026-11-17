import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataJsonPath = path.join(__dirname, '..', '..', 'data', 'db.json');

/**
 * Seeds foundational institutional reference data from verified records:
 * - Exactly 13 verified departments and Centres of Excellence
 * - Active financial year (2026-27)
 * - Budget types, categories, subcategories, and baseline allocations
 *
 * NOTE: Preserves exact UUIDs for stable cell mapping and institutional history.
 * IMPORTANT: Does NOT import or invent real Faculty personal details.
 */
export function normalizeUuid(id: string): string {
  if (!id) return id;
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    return id.toLowerCase();
  }
  let out = '';
  for (let i = 0; i < id.length; i++) {
    const c = id[i].toLowerCase();
    if (c === '-' || /[0-9a-f]/.test(c)) {
      out += c;
    } else {
      out += (c.charCodeAt(0) % 16).toString(16);
    }
  }
  return out;
}

export async function seedFoundationalData(
  client: pg.PoolClient | pg.Pool,
  options?: { includeDemoBudgets?: boolean }
) {
  if (!fs.existsSync(dataJsonPath)) {
    throw new Error(`Data file not found at ${dataJsonPath}`);
  }

  const raw = fs.readFileSync(dataJsonPath, 'utf-8');
  const db = JSON.parse(raw);

  // 1. Departments (13 confirmed active units + preserve DRAS as inactive)
  for (const d of db.departments || []) {
    const isActive = d.is_active !== false && d.code !== 'DRAS';
    const deptId = normalizeUuid(d.id);
    await client.query(
      `INSERT INTO departments (id, name, code, category, is_active, hod_name, dean_name, faculty_name, associate_dean_name, director_name, finance_officer_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         code = EXCLUDED.code,
         category = EXCLUDED.category,
         is_active = EXCLUDED.is_active;`,
      [
        deptId,
        d.name,
        d.code,
        d.category || 'academic',
        isActive,
        d.hod_name || '',
        d.dean_name || '',
        d.faculty_name || '',
        d.associate_dean_name || '',
        d.director_name || '',
        d.finance_officer_name || '',
      ]
    );
  }

  // 2. Financial Years
  for (const fy of db.financial_years || []) {
    await client.query(
      `INSERT INTO financial_years (id, label, is_active)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label,
         is_active = EXCLUDED.is_active;`,
      [fy.id, fy.label, fy.is_active || false]
    );
  }

  // 3. Budget Types
  for (const bt of db.budget_types || []) {
    await client.query(
      `INSERT INTO budget_types (id, name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name;`,
      [bt.id, bt.name]
    );
  }

  // 4. Budget Categories
  for (const bc of db.budget_categories || []) {
    await client.query(
      `INSERT INTO budget_categories (id, budget_type_id, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         budget_type_id = EXCLUDED.budget_type_id,
         name = EXCLUDED.name;`,
      [bc.id, bc.budget_type_id, bc.name]
    );
  }

  // 5. Demo Budgets & Subcategories (ONLY seeded when explicitly requested, e.g. local isolated demo testing)
  if (options?.includeDemoBudgets) {
    for (const bs of db.budget_subcategories || []) {
      await client.query(
        `INSERT INTO budget_subcategories (id, budget_category_id, department_id, name, allocated_amount, approved_amount, pending_amount, cell_mapping)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           allocated_amount = EXCLUDED.allocated_amount,
           approved_amount = EXCLUDED.approved_amount,
           pending_amount = EXCLUDED.pending_amount,
           cell_mapping = EXCLUDED.cell_mapping;`,
        [
          bs.id,
          bs.budget_category_id,
          bs.department_id ? normalizeUuid(bs.department_id) : null,
          bs.name,
          bs.allocated_amount || 0,
          bs.approved_amount || 0,
          bs.pending_amount || 0,
          bs.cell_mapping ? JSON.stringify(bs.cell_mapping) : null,
        ]
      );
    }

    for (const b of db.department_budgets || []) {
      await client.query(
        `INSERT INTO department_budgets (id, department_id, financial_year_id, budget_category_id, allocated_amount, approved_amount, pending_amount, revised_amount, cell_mapping)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           allocated_amount = EXCLUDED.allocated_amount,
           approved_amount = EXCLUDED.approved_amount,
           pending_amount = EXCLUDED.pending_amount,
           revised_amount = EXCLUDED.revised_amount,
           cell_mapping = EXCLUDED.cell_mapping;`,
        [
          b.id,
          normalizeUuid(b.department_id),
          b.financial_year_id,
          b.budget_category_id,
          b.allocated_amount || 0,
          b.approved_amount || 0,
          b.pending_amount || 0,
          b.revised_amount || 0,
          b.cell_mapping ? JSON.stringify(b.cell_mapping) : null,
        ]
      );
    }
  }

  return {
    departmentsCount: (db.departments || []).length,
    activeDepartmentsCount: (db.departments || []).filter((d: any) => d.is_active !== false && d.code !== 'DRAS').length,
    financialYearsCount: (db.financial_years || []).length,
    budgetTypesCount: (db.budget_types || []).length,
    budgetCategoriesCount: (db.budget_categories || []).length,
    demoBudgetsSeeded: Boolean(options?.includeDemoBudgets),
  };
}
