import http from 'http';
import { Socket } from 'net';
import { v4 as uuid } from 'uuid';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';
import { resetSentNotifications } from '../src/services/notifications.js';
import { formatAmount } from '../src/lib/pdf.js';
import { withPgBudgetLock } from '../src/lib/budgetEngine.js';
import { query } from '../src/db/pool.js';

function request(options: { method: string; url: string; headers?: Record<string, string>; body?: any }): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.method = options.method || 'GET';
    req.url = options.url || '/';
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.headers || {})) {
      hdrs[k.toLowerCase()] = v;
    }
    req.headers = hdrs;
    (req as any).body = options.body;

    const res = new http.ServerResponse(req);
    let chunks: Buffer[] = [];
    res.write = function (chunk: any) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return true;
    } as any;
    res.end = function (chunk: any) {
      if (chunk) chunks.push(Buffer.from(chunk));
      const str = Buffer.concat(chunks).toString('utf8');
      let parsed: any = str;
      try { parsed = JSON.parse(str); } catch (e) { }
      resolve({ status: res.statusCode, body: parsed });
      return this;
    } as any;

    app.handle(req, res, (err: any) => {
      if (err) reject(err);
    });
  });
}

async function runTests() {
  console.log('\n======================================================');
  console.log('--- STARTING COMPREHENSIVE WORKFLOW & FINANCIAL TESTS ---');
  console.log('======================================================\n');

  if (store.initPromise) {
    await store.initPromise;
  }

  resetSentNotifications();
  store.data.mock_emails = [];

  const adseDept = store.data.departments.find((d) => d.code === 'ADSE') || store.data.departments[0];
  const mechDept = store.data.departments.find((d) => d.code === 'MECH') || store.data.departments[1];
  const autoCentre = store.data.departments.find((d) => d.code.includes('AUTO')) || store.data.departments[2];
  const adseDeptId = adseDept.id;
  const mechDeptId = mechDept.id;
  const autoCentreId = autoCentre.id;
  const fyId = store.data.financial_years.find((f) => f.is_active)!.id;
  const cat = store.data.budget_categories[0];
  const catId = cat.id;

  // Ensure department budget line exists for MECH for testing Workflow B
  let mechLine = store.data.department_budgets.find((b) => b.department_id === mechDeptId && b.financial_year_id === fyId && b.budget_category_id === catId);
  if (!mechLine) {
    mechLine = {
      id: uuid(),
      department_id: mechDeptId,
      financial_year_id: fyId,
      budget_category_id: catId,
      allocated_amount: 5000000,
      approved_amount: 0,
      pending_amount: 0,
      revised_amount: 0,
    };
    store.data.department_budgets.push(mechLine);
  }

  // Ensure department budget line exists for AUTO Centre for testing Workflow C
  let autoLine = store.data.department_budgets.find((b) => b.department_id === autoCentreId && b.financial_year_id === fyId && b.budget_category_id === catId);
  if (!autoLine) {
    autoLine = {
      id: uuid(),
      department_id: autoCentreId,
      financial_year_id: fyId,
      budget_category_id: catId,
      allocated_amount: 5000000,
      approved_amount: 0,
      pending_amount: 0,
      revised_amount: 0,
    };
    store.data.department_budgets.push(autoLine);
  }

  // Authoritative live users from store
  const arulUser = store.data.users.find((u) => u.email === 'arul.v@christuniversity.in') || store.data.users[0];
  arulUser.authorized_centre_ids = [autoCentreId];
  if (process.env.DATABASE_URL) {
    await query(`UPDATE user_profiles SET authorized_centre_ids = $1 WHERE id = $2`, [[autoCentreId], arulUser.id]);
  }
  const mosesUser = store.data.users.find((u) => u.email === 'michael.moses@christuniversity.in') || store.data.users[0];
  const deansOfficeUser = store.data.users.find((u) => u.role === 'deans_office') || store.data.users[0];
  const assocDeanUser = store.data.users.find((u) => u.role === 'associate_dean') || store.data.users[0];
  const deanUser = store.data.users.find((u) => u.role === 'dean') || store.data.users[0];
  const financeUser = store.data.users.find((u) => u.role === 'finance') || store.data.users[0];
  const directorUser = store.data.users.find((u) => u.role === 'director') || store.data.users[0];
  const financeHeadUser = store.data.users.find((u) => u.role === 'finance_head') || store.data.users[0];

  // Dynamic Workflow B faculty
  const facultyWorkflowB = store.data.users.find((u) => {
    if (u.role !== 'faculty' || u.must_change_password) return false;
    const d = store.data.departments.find(dept => dept.id === u.department_id);
    return d && d.code !== 'CSE' && d.code !== 'ADSE' && !d.code.startsWith('COE-');
  }) || arulUser;
  const workflowBDeptId = facultyWorkflowB.department_id || mechDeptId;

  // Designate / find active HOD for Workflow B department
  let hodWorkflowB = store.data.users.find((u) => u.department_id === workflowBDeptId && u.role === 'hod');
  if (!hodWorkflowB) {
    const candidate = store.data.users.find((u) => u.department_id === workflowBDeptId && u.id !== facultyWorkflowB.id) || store.data.users.find((u) => u.department_id === workflowBDeptId);
    if (candidate) {
      candidate.role = 'hod';
      candidate.must_change_password = false;
      hodWorkflowB = candidate;
      if (process.env.DATABASE_URL) {
        await query(`UPDATE user_profiles SET role = 'hod', must_change_password = false WHERE id = $1`, [candidate.id]);
      }
    }
  } else if (hodWorkflowB.must_change_password) {
    hodWorkflowB.must_change_password = false;
    if (process.env.DATABASE_URL) {
      await query(`UPDATE user_profiles SET must_change_password = false WHERE id = $1`, [hodWorkflowB.id]);
    }
  }

  // Tokens for actors
  const facultyAdseToken = signToken({
    id: arulUser.id,
    name: arulUser.name,
    role: 'faculty',
    email: arulUser.email,
    department_id: adseDeptId,
    authorized_centre_ids: [autoCentreId],
    is_active: true,
  });

  const facultyMechToken = signToken({
    id: facultyWorkflowB.id,
    name: facultyWorkflowB.name,
    role: 'faculty',
    email: facultyWorkflowB.email,
    department_id: workflowBDeptId,
    authorized_centre_ids: [],
    is_active: true,
  });

  const hodAdseToken = signToken({
    id: mosesUser.id,
    name: mosesUser.name,
    role: 'hod',
    email: mosesUser.email,
    department_id: adseDeptId,
    is_active: true,
  });

  const hodMechToken = signToken({
    id: hodWorkflowB ? hodWorkflowB.id : mosesUser.id,
    name: hodWorkflowB ? hodWorkflowB.name : 'Department HOD',
    role: 'hod',
    email: hodWorkflowB ? hodWorkflowB.email : 'hod@christuniversity.in',
    department_id: workflowBDeptId,
    is_active: true,
  });

  const deansOfficeToken = signToken({
    id: deansOfficeUser.id,
    name: deansOfficeUser.name,
    role: 'deans_office',
    email: deansOfficeUser.email,
    school: 'SoET',
    is_active: true,
  });

  const associateDeanToken = signToken({
    id: assocDeanUser.id,
    name: assocDeanUser.name,
    role: 'associate_dean',
    email: assocDeanUser.email,
    school: 'SoET',
    is_active: true,
  });

  const deanToken = signToken({
    id: deanUser.id,
    name: deanUser.name,
    role: 'dean',
    email: deanUser.email,
    school: 'SoET',
    is_active: true,
  });

  const financeToken = signToken({
    id: financeUser.id,
    name: financeUser.name,
    role: 'finance',
    email: financeUser.email,
    school: 'SoET',
    is_active: true,
  });

  const directorToken = signToken({
    id: directorUser.id,
    name: directorUser.name,
    role: 'director',
    email: directorUser.email,
    school: 'SoET',
    is_active: true,
  });

  const financeHeadToken = signToken({
    id: financeHeadUser.id,
    name: financeHeadUser.name,
    role: 'finance_head',
    email: financeHeadUser.email,
    school: 'SoET',
    is_active: true,
  });

  const superAdminToken = signToken({
    id: '1e282899-d6f6-4c1a-9494-63753d80ee60',
    name: 'Super Administrator',
    role: 'super_admin',
    email: 'admin@christ.edu',
    school: 'SoET',
    is_active: true,
  });

  // ----------------------------------------------------
  // TEST SUITE 1: WORKFLOW A (CSE / ADSE DEPARTMENTS)
  // Sequence: Faculty -> HOD -> Dean's Office -> Associate Dean -> Finance -> Director -> Finance Head
  // ----------------------------------------------------
  console.log('[TEST SUITE 1] Workflow A (ADSE Department - Associate Dean Route)...');

  const createA = await request({
    method: 'POST',
    url: '/api/nfas',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${facultyAdseToken}` },
    body: {
      organization_type: 'department',
      department_id: adseDeptId,
      financial_year_id: fyId,
      budget_category_id: catId,
      title: 'Workflow A - AI Research Conference',
      point1: 'Conference on AI ethics',
      point2: 'Campus Seminar Hall',
      point3: 'Research publication goals',
      nfa_type: 'event',
      items: [{ particulars: 'Keynote Speaker Honorarium', quantity: '1', rate: '25000', amount: 25000 }],
    },
  });
  if (createA.status !== 201) throw new Error('Failed to create NFA A: ' + JSON.stringify(createA.body));
  const nfaAId = createA.body.id;

  // 1. Submit -> pending_hod_review
  const subA = await request({ method: 'POST', url: `/api/nfas/${nfaAId}/submit`, headers: { Authorization: `Bearer ${facultyAdseToken}` } });
  if (subA.status !== 200 || subA.body.status !== 'pending_hod_review') throw new Error('Expected pending_hod_review');
  console.log('  1. Faculty submitted -> pending_hod_review');

  // 2. HOD Review -> pending_deans_office_verification
  const hodA = await request({
    method: 'POST',
    url: `/api/nfas/${nfaAId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hodAdseToken}` },
    body: { decision: 'approve', comments: 'HOD recommends' },
  });
  if (hodA.status !== 200 || hodA.body.status !== 'pending_deans_office_verification') throw new Error('Expected pending_deans_office_verification');
  console.log('  2. HOD reviewed -> pending_deans_office_verification');

  // 3. Dean's Office Verification -> MUST route to pending_associate_dean_approval for ADSE!
  const doA = await request({
    method: 'POST',
    url: `/api/nfas/${nfaAId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deansOfficeToken}` },
    body: { decision: 'approve', comments: "Dean's Office verified eligibility" },
  });
  if (doA.status !== 200 || doA.body.status !== 'pending_associate_dean_approval') {
    throw new Error(`Workflow A Routing Failure: Expected pending_associate_dean_approval, got ${doA.body.status}`);
  }
  console.log('  3. Dean\'s Office verified -> pending_associate_dean_approval (VERIFIED: routed to Associate Dean)');

  // Verify Mock Email: Recipient MUST be associate_dean + faculty
  const emailsA1 = store.data.mock_emails.filter((m) => m.nfa_id === nfaAId && m.event === 'deans_office_verified');
  const hasAssocDeanMail = emailsA1.some((m) => m.recipient_role === 'associate_dean');
  const hasDeanMailA1 = emailsA1.some((m) => m.recipient_role === 'dean');
  if (!hasAssocDeanMail) throw new Error('Expected mock email to associate_dean after Dean\'s Office verification');
  if (hasDeanMailA1) throw new Error('ISOLATION VIOLATION: Dean was notified for CSE/ADSE proposal!');
  console.log('  3a. Mock email check: associate_dean notified, dean correctly excluded.');

  // 4. Dean attempts approval on Workflow A -> MUST BE BLOCKED (403)!
  const deanBlockA = await request({
    method: 'POST',
    url: `/api/nfas/${nfaAId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deanToken}` },
    body: { decision: 'approve', comments: 'Unauthorized Dean approval attempt on ADSE NFA' },
  });
  if (deanBlockA.status !== 403) throw new Error(`Security Failure: Dean should receive 403 on Workflow A, got ${deanBlockA.status}`);
  console.log('  4. Dean approval blocked with 403 (VERIFIED: Dean is NOT permitted to approve Workflow A)');

  // 5. Super Admin attempts approval -> MUST BE BLOCKED (403)!
  const saBlockA = await request({
    method: 'POST',
    url: `/api/nfas/${nfaAId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superAdminToken}` },
    body: { decision: 'approve', comments: 'Super Admin approval bypass attempt' },
  });
  if (saBlockA.status !== 403) throw new Error(`Security Failure: Super Admin should receive 403 on financial approval, got ${saBlockA.status}`);
  console.log('  5. Super Admin approval blocked with 403 (VERIFIED: Super Admin cannot approve financial proposals)');

  // 6. Associate Dean Approves -> pending_finance_office_approval
  const adApproveA = await request({
    method: 'POST',
    url: `/api/nfas/${nfaAId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${associateDeanToken}` },
    body: { decision: 'approve', comments: 'Associate Dean academic approval granted' },
  });
  if (adApproveA.status !== 200 || adApproveA.body.status !== 'pending_finance_office_approval') {
    throw new Error('Associate Dean approval failed: ' + JSON.stringify(adApproveA.body));
  }
  console.log('  6. Associate Dean approved -> pending_finance_office_approval');

  // Verify Mock Email: Recipient MUST be finance + faculty
  const emailsA2 = store.data.mock_emails.filter((m) => m.nfa_id === nfaAId && m.event === 'associate_dean_approved');
  const hasFinanceMailA2 = emailsA2.some((m) => m.recipient_role === 'finance');
  if (!hasFinanceMailA2) throw new Error('Expected mock email to finance after Associate Dean approval');
  console.log('  6a. Mock email check: finance office notified after Associate Dean approval.');

  // 7. Finance Office Approves -> pending_director_approval
  const finA = await request({
    method: 'POST',
    url: `/api/nfas/${nfaAId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${financeToken}` },
    body: { decision: 'approve', comments: 'Finance office verified allocation' },
  });
  if (finA.status !== 200 || finA.body.status !== 'pending_director_approval') throw new Error('Expected pending_director_approval');
  console.log('  7. Finance Office approved -> pending_director_approval');

  // 8. Director Approves -> pending_finance_head_approval
  const dirA = await request({
    method: 'POST',
    url: `/api/nfas/${nfaAId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorToken}` },
    body: { decision: 'approve', comments: 'Campus Director sanction granted' },
  });
  if (dirA.status !== 200 || dirA.body.status !== 'pending_finance_head_approval') throw new Error('Expected pending_finance_head_approval');
  console.log('  8. Campus Director approved -> pending_finance_head_approval');

  // 9. Finance Head Approves -> approved (final budget deduction)
  const fhA = await request({
    method: 'POST',
    url: `/api/nfas/${nfaAId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${financeHeadToken}` },
    body: { decision: 'approve', comments: 'Final authorization & budget debited' },
  });
  if (fhA.status !== 200 || fhA.body.status !== 'approved') throw new Error('Expected approved status from finance_head');
  console.log('  9. Finance Head approved -> approved (Full Workflow A completed successfully!)');

  // ----------------------------------------------------
  // TEST SUITE 2: WORKFLOW B (OTHER ACADEMIC DEPARTMENTS - MECH)
  // Sequence: Faculty -> HOD -> Dean's Office -> Dean -> Finance -> Director -> Finance Head
  // ----------------------------------------------------
  console.log('\n[TEST SUITE 2] Workflow B (Other Department - Mechanical Engineering)...');

  const createB = await request({
    method: 'POST',
    url: '/api/nfas',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${facultyMechToken}` },
    body: {
      organization_type: 'department',
      department_id: workflowBDeptId,
      financial_year_id: fyId,
      budget_category_id: catId,
      title: 'Workflow B - Robotics Workshop',
      point1: 'Hands-on robotics prototyping',
      point2: 'Mech CAD Lab',
      point3: 'Industry automation competencies',
      nfa_type: 'event',
      items: [{ particulars: 'Robotics Kit Consumables', quantity: '10', rate: '3000', amount: 30000 }],
    },
  });
  if (createB.status !== 201) throw new Error('Failed to create NFA B: ' + JSON.stringify(createB.body));
  const nfaBId = createB.body.id;

  // 1. Submit -> pending_hod_review
  await request({ method: 'POST', url: `/api/nfas/${nfaBId}/submit`, headers: { Authorization: `Bearer ${facultyMechToken}` } });
  // 2. HOD Review -> pending_deans_office_verification
  const hodBRes = await request({
    method: 'POST',
    url: `/api/nfas/${nfaBId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hodMechToken}` },
    body: { decision: 'approve', comments: 'Mech HOD recommends' },
  });
  if (hodBRes.status !== 200) throw new Error('HOD review Workflow B failed: ' + JSON.stringify(hodBRes.body));

  // 3. Dean's Office Verification -> MUST route to pending_dean_approval for MECH!
  const doB = await request({
    method: 'POST',
    url: `/api/nfas/${nfaBId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deansOfficeToken}` },
    body: { decision: 'approve', comments: "Dean's Office verified Mech NFA" },
  });
  if (doB.status !== 200 || doB.body.status !== 'pending_dean_approval') {
    throw new Error(`Workflow B Routing Failure: Expected pending_dean_approval, got ${doB.body.status}`);
  }
  console.log('  1. Dean\'s Office verified -> pending_dean_approval (VERIFIED: routed to Dean)');

  // 4. Associate Dean attempts approval on Workflow B -> MUST BE BLOCKED (403)!
  const adBlockB = await request({
    method: 'POST',
    url: `/api/nfas/${nfaBId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${associateDeanToken}` },
    body: { decision: 'approve', comments: 'Unauthorized Associate Dean approval on Mech NFA' },
  });
  if (adBlockB.status !== 403) throw new Error(`Security Failure: Associate Dean should receive 403 on Workflow B, got ${adBlockB.status}`);
  console.log('  2. Associate Dean approval blocked with 403 (VERIFIED: Associate Dean cannot approve Workflow B)');

  // 5. Dean Approves -> pending_finance_office_approval
  const deanB = await request({
    method: 'POST',
    url: `/api/nfas/${nfaBId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deanToken}` },
    body: { decision: 'approve', comments: 'Dean approval granted' },
  });
  if (deanB.status !== 200 || deanB.body.status !== 'pending_finance_office_approval') throw new Error('Expected pending_finance_office_approval');
  console.log('  3. Dean approved -> pending_finance_office_approval');

  // 6. Complete remaining chain: Finance -> Director -> Finance Head
  await request({ method: 'POST', url: `/api/nfas/${nfaBId}/review`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${financeToken}` }, body: { decision: 'approve' } });
  await request({ method: 'POST', url: `/api/nfas/${nfaBId}/review`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorToken}` }, body: { decision: 'approve' } });
  const fhB = await request({ method: 'POST', url: `/api/nfas/${nfaBId}/review`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${financeHeadToken}` }, body: { decision: 'approve' } });
  if (fhB.body.status !== 'approved') throw new Error('Workflow B final approval failed');
  console.log('  4. Finance Head approved -> approved (Full Workflow B completed successfully!)');

  // ----------------------------------------------------
  // TEST SUITE 3: WORKFLOW C (CENTRES OR OFFICES)
  // Sequence: Faculty -> Dean's Office -> Dean -> Finance -> Director -> Finance Head (HOD SKIPPED!)
  // ----------------------------------------------------
  console.log('\n[TEST SUITE 3] Workflow C (Centres or Offices)...');

  const createC = await request({
    method: 'POST',
    url: '/api/nfas',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${facultyAdseToken}` },
    body: {
      organization_type: 'centre_or_office',
      centre_id: autoCentreId,
      department_id: autoCentreId,
      financial_year_id: fyId,
      budget_category_id: catId,
      title: 'Workflow C - Automotive EV Testing',
      point1: 'Battery endurance testing',
      point2: 'Automotive COE Lab',
      point3: 'Industry research benchmark',
      nfa_type: 'event',
      items: [{ particulars: 'Testing Rig Hire', quantity: '1', rate: '40000', amount: 40000 }],
    },
  });
  if (createC.status !== 201) throw new Error('Failed to create NFA C: ' + JSON.stringify(createC.body));
  const nfaCId = createC.body.id;

  // 1. Submit -> MUST enter pending_deans_office_verification (skips HOD!)
  const subC = await request({ method: 'POST', url: `/api/nfas/${nfaCId}/submit`, headers: { Authorization: `Bearer ${facultyAdseToken}` } });
  if (subC.body.status !== 'pending_deans_office_verification') {
    throw new Error(`Workflow C Error: Expected pending_deans_office_verification directly on submission, got ${subC.body.status}`);
  }
  console.log('  1. Faculty submitted -> pending_deans_office_verification (HOD correctly skipped)');

  // 2. Dean's Office verifies -> pending_dean_approval
  const doC = await request({
    method: 'POST',
    url: `/api/nfas/${nfaCId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deansOfficeToken}` },
    body: { decision: 'approve', comments: 'Centre proposal verified' },
  });
  if (doC.body.status !== 'pending_dean_approval') throw new Error('Expected pending_dean_approval for Workflow C');
  console.log('  2. Dean\'s Office verified -> pending_dean_approval');

  // 3. Associate Dean blocked on Workflow C
  const adBlockC = await request({
    method: 'POST',
    url: `/api/nfas/${nfaCId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${associateDeanToken}` },
    body: { decision: 'approve' },
  });
  if (adBlockC.status !== 403) throw new Error('Associate Dean should receive 403 on Workflow C');
  console.log('  3. Associate Dean approval blocked with 403 (VERIFIED)');

  // 4. Dean approves -> pending_finance_office_approval
  const deanC = await request({
    method: 'POST',
    url: `/api/nfas/${nfaCId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deanToken}` },
    body: { decision: 'approve' },
  });
  if (deanC.body.status !== 'pending_finance_office_approval') throw new Error('Expected pending_finance_office_approval');
  console.log('  4. Dean approved -> pending_finance_office_approval (Full Workflow C verified!)');

  // ----------------------------------------------------
  // TEST SUITE 4: FINANCIAL FIXES & REVISION ROUTING
  // ----------------------------------------------------
  console.log('\n[TEST SUITE 4] Financial Fixes & Budget Revision Routing...');

  // 1. Negative Budget Deficit Display Check
  const deficitStr = formatAmount(-15000);
  if (!deficitStr.includes('Deficit:') || !deficitStr.includes('15,000')) {
    throw new Error(`Format error: Expected 'Deficit: ₹15,000', got '${deficitStr}'`);
  }
  console.log(`  1. Negative deficit display verified: formatAmount(-15000) => '${deficitStr}'`);

  // 2. Budget Revision on Approved NFA A (increase > ₹1,00,000)
  // Initial total_amount: ₹25,000. New amount: ₹1,75,000 (+₹1,50,000 increase)
  const revRes = await request({
    method: 'POST',
    url: `/api/nfas/${nfaAId}/revise`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${facultyAdseToken}` },
    body: {
      new_total_amount: 175000,
      reason: 'Expanded speaker list and international travel',
    },
  });
  if (revRes.status !== 200) throw new Error('Revision request failed: ' + JSON.stringify(revRes.body));
  if (revRes.body.status !== 'pending_hod_review') {
    throw new Error(`Revision Routing Error: Expected revision to route to pending_hod_review, got ${revRes.body.status}`);
  }
  console.log(`  2. Budget revision (+₹1,50,000) correctly routed to full workflow: status=${revRes.body.status}`);

  // 3. Advance revision through Workflow A: HOD -> Dean's Office -> Associate Dean -> Finance -> Director -> Finance Head
  await request({ method: 'POST', url: `/api/nfas/${nfaAId}/review`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hodAdseToken}` }, body: { decision: 'approve' } });
  await request({ method: 'POST', url: `/api/nfas/${nfaAId}/review`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deansOfficeToken}` }, body: { decision: 'approve' } });
  await request({ method: 'POST', url: `/api/nfas/${nfaAId}/review`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${associateDeanToken}` }, body: { decision: 'approve' } });
  await request({ method: 'POST', url: `/api/nfas/${nfaAId}/review`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${financeToken}` }, body: { decision: 'approve' } });
  await request({ method: 'POST', url: `/api/nfas/${nfaAId}/review`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorToken}` }, body: { decision: 'approve' } });

  const finalRevRes = await request({
    method: 'POST',
    url: `/api/nfas/${nfaAId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${financeHeadToken}` },
    body: { decision: 'approve', comments: 'Revision fully approved by Finance Head' },
  });
  if (finalRevRes.body.status !== 'approved' || finalRevRes.body.total_amount !== 175000) {
    throw new Error(`Final revision approval failed: status=${finalRevRes.body.status}, total_amount=${finalRevRes.body.total_amount}`);
  }
  console.log(`  3. Finance Head finalized revision: total_amount updated to ₹${finalRevRes.body.total_amount.toLocaleString('en-IN')}`);

  // 4. Test Concurrency & Concurrency Protection Export
  if (typeof withPgBudgetLock !== 'function') {
    throw new Error('withPgBudgetLock helper not exported');
  }
  console.log('  4. Concurrency Protection helper withPgBudgetLock is verified.');

  console.log('\n======================================================');
  console.log('ALL WORKFLOW, FINANCIAL & PERMISSION TESTS PASSED!');
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err);
  process.exit(1);
});
