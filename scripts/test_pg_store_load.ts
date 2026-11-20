import { getDbPool } from '../src/db/pool.js';
import type { DB } from '../src/types.js';

async function loadFromPostgres(): Promise<DB> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    const usersRes = await client.query('SELECT * FROM user_profiles ORDER BY name ASC');
    const deptsRes = await client.query('SELECT * FROM departments ORDER BY name ASC');
    const fyRes = await client.query('SELECT * FROM financial_years ORDER BY label ASC');
    const btRes = await client.query('SELECT * FROM budget_types ORDER BY name ASC');
    const bcRes = await client.query('SELECT * FROM budget_categories ORDER BY name ASC');
    const dbBudgetsRes = await client.query('SELECT * FROM department_budgets');
    const subcatRes = await client.query('SELECT * FROM budget_subcategories');
    const projRes = await client.query('SELECT * FROM projects');
    const nfasRes = await client.query('SELECT * FROM nfas ORDER BY created_at DESC');
    const nfaItemsRes = await client.query('SELECT * FROM nfa_items ORDER BY sl_no ASC');
    const approvalsRes = await client.query('SELECT * FROM approvals ORDER BY level ASC');
    const txRes = await client.query('SELECT * FROM budget_transactions ORDER BY created_at DESC');
    const auditRes = await client.query('SELECT * FROM audit_logs ORDER BY created_at DESC');
    const syncRes = await client.query('SELECT * FROM excel_sync_records');
    const uploadsRes = await client.query('SELECT * FROM budget_uploads');
    const changesRes = await client.query('SELECT * FROM budget_changes');
    const bankRes = await client.query('SELECT * FROM resource_person_bank_details');
    const invoicesRes = await client.query('SELECT * FROM purchase_invoices');
    const tokensRes = await client.query('SELECT * FROM revoked_tokens');

    console.log('✓ Successfully loaded all 19 tables from PostgreSQL using 1 connection:');
    console.log(`- user_profiles: ${usersRes.rows.length}`);
    console.log(`- departments: ${deptsRes.rows.length}`);
    console.log(`- financial_years: ${fyRes.rows.length}`);
    console.log(`- budget_types: ${btRes.rows.length}`);
    console.log(`- budget_categories: ${bcRes.rows.length}`);
    console.log(`- department_budgets: ${dbBudgetsRes.rows.length}`);
    console.log(`- budget_subcategories: ${subcatRes.rows.length}`);
    console.log(`- projects: ${projRes.rows.length}`);
    console.log(`- nfas: ${nfasRes.rows.length}`);
    console.log(`- nfa_items: ${nfaItemsRes.rows.length}`);
    console.log(`- approvals: ${approvalsRes.rows.length}`);
    console.log(`- budget_transactions: ${txRes.rows.length}`);
    console.log(`- audit_logs: ${auditRes.rows.length}`);
    console.log(`- purchase_invoices: ${invoicesRes.rows.length}`);
    console.log(`- revoked_tokens: ${tokensRes.rows.length}`);

    return {
      users: usersRes.rows as any,
      departments: deptsRes.rows as any,
      financial_years: fyRes.rows as any,
      budget_types: btRes.rows as any,
      budget_categories: bcRes.rows as any,
      department_budgets: dbBudgetsRes.rows as any,
      budget_subcategories: subcatRes.rows as any,
      projects: projRes.rows as any,
      nfas: nfasRes.rows as any,
      nfa_items: nfaItemsRes.rows as any,
      approvals: approvalsRes.rows as any,
      budget_transactions: txRes.rows as any,
      audit_logs: auditRes.rows as any,
      excel_sync_records: syncRes.rows as any,
      budget_uploads: uploadsRes.rows as any,
      budget_changes: changesRes.rows as any,
      resource_person_bank_details: bankRes.rows as any,
      purchase_invoices: invoicesRes.rows as any,
      revoked_tokens: tokensRes.rows as any,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

loadFromPostgres().catch(console.error);
