import assert from 'assert';
import { store } from '../src/store.js';
import { getReportDataset, getExecutiveSummaryData, resolveAuthorizedScope } from '../src/routes/reports.js';

if (store.initPromise) {
  store.initPromise.catch(() => {});
}

async function run() {
  console.log('--- Testing Report Scoping and Isolation ---');

  const admin = store.data.users.find((u) => u.role === 'super_admin') || {
    id: 'admin-id',
    name: 'Super Admin',
    role: 'super_admin',
    department_id: null,
  };

  const autoCentre = store.data.departments.find((d) => d.code === 'COE-AUTO');
  const ardcCentre = store.data.departments.find((d) => d.code === 'COE-ARDC');
  const mechDept = store.data.departments.find((d) => d.code === 'MECH');
  const cseDept = store.data.departments.find((d) => d.code === 'CSE');

  assert(autoCentre, 'COE-AUTO must exist in departments');
  assert(ardcCentre, 'COE-ARDC must exist in departments');
  assert(mechDept, 'MECH must exist in departments');
  assert(cseDept, 'CSE must exist in departments');

  // Test 1: COE-AUTO Scoping
  console.log('Test 1: Filter by COE-AUTO');
  const autoScope = resolveAuthorizedScope(admin as any, { centre_id: autoCentre.id });
  assert.strictEqual(autoScope.scope, 'centre');
  assert.strictEqual(autoScope.targetDeptIds.size, 1);
  assert(autoScope.targetDeptIds.has(autoCentre.id), 'Must include COE-AUTO');
  assert(!autoScope.targetDeptIds.has(ardcCentre.id), 'Must NOT include COE-ARDC');

  // Test 2: MECH Scoping
  console.log('Test 2: Filter by MECH department');
  const mechScope = resolveAuthorizedScope(admin as any, { department_id: mechDept.id });
  assert.strictEqual(mechScope.scope, 'department');
  assert.strictEqual(mechScope.targetDeptIds.size, 1);
  assert(mechScope.targetDeptIds.has(mechDept.id), 'Must include MECH');
  assert(!mechScope.targetDeptIds.has(cseDept.id), 'Must NOT include CSE');

  // Test 3: Faculty NFA report filtering
  console.log('Test 3: Faculty Report isolation for CSE');
  const cseFacultyReport = getReportDataset('faculty_nfa', admin as any, { department_id: cseDept.id });
  cseFacultyReport.forEach((row: any) => {
    assert.strictEqual(row.department, 'CSE', `Expected row to belong to CSE, got ${row.department}`);
  });
  console.log(`CSE Faculty rows returned: ${cseFacultyReport.length}`);

  // Test 4: Zero-activity faculty exclusion
  console.log('Test 4: Zero-activity faculty exclusion vs inclusion');
  const cseFiltered = getReportDataset('faculty_nfa', admin as any, { department_id: cseDept.id });
  const cseAll = getReportDataset('faculty_nfa', admin as any, { department_id: cseDept.id, include_all_faculty: 'true' });
  console.log(`Active faculty count: ${cseFiltered.length}, All faculty count: ${cseAll.length}`);
  assert(cseAll.length >= cseFiltered.length, 'All faculty count should be >= active faculty count');
  cseFiltered.forEach((row: any) => {
    assert(row.total_submitted > 0, `Expected submitted NFAs > 0 for active faculty, got ${row.total_submitted}`);
  });

  // Test 5: Executive Summary Data completeness
  console.log('Test 5: Executive Summary completeness');
  const summary = getExecutiveSummaryData(admin as any, { department_id: cseDept.id });
  assert.strictEqual(summary.scope, 'department');
  assert.strictEqual(summary.org_code, 'CSE');
  assert(summary.metrics, 'Metrics object must be present');
  assert(typeof summary.metrics.allocated === 'number', 'Allocated must be number');
  assert(typeof summary.metrics.available === 'number', 'Available must be number');
  assert(summary.metrics.available === summary.metrics.allocated - summary.metrics.approved - summary.metrics.pending, 'Financial equation: Available = Allocated - Approved - Pending');
  assert(Array.isArray(summary.faculty_activity), 'Faculty activity must be array');
  assert(Array.isArray(summary.detailed_nfas), 'Detailed NFAs must be array');

  console.log('All 5 isolation and reporting tests passed cleanly!');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
