import { store } from '../src/store.js';
import { computeDepartmentMetrics, getExecutiveSummaryData, resolveAuthorizedScope } from '../src/routes/reports.js';

async function run() {
  if (store.initPromise) {
    try {
      await store.initPromise;
    } catch {}
  }
  const adse = store.data.departments.find((d) => d.code === 'ADSE');
  console.log('ADSE Dept ID:', adse?.id);
  console.log('Store event revenues:', store.data.event_revenues);
  console.log('Active FY:', store.data.financial_years.find((f) => f.is_active));

  const admin = store.data.users.find((u) => u.role === 'super_admin');

  // Case 1: call with id
  const summaryWithId = getExecutiveSummaryData(admin as any, { scope: 'department', id: adse?.id });
  console.log('\nCase 1: { scope: "department", id: ADSE }:');
  console.log('  Scope resolved:', summaryWithId.scope, summaryWithId.org_code);
  console.log('  Metrics:', summaryWithId.metrics);

  // Case 2: call with department_id
  const summaryWithDeptId = getExecutiveSummaryData(admin as any, { scope: 'department', department_id: adse?.id });
  console.log('\nCase 2: { scope: "department", department_id: ADSE }:');
  console.log('  Scope resolved:', summaryWithDeptId.scope, summaryWithDeptId.org_code);
  console.log('  Metrics:', summaryWithDeptId.metrics);

  // Case 3: SBM school
  const sbm = store.data.schools?.find((s) => s.code === 'SBM');
  console.log('\nCase 3: SBM school:', sbm);
  const summarySbmWithId = getExecutiveSummaryData(admin as any, { scope: 'school', id: sbm?.id });
  console.log('  SBM with id:', summarySbmWithId.scope, summarySbmWithId.org_code, summarySbmWithId.org_name);

  const summarySbmWithCode = getExecutiveSummaryData(admin as any, { scope: 'school', id: 'SBM' });
  console.log('  SBM with code:', summarySbmWithCode.scope, summarySbmWithCode.org_code, summarySbmWithCode.org_name);
}

run().catch(console.error);
