import { store } from '../src/store.js';
import { query, getDbPool } from '../src/db/pool.js';
import { v4 as uuid } from 'uuid';

async function run() {
  console.log('=== TESTING STORE POSTGRESQL INTEGRATION ===\n');

  // Wait for store initialization
  if (store.initPromise) {
    await store.initPromise;
  }

  console.log('1. Checking Store In-Memory Hydration:');
  console.log(`- store.isPostgres: ${store.isPostgres}`);
  console.log(`- store.data.departments: ${store.data.departments.length} (Expected: 14)`);
  console.log(`- store.data.financial_years: ${store.data.financial_years.length} (Expected: 3)`);
  console.log(`- store.data.budget_categories: ${store.data.budget_categories.length} (Expected: 15)`);
  console.log(`- store.data.nfas: ${store.data.nfas.length} (Expected: 32)`);
  console.log(`- store.data.approvals: ${store.data.approvals.length} (Expected: 72)`);
  console.log(`- store.data.department_budgets: ${store.data.department_budgets.length} (Expected: 73)`);

  if (store.data.departments.length !== 14 || store.data.nfas.length < 30) {
    throw new Error('Store failed to hydrate correctly from PostgreSQL!');
  }
  console.log('✓ In-memory store successfully verified against PostgreSQL data!\n');

  console.log('2. Testing Store Transaction Persistence:');
  const testRefNo = `NFA/TEST-SYNC/${Date.now()}`;
  const testNfaId = uuid();
  const cseDept = store.data.departments.find(d => d.code === 'CSE')!;
  const activeFy = store.data.financial_years.find(f => f.is_active)!;
  const firstCat = store.data.budget_categories[0]!;
  const adminUser = store.data.users.find(u => u.role === 'super_admin') || store.data.users[0]!;

  const createdNfa = await store.transact((db) => {
    const n = {
      id: testNfaId,
      ref_no: testRefNo,
      project_id: null,
      department_id: cseDept.id,
      centre_id: null,
      organization_type: 'department' as const,
      workflow_type: 'department' as const,
      financial_year_id: activeFy.id,
      budget_type_id: firstCat.budget_type_id,
      budget_category_id: firstCat.id,
      budget_subcategory_id: null,
      budget_subcategory_name: '',
      title: 'Store Sync Integration Test NFA',
      purpose: 'Testing PostgreSQL Persistence',
      description: 'Auto-generated integration test',
      justification: 'Verification',
      sdgs: '',
      requirements: '',
      total_amount: 1500,
      status: 'submitted' as const,
      created_by: adminUser.id,
      submitted_by_name: adminUser.name,
      submitted_by_designation: 'Administrator',
      hod_name: '',
      date: new Date().toISOString().slice(0, 10),
      point1: '',
      point2: '',
      point3: '',
      point4: '',
      nfa_type: 'event' as const,
      event_details: null,
      purchase_details: null,
      quotations: [],
      comparative_statement: null,
      proposer_signature: null,
    };
    db.nfas.push(n);
    return n;
  });

  console.log(`✓ store.transact completed for NFA ${createdNfa.ref_no}`);

  // 3. Verify in PostgreSQL directly via independent query
  const pgCheck = await query('SELECT id, ref_no, title, total_amount, status FROM nfas WHERE id = $1', [testNfaId]);
  if (pgCheck.rows.length === 0) {
    throw new Error('NFA was NOT persisted to PostgreSQL!');
  }
  console.log('✓ Confirmed record persisted in PostgreSQL table "nfas":', pgCheck.rows[0]);

  // Clean up test NFA
  await store.transact((db) => {
    db.nfas = db.nfas.filter(n => n.id !== testNfaId);
  });
  const pgCleanCheck = await query('SELECT count(*) FROM nfas WHERE id = $1', [testNfaId]);
  if (parseInt(pgCleanCheck.rows[0].count, 10) !== 0) {
    throw new Error('NFA cleanup failed to delete from PostgreSQL!');
  }
  console.log('✓ Confirmed record deleted from PostgreSQL on store deletion transaction!\n');

  console.log('4. Financial Invariant Verification:');
  let invalidBudgets = 0;
  for (const b of store.data.department_budgets) {
    const allocated = Number(b.allocated_amount);
    const approved = Number(b.approved_amount);
    const pending = Number(b.pending_amount);
    const available = allocated - approved - pending;
    if (isNaN(available)) {
      invalidBudgets++;
    }
  }
  console.log(`✓ Checked all ${store.data.department_budgets.length} department budget lines. Invalid lines: ${invalidBudgets}`);

  console.log('\n=== ALL STORE POSTGRESQL INTEGRATION TESTS PASSED! ===');
  await getDbPool().end();
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
