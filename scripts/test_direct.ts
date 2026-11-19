import http from 'http';
import { Socket } from 'net';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';

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

async function runRegressionTests() {
  console.log('\n--- STARTING IN-PROCESS COMPREHENSIVE REGRESSION SUITE ---\n');

  // 1. Authenticate Faculty
  const facAuthRes = await request({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'Content-Type': 'application/json' },
    body: { email: 'faculty@christ.edu', password: 'password123' }
  });
  console.log('[TEST 1] Faculty Login status:', facAuthRes.status, 'Authorized Centres:', facAuthRes.body?.user?.authorized_centre_ids);
  if (facAuthRes.status !== 200 || !facAuthRes.body?.token) {
    throw new Error('Failed to login faculty: ' + JSON.stringify(facAuthRes.body));
  }
  const facToken = facAuthRes.body.token;

  // 1b. Check /api/users/me
  const meRes = await request({
    method: 'GET',
    url: '/api/users/me',
    headers: { 'Authorization': `Bearer ${facToken}` }
  });
  console.log('[TEST 1b] /api/users/me department_id:', meRes.body?.department_id, 'authorized_centre_ids:', meRes.body?.authorized_centre_ids);
  if (meRes.body?.department_id !== '330ada81-5246-4c92-9ca2-688eae0f28d4') {
    throw new Error(`Expected ADSE department_id, got ${meRes.body?.department_id}`);
  }
  if (!Array.isArray(meRes.body?.authorized_centre_ids) || meRes.body?.authorized_centre_ids.length !== 2) {
    throw new Error(`Expected 2 authorized centres, got ${JSON.stringify(meRes.body?.authorized_centre_ids)}`);
  }
  console.log('  PASS: Faculty assigned department and authorized centres verified.');

  // 2. Scenario 1 & 2: Faculty selects Department
  const fyId = store.data.financial_years.find(f => f.is_active)!.id;
  const catId = '8a82532c-e7f4-457a-a8f7-9979f008c616';
  const cseId = 'b5643609-22d9-4b21-9ce0-2f6eb5b9d04e';
  const adseId = '330ada81-5246-4c92-9ca2-688eae0f28d4';

  const createDeptNfaRes = await request({
    method: 'POST',
    url: '/api/nfas',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${facToken}`
    },
    body: {
      organization_type: 'department',
      department_id: cseId, // Attempt to select CSE
      financial_year_id: fyId,
      budget_category_id: catId,
      title: 'Department Test NFA - AI Workshop',
      point1: 'Hands-on AI and Data Science workshop for undergrads',
      point2: 'Lab 401',
      point3: 'Industry certifications',
      items: [{ particulars: 'Speaker Honorarium', quantity: '1', rate: '25000', amount: 25000 }]
    }
  });
  const deptNfa = createDeptNfaRes.body;
  console.log('[TEST 2] Department NFA status:', createDeptNfaRes.status, 'department_id:', deptNfa?.department_id, 'org_type:', deptNfa?.organization_type);
  if (deptNfa?.department_id !== adseId) {
    throw new Error(`Security Violation: Expected faculty department ADSE (${adseId}), but got ${deptNfa?.department_id}`);
  }
  if (deptNfa?.organization_type !== 'department' || deptNfa?.workflow_type !== 'department') {
    throw new Error(`Expected organization_type and workflow_type = 'department'`);
  }
  console.log('  PASS: Scenario 1 & 2 verified: assigned department auto-enforced, faculty cannot divert to another department.');

  // 3. Scenario 3 & 5: Faculty selects authorized Centre (Automation)
  const autoId = '22222222-a111-4001-8001-000000000001';
  const createCentreNfaRes = await request({
    method: 'POST',
    url: '/api/nfas',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${facToken}`
    },
    body: {
      organization_type: 'centre_or_office',
      department_id: autoId,
      centre_id: autoId,
      financial_year_id: fyId,
      budget_category_id: catId,
      title: 'Centre Test NFA - Automation Lab Equipment',
      point1: 'Procurement of robotics actuators for COE Automation',
      point2: 'Automation Lab Block',
      point3: 'Robotics curriculum',
      items: [{ particulars: 'Actuator Kits', quantity: '2', rate: '15000', amount: 30000 }]
    }
  });
  const centreNfa = createCentreNfaRes.body;
  console.log('[TEST 3] Centre NFA status:', createCentreNfaRes.status, 'department_id:', centreNfa?.department_id, 'centre_id:', centreNfa?.centre_id, 'org_type:', centreNfa?.organization_type);
  if (centreNfa?.department_id !== autoId || centreNfa?.centre_id !== autoId) {
    throw new Error(`Expected Centre ID ${autoId}`);
  }
  if (centreNfa?.organization_type !== 'centre_or_office' || centreNfa?.workflow_type !== 'centre_or_office') {
    throw new Error(`Expected organization_type and workflow_type = 'centre_or_office'`);
  }
  console.log('  PASS: Scenario 3 & 5 verified: Authorized Centre selected, Centre NFA created successfully.');

  // 4. Scenario 4: Unauthorized Centre cannot be selected
  const unauthorizedCentreId = '22222222-d666-4006-8006-000000000006'; // DTICI
  const unauthRes = await request({
    method: 'POST',
    url: '/api/nfas',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${facToken}`
    },
    body: {
      organization_type: 'centre_or_office',
      department_id: unauthorizedCentreId,
      centre_id: unauthorizedCentreId,
      financial_year_id: fyId,
      budget_category_id: catId,
      title: 'Tampering Attempt - Unauthorized DTICI',
      point1: 'Unauthorized attempt',
      items: [{ particulars: 'Item 1', quantity: '1', rate: '5000', amount: 5000 }]
    }
  });
  console.log('[TEST 4] Unauthorized Centre selection HTTP status:', unauthRes.status, 'Error:', unauthRes.body?.error);
  if (unauthRes.status !== 403) {
    throw new Error(`Security Violation: Expected 403 Forbidden for unauthorized Centre, but got ${unauthRes.status}`);
  }
  console.log('  PASS: Scenario 4 verified: Unauthorized Centre rejected with 403 Forbidden.');

  // 5. Scenario 6 & 7: Budgets remain separate and correct budget selected
  const adseBudgetRes = await request({
    method: 'GET',
    url: `/api/budgets/${adseId}/summary?fy=${fyId}`,
    headers: { 'Authorization': `Bearer ${facToken}` }
  });
  const autoBudgetRes = await request({
    method: 'GET',
    url: `/api/budgets/${autoId}/summary?fy=${fyId}`,
    headers: { 'Authorization': `Bearer ${facToken}` }
  });
  const adseLines = adseBudgetRes.body?.lines;
  const autoLines = autoBudgetRes.body?.lines;
  console.log('[TEST 5] ADSE categories count:', adseLines?.length, 'Automation categories count:', autoLines?.length);
  if (!Array.isArray(adseLines) || !Array.isArray(autoLines)) {
    throw new Error('Failed to retrieve budget summaries: ' + JSON.stringify(adseBudgetRes.body));
  }
  const adseRem = adseLines.find((s: any) => s.budget_category_id === catId);
  const autoRem = autoLines.find((s: any) => s.budget_category_id === catId);
  console.log(`  ADSE ${adseRem?.category_name} Allocated: ₹${adseRem?.allocated_amount}`);
  console.log(`  Auto ${autoRem?.category_name} Allocated: ₹${autoRem?.allocated_amount}`);
  if (!adseRem || !autoRem || adseRem.department_id === autoRem.department_id) {
    throw new Error('Department and Centre budgets are mixed or missing!');
  }
  console.log('  PASS: Scenario 6 & 7 verified: Department and Centre budgets are completely separate and correctly mapped.');

  // 6. Scenario 8: Both NFA types appear in Faculty Dashboard
  const facNfasRes = await request({
    method: 'GET',
    url: '/api/nfas',
    headers: { 'Authorization': `Bearer ${facToken}` }
  });
  const facNfas = facNfasRes.body;
  const hasDeptNfa = facNfas.some((n: any) => n.id === deptNfa.id && n.organization_type === 'department');
  const hasCentreNfa = facNfas.some((n: any) => n.id === centreNfa.id && n.organization_type === 'centre_or_office');
  console.log(`[TEST 6] Faculty dashboard total NFAs: ${facNfas.length}, has Dept NFA: ${hasDeptNfa}, has Centre NFA: ${hasCentreNfa}`);
  if (!hasDeptNfa || !hasCentreNfa) {
    throw new Error('Faculty dashboard failed to return both Department and Centre NFAs');
  }
  console.log('  PASS: Scenario 8 verified: Faculty sees their NFAs from both organizational types in the same dashboard.');

  // 7. Prevent changing organizational unit after submission (Requirement 6)
  const subRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfa.id}/submit`,
    headers: { 'Authorization': `Bearer ${facToken}` }
  });
  console.log('[TEST 7a] Submitted Dept NFA status:', subRes.status);
  const editPostSubmitRes = await request({
    method: 'PUT',
    url: `/api/nfas/${deptNfa.id}`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${facToken}`
    },
    body: {
      organization_type: 'centre_or_office',
      department_id: autoId
    }
  });
  console.log('[TEST 7b] Attempt to edit organization on submitted NFA status:', editPostSubmitRes.status, 'Error:', editPostSubmitRes.body?.msg || editPostSubmitRes.body?.error);
  if (editPostSubmitRes.status !== 400) {
    throw new Error(`Expected 400 rejection when attempting to change organizational unit after submission, got ${editPostSubmitRes.status}`);
  }
  console.log('  PASS: Changing organizational unit after submission blocked successfully.');

  // 8. Scenario 10: Existing approval workflow functioning (HOD review -> Dean review)
  const hodAuthRes = await request({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'Content-Type': 'application/json' },
    body: { email: 'hod@christ.edu', password: 'password123' }
  });
  const hodToken = hodAuthRes.body?.token;

  const hodReviewRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfa.id}/review`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hodToken}`
    },
    body: {
      decision: 'approve',
      comments: 'Recommended to Dean for kind endorsement'
    }
  });
  console.log('[TEST 8] HOD review status:', hodReviewRes.status, 'NFA status:', hodReviewRes.body?.status);
  if (hodReviewRes.body?.status !== 'pending_deans_office_verification') {
    throw new Error(`Expected status 'pending_deans_office_verification', got ${hodReviewRes.body?.status}`);
  }
  console.log('  PASS: Scenario 10 verified: Department workflow advances to Dean\'s Office verification seamlessly.');

  // 9. Admin management of authorized centres
  const adminToken = signToken({
    id: '1e282899-d6f6-4c1a-9494-63753d80ee60',
    role: 'super_admin',
    name: 'Super Admin',
    email: 'admin@christ.edu',
    is_active: true,
  });

  const fmrId = '22222222-f333-4003-8003-000000000003';
  const adminUpdateUserRes = await request({
    method: 'PUT',
    url: '/api/admin/users/05fee8aa-7cd5-4168-bc21-3b20ea533f62',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: {
      authorized_centre_ids: [autoId, fmrId]
    }
  });
  console.log('[TEST 9] Super Admin updated user centres:', adminUpdateUserRes.body?.user?.authorized_centre_ids);
  if (!adminUpdateUserRes.body?.user?.authorized_centre_ids?.includes(fmrId)) {
    throw new Error('Super Admin failed to update authorized centres');
  }
  console.log('  PASS: Super Admin management of faculty assignments verified.');

  // Clean up test NFAs from db so test is side-effect free
  await store.transact((db) => {
    db.nfas = db.nfas.filter(n => n.id !== deptNfa.id && n.id !== centreNfa.id);
    db.nfa_items = db.nfa_items.filter(i => i.nfa_id !== deptNfa.id && i.nfa_id !== centreNfa.id);
    db.approvals = db.approvals.filter(a => a.nfa_id !== deptNfa.id && a.nfa_id !== centreNfa.id);
    const f = db.users.find(u => u.email === 'faculty@christ.edu');
    if (f) {
      f.authorized_centre_ids = [
        '22222222-a111-4001-8001-000000000001',
        '22222222-e222-4002-8002-000000000002'
      ];
    }
  });

  console.log('\n======================================================');
  console.log('🎉 ALL 10/10 SCENARIOS VERIFIED AND FULLY PASSING! 🎉');
  console.log('======================================================\n');
}

runRegressionTests().catch((err) => {
  console.error('\n❌ REGRESSION TEST FAILED:', err);
  process.exit(1);
});
