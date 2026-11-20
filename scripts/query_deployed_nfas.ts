import { query, getDbPool } from '../src/db/pool.js';

async function check() {
  const pool = getDbPool();
  try {
    const res = await query(`
      SELECT id, ref_no, title, department_id, created_by, total_amount, status, created_at
      FROM nfas
      WHERE ref_no LIKE '%0023%' OR ref_no LIKE '%0024%' OR ref_no LIKE '%0025%' OR ref_no LIKE '%0026%' OR ref_no LIKE '%0027%'
         OR total_amount = 2200 OR title = 'test'
      ORDER BY created_at ASC;
    `);
    console.log('Found records in PostgreSQL:', res.rows.length);
    console.log(JSON.stringify(res.rows, null, 2));

    // Also check budget reservations for ADSE department
    const adseBudgets = await query(`
      SELECT * FROM department_budgets 
      WHERE department_id = '330ada81-5246-4c92-9ca2-688eae0f28d4';
    `);
    console.log('\nADSE Department Budget in PostgreSQL:');
    console.log(JSON.stringify(adseBudgets.rows, null, 2));

    // Check approvals for these NFAs
    if (res.rows.length > 0) {
      const ids = res.rows.map(r => `'${r.id}'`).join(',');
      const approvals = await query(`
        SELECT id, nfa_id, approver_role, decision, created_at
        FROM approvals
        WHERE nfa_id IN (${ids});
      `);
      console.log('\nApprovals for these NFAs:', approvals.rows);
    }
  } finally {
    await pool.end();
  }
}

check().catch(console.error);
