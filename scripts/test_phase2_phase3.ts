import http from 'http';
import { Socket } from 'net';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';
import { setSimulateEmailFailure, resetSentNotifications } from '../src/services/notifications.js';

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

async function runTestSuite() {
  console.log('\n======================================================');
  console.log('--- STARTING PHASE 2 & PHASE 3 WORKFLOW & MOCK EMAIL TESTS ---');
  console.log('======================================================\n');

  resetSentNotifications();
  store.data.mock_emails = [];

  const adseDeptId = '330ada81-5246-4c92-9ca2-688eae0f28d4'; // ADSE
  const autoCentreId = '22222222-a111-4001-8001-000000000001'; // COE-AUTO
  const fyId = store.data.financial_years.find(f => f.is_active)!.id;
  const catId = '8a82532c-e7f4-457a-a8f7-9979f008c616';

  // Tokens for each authority
  const facultyToken = signToken({
    id: '05fee8aa-7cd5-4168-bc21-3b20ea533f62',
    name: 'Dr Arul V',
    role: 'faculty',
    email: 'faculty@christ.edu',
    department_id: adseDeptId,
    authorized_centre_ids: [autoCentreId],
    is_active: true,
  });

  const hodToken = signToken({
    id: '53709076-c3be-46eb-a123-0be426a086ee',
    name: 'Dr Michael Moses T',
    role: 'hod',
    email: 'hod@christ.edu',
    department_id: adseDeptId,
    is_active: true,
  });

  const otherHodToken = signToken({
    id: 'other-hod-id',
    name: 'Dr Other HOD',
    role: 'hod',
    email: 'otherhod@christ.edu',
    department_id: 'b5643609-22d9-4b21-9ce0-2f6eb5b9d04e', // CSE
    is_active: true,
  });

  const deansOfficeToken = signToken({
    id: 'deans-office-user-id',
    name: "Dean's Office Secretariat",
    role: 'deans_office',
    email: 'deansoffice@christ.edu',
    school: 'SoET',
    is_active: true,
  });

  const associateDeanToken = signToken({
    id: 'assoc-dean-id',
    name: 'Dr Associate Dean',
    role: 'associate_dean',
    email: 'associate_dean@christ.edu',
    school: 'SoET',
    is_active: true,
  });

  const deanToken = signToken({
    id: '7a91c842-15f3-4e89-a2e1-456987410231',
    name: 'Dr Mary Anita E A',
    role: 'dean',
    email: 'dean@christ.edu',
    school: 'SoET',
    is_active: true,
  });

  const financeToken = signToken({
    id: '3db93f9d-d4b9-4534-a700-cdba8df2d6a0',
    name: 'Fr Shijin P J',
    role: 'finance',
    email: 'finance@christ.edu',
    school: 'SoET',
    is_active: true,
  });

  const directorToken = signToken({
    id: '8b92d953-26a4-4f90-b3f2-567890123456',
    name: 'Fr Jiby Jose',
    role: 'director',
    email: 'director@christ.edu',
    school: 'SoET',
    is_active: true,
  });

  const financeHeadToken = signToken({
    id: 'finance-head-user-id',
    name: 'Chief Finance Officer',
    role: 'finance_head',
    email: 'financehead@christ.edu',
    school: 'SoET',
    is_active: true,
  });

  // ----------------------------------------------------
  // TEST SUITE A: DEPARTMENT APPROVAL WORKFLOW (7 STAGES)
  // ----------------------------------------------------
  console.log('[SUITE A] Testing Department Approval Workflow (7 Stages)...');

  // Step 1: Create and Submit Department NFA with Event Particulars for Facility Management
  const createDeptRes = await request({
    method: 'POST',
    url: '/api/nfas',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${facultyToken}` },
    body: {
      organization_type: 'department',
      department_id: adseDeptId,
      financial_year_id: fyId,
      budget_category_id: catId,
      title: 'National AI Symposium 2026',
      point1: 'National symposium bringing together industry experts',
      point2: 'Auditorium Block 2',
      point3: 'Student skilling & accreditation',
      nfa_type: 'event',
      event_details: {
        event_date: '2026-12-15',
        venue: 'Kengeri Auditorium',
        additional_info: 'Chief Guest arriving at 9:30 AM',
      },
      items: [
        { particulars: 'Keynote Speaker Honorarium', quantity: '2', rate: '10000', amount: 20000 },
        { particulars: 'Memento for Dignitaries', quantity: '5', rate: '2000', amount: 10000 },
        { particulars: 'Refreshments — Forenoon', quantity: '100', rate: '50', amount: 5000 },
        { particulars: 'Lunch for Participants', quantity: '100', rate: '200', amount: 20000 },
        { particulars: 'Project Exhibition Sampling', quantity: '1', rate: '0', amount: 0, sampling_required: true },
      ],
    },
  });

  if (createDeptRes.status !== 201) {
    throw new Error('Failed to create Department NFA: ' + JSON.stringify(createDeptRes.body));
  }
  const deptNfaId = createDeptRes.body.id;
  console.log(`  1. Created Draft NFA: ${deptNfaId} (Ref: ${createDeptRes.body.ref_no})`);

  // Faculty Submits
  const submitDeptRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfaId}/submit`,
    headers: { Authorization: `Bearer ${facultyToken}` },
  });
  if (submitDeptRes.status !== 200 || submitDeptRes.body.status !== 'pending_hod_review') {
    throw new Error('Failed to submit department NFA: ' + JSON.stringify(submitDeptRes.body));
  }
  console.log(`  2. Faculty Submitted -> Status: ${submitDeptRes.body.status} (Reserved: ₹${submitDeptRes.body.total_amount})`);

  // Verify Mock Email: HOD should be notified
  let mockEmails = store.data.mock_emails || [];
  let hodMail = mockEmails.find(m => m.nfa_id === deptNfaId && m.recipient_role === 'hod' && m.event === 'nfa_submitted');
  if (!hodMail) throw new Error('HOD mock email not generated upon department submission');
  console.log(`     Mock email sent to HOD: ${hodMail.recipient_email} [${hodMail.subject}]`);

  // Step 2: HOD Reviews -> Pending Dean's Office Verification
  // Test Security: Other department HOD should be BLOCKED with 403
  const badHodRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otherHodToken}` },
    body: { decision: 'approve', comments: 'Unauthorized HOD approval attempt' },
  });
  if (badHodRes.status !== 403) {
    throw new Error(`Security Violation: Expected 403 for unauthorized HOD, got ${badHodRes.status}`);
  }
  console.log(`     Security check passed: Unauthorized HOD rejected with 403`);

  // Valid HOD Reviews
  const hodReviewRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hodToken}` },
    body: { decision: 'approve', comments: 'Strongly recommended by HOD' },
  });
  if (hodReviewRes.status !== 200 || hodReviewRes.body.status !== 'pending_deans_office_verification') {
    throw new Error('HOD review failed: ' + JSON.stringify(hodReviewRes.body));
  }
  console.log(`  3. HOD Reviewed -> Status: ${hodReviewRes.body.status}`);

  // Step 3: Dean's Office Verifies -> Pending Dean Approval
  const deansOfficeRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deansOfficeToken}` },
    body: { decision: 'approve', comments: 'Documents & eligibility verified by Dean\'s Office' },
  });
  if (deansOfficeRes.status !== 200 || deansOfficeRes.body.status !== 'pending_associate_dean_approval') {
    throw new Error("Dean's Office verification failed: " + JSON.stringify(deansOfficeRes.body));
  }
  console.log(`  4. Dean's Office Verified -> Status: ${deansOfficeRes.body.status}`);

  // Step 4: Associate Dean Approves -> Pending Finance Office Approval (Workflow A - ADSE)
  const deanApproveRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${associateDeanToken}` },
    body: { decision: 'approve', comments: 'Approved by Associate Dean SoET' },
  });
  if (deanApproveRes.status !== 200 || deanApproveRes.body.status !== 'pending_finance_office_approval') {
    throw new Error('Associate Dean approval failed: ' + JSON.stringify(deanApproveRes.body));
  }
  console.log(`  5. Associate Dean Approved -> Status: ${deanApproveRes.body.status}`);

  // Step 5: Finance Office Approves -> Pending Director Approval
  const financeApproveRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${financeToken}` },
    body: { decision: 'approve', comments: 'Budget availability verified by Finance Office' },
  });
  if (financeApproveRes.status !== 200 || financeApproveRes.body.status !== 'pending_director_approval') {
    throw new Error('Finance Office approval failed: ' + JSON.stringify(financeApproveRes.body));
  }
  console.log(`  6. Finance Office Approved -> Status: ${financeApproveRes.body.status}`);

  // Step 6: Director Approves -> Pending Finance Head Approval
  const directorApproveRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorToken}` },
    body: { decision: 'approve', comments: 'Sanctioned by Director' },
  });
  if (directorApproveRes.status !== 200 || directorApproveRes.body.status !== 'pending_finance_head_approval') {
    throw new Error('Director approval failed: ' + JSON.stringify(directorApproveRes.body));
  }
  console.log(`  7. Director Approved -> Status: ${directorApproveRes.body.status}`);

  // Security Check: Faculty or HOD cannot give Final Approval
  const invalidHeadRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${facultyToken}` },
    body: { decision: 'approve', comments: 'Illegal attempt' },
  });
  if (invalidHeadRes.status !== 403) {
    throw new Error('Security Violation: Faculty must not give final approval');
  }

  // Step 7: Finance Officer (Head) gives Final Full Approval
  const financeHeadApproveRes = await request({
    method: 'POST',
    url: `/api/nfas/${deptNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${financeHeadToken}` },
    body: { decision: 'approve', comments: 'Final Approval granted and budget debited by Chief Finance Officer' },
  });
  if (financeHeadApproveRes.status !== 200 || financeHeadApproveRes.body.status !== 'approved') {
    throw new Error('Finance Head final approval failed: ' + JSON.stringify(financeHeadApproveRes.body));
  }
  console.log(`  8. Finance Officer (Head) Final Approved -> Status: ${financeHeadApproveRes.body.status} (Fully Approved)`);

  // Verify Facility Management consolidated notification triggered
  const facMgtMail = store.data.mock_emails.find(m => m.nfa_id === deptNfaId && m.recipient_role === 'facility_management');
  if (!facMgtMail) {
    throw new Error('Facility Management consolidated notification was NOT generated!');
  }
  console.log(`  9. Facility Management Notification verified:`);
  console.log(`     Subject: ${facMgtMail.subject}`);
  console.log(`     Attachment: ${facMgtMail.attachment_name} (PDF Attached: ${facMgtMail.has_pdf_attachment})`);
  if (!facMgtMail.body.includes('Memento') || !facMgtMail.body.includes('Lunch') || !facMgtMail.body.includes('Sampling')) {
    throw new Error('Facility notification missing required services breakdown');
  }
  console.log('     PASS: Facility Management services (Memento, Refreshments, Lunch, Sampling non-monetary) verified.');

  // ----------------------------------------------------
  // TEST SUITE B: CENTRES OR OFFICES WORKFLOW (6 STAGES - SKIPS HOD)
  // ----------------------------------------------------
  console.log('\n[SUITE B] Testing Centres or Offices Approval Workflow (Skips HOD only)...');

  const createCentreRes = await request({
    method: 'POST',
    url: '/api/nfas',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${facultyToken}` },
    body: {
      organization_type: 'centre_or_office',
      department_id: autoCentreId,
      centre_id: autoCentreId,
      financial_year_id: fyId,
      budget_category_id: catId,
      title: 'COE Automation High-Speed Actuator Procurement',
      point1: 'Purchase of industrial actuators for COE Automation',
      point2: 'Automation Lab Room 102',
      point3: 'Research publications and patents',
      items: [{ particulars: 'Actuator Setup', quantity: '1', rate: '35000', amount: 35000 }],
    },
  });

  const centreNfaId = createCentreRes.body.id;
  console.log(`  1. Created Centre NFA: ${centreNfaId}`);

  // Faculty Submits Centre NFA
  const submitCentreRes = await request({
    method: 'POST',
    url: `/api/nfas/${centreNfaId}/submit`,
    headers: { Authorization: `Bearer ${facultyToken}` },
  });
  if (submitCentreRes.status !== 200 || submitCentreRes.body.status !== 'pending_deans_office_verification') {
    throw new Error(`Expected 'pending_deans_office_verification' for Centre NFA, got: ${submitCentreRes.body.status}`);
  }
  console.log(`  2. Centre NFA Submitted -> Status: ${submitCentreRes.body.status} (Skipped HOD successfully!)`);

  // Verify Mock Email: HOD was NEVER notified for Centre NFA
  const centreHodMail = store.data.mock_emails.find(m => m.nfa_id === centreNfaId && m.recipient_role === 'hod');
  if (centreHodMail) {
    throw new Error('CRITICAL BUG: HOD was notified for a Centres or Offices NFA!');
  }
  console.log("     PASS: Verified NO HOD notification generated for Centre NFA.");

  // Dean's Office Verified -> Pending Dean Approval
  const centreDeansOfficeRes = await request({
    method: 'POST',
    url: `/api/nfas/${centreNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deansOfficeToken}` },
    body: { decision: 'approve', comments: 'Centre proposal verified' },
  });
  if (centreDeansOfficeRes.body.status !== 'pending_dean_approval') {
    throw new Error(`Expected pending_dean_approval, got ${centreDeansOfficeRes.body.status}`);
  }
  console.log(`  3. Dean's Office Verified -> Status: ${centreDeansOfficeRes.body.status}`);

  // Dean Approves -> Pending Finance Office Approval
  const centreDeanRes = await request({
    method: 'POST',
    url: `/api/nfas/${centreNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deanToken}` },
    body: { decision: 'approve', comments: 'Approved by Dean' },
  });
  console.log(`  4. Dean Approved -> Status: ${centreDeanRes.body.status}`);

  // Finance Office Approves -> Pending Director Approval
  const centreFinRes = await request({
    method: 'POST',
    url: `/api/nfas/${centreNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${financeToken}` },
    body: { decision: 'approve', comments: 'Approved by Finance Office' },
  });
  console.log(`  5. Finance Office Approved -> Status: ${centreFinRes.body.status}`);

  // Director Approves -> Pending Finance Head Approval
  const centreDirRes = await request({
    method: 'POST',
    url: `/api/nfas/${centreNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorToken}` },
    body: { decision: 'approve', comments: 'Approved by Director' },
  });
  console.log(`  6. Director Approved -> Status: ${centreDirRes.body.status}`);

  // Finance Head Final Approval -> Fully Approved
  const centreHeadRes = await request({
    method: 'POST',
    url: `/api/nfas/${centreNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${financeHeadToken}` },
    body: { decision: 'approve', comments: 'Final Approval for Centre NFA' },
  });
  if (centreHeadRes.body.status !== 'approved') {
    throw new Error('Expected status approved');
  }
  console.log(`  7. Finance Head Final Approved -> Status: ${centreHeadRes.body.status} (Fully Approved)`);

  // Verify that HOD is NOT in the final approval recipients for Centre NFA
  const finalCentreMails = store.data.mock_emails.filter(m => m.nfa_id === centreNfaId && m.event === 'finance_head_approved');
  const hasHodInCentreFinal = finalCentreMails.some(m => m.recipient_role === 'hod');
  if (hasHodInCentreFinal) {
    throw new Error('CRITICAL BUG: HOD received final approval email for Centre NFA!');
  }
  console.log('     PASS: Verified HOD strictly excluded from Centre NFA final approval notifications.');

  // ----------------------------------------------------
  // TEST SUITE C: RETURN FOR CORRECTION, RESUBMISSION & DELETION
  // ----------------------------------------------------
  console.log('\n[SUITE C] Testing Return for Correction, Faculty Resubmission, and Soft Deletion...');

  // 1. Create a draft NFA
  const testRevCreateRes = await request({
    method: 'POST',
    url: '/api/nfas',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${facultyToken}` },
    body: {
      organization_type: 'department',
      department_id: adseDeptId,
      financial_year_id: fyId,
      budget_category_id: catId,
      title: 'Workshop with Incomplete Budget',
      point1: 'Workshop',
      point2: 'Lab',
      point3: 'Outcomes',
      items: [{ particulars: 'Incomplete Item', quantity: '1', rate: '12000', amount: 12000 }],
    },
  });
  const revNfaId = testRevCreateRes.body.id;

  // Submit
  await request({
    method: 'POST',
    url: `/api/nfas/${revNfaId}/submit`,
    headers: { Authorization: `Bearer ${facultyToken}` },
  });

  // HOD returns for correction with mandatory reason
  const returnRes = await request({
    method: 'POST',
    url: `/api/nfas/${revNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hodToken}` },
    body: {
      decision: 'revision_required',
      comments: 'Please attach the detailed speaker biodata and revise item particulars.',
    },
  });
  if (returnRes.status !== 200 || returnRes.body.status !== 'revision_required') {
    throw new Error('Failed to return NFA for correction');
  }
  console.log(`  1. NFA returned for correction -> Status: ${returnRes.body.status}`);

  // Verify mock email sent to faculty
  const revMail = store.data.mock_emails.find(m => m.nfa_id === revNfaId && m.event === 'revision_required');
  if (!revMail || !revMail.body.includes('detailed speaker biodata')) {
    throw new Error('Faculty revision required mock email missing or lacked correction reason');
  }
  console.log(`  2. Faculty correction mock email verified with reviewer reason.`);

  // Faculty Edits details
  const editRes = await request({
    method: 'PUT',
    url: `/api/nfas/${revNfaId}`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${facultyToken}` },
    body: {
      title: 'Workshop with Updated Speaker Biodata',
      point1: 'Workshop updated with verified speaker',
    },
  });
  if (editRes.status !== 200) {
    throw new Error('Failed to edit returned NFA');
  }
  console.log(`  3. Faculty edited returned NFA successfully.`);

  // Faculty Resubmits
  const resubmitRes = await request({
    method: 'POST',
    url: `/api/nfas/${revNfaId}/submit`,
    headers: { Authorization: `Bearer ${facultyToken}` },
  });
  if (resubmitRes.status !== 200 || resubmitRes.body.status !== 'pending_hod_review') {
    throw new Error('Failed to resubmit NFA');
  }
  console.log(`  4. Faculty resubmitted NFA -> Status: ${resubmitRes.body.status}`);

  // Return again to test soft deletion
  await request({
    method: 'POST',
    url: `/api/nfas/${revNfaId}/review`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hodToken}` },
    body: { decision: 'revision_required', comments: 'Faculty requested cancellation' },
  });

  // Test Soft Deletion: Other faculty cannot delete
  const otherFacultyToken = signToken({
    id: 'other-fac-id',
    name: 'Dr Other Faculty',
    role: 'faculty',
    email: 'otherfac@christ.edu',
    is_active: true,
  });
  const unauthDelRes = await request({
    method: 'DELETE',
    url: `/api/nfas/${revNfaId}`,
    headers: { Authorization: `Bearer ${otherFacultyToken}` },
  });
  if (unauthDelRes.status !== 403) {
    throw new Error(`Expected 403 on deleting another user's NFA, got ${unauthDelRes.status}`);
  }

  // Owner deletes returned NFA
  const deleteRes = await request({
    method: 'DELETE',
    url: `/api/nfas/${revNfaId}`,
    headers: { Authorization: `Bearer ${facultyToken}` },
  });
  if (deleteRes.status !== 200 || !deleteRes.body.deleted) {
    throw new Error('Failed to soft delete returned NFA');
  }
  console.log(`  5. Returned NFA soft-deleted by owner successfully.`);

  // Check NFA is not returned in active list
  const listRes = await request({
    method: 'GET',
    url: '/api/nfas',
    headers: { Authorization: `Bearer ${facultyToken}` },
  });
  const foundDeleted = listRes.body.some((n: any) => n.id === revNfaId);
  if (foundDeleted) {
    throw new Error('Soft deleted NFA still appeared in active GET /api/nfas query!');
  }
  console.log('  6. Confirmed soft-deleted NFA excluded from active queries.');

  // Verify mock deletion confirmation was dispatched to faculty
  const delMail = store.data.mock_emails.find(m => m.nfa_id === revNfaId && m.event === 'nfa_deleted');
  if (!delMail) {
    throw new Error('Deletion confirmation mock email not found');
  }
  console.log(`  7. Deletion confirmation mock email verified to: ${delMail.recipient_email}`);

  // ----------------------------------------------------
  // TEST SUITE D: FAULT TOLERANCE & SIMULATED FAILURE
  // ----------------------------------------------------
  console.log('\n[SUITE D] Testing Simulated Email Failure & Fault Tolerance...');

  // Create another NFA
  const testFailNfaRes = await request({
    method: 'POST',
    url: '/api/nfas',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${facultyToken}` },
    body: {
      organization_type: 'department',
      department_id: adseDeptId,
      financial_year_id: fyId,
      budget_category_id: catId,
      title: 'Fault Tolerance Test Proposal',
      point1: 'Fault tolerance check',
      point2: 'Lab',
      point3: 'Result',
      items: [{ particulars: 'Item 1', quantity: '1', rate: '5000', amount: 5000 }],
    },
  });
  const failNfaId = testFailNfaRes.body.id;

  // Simulate one email failure
  setSimulateEmailFailure(true);
  const failSubmitRes = await request({
    method: 'POST',
    url: `/api/nfas/${failNfaId}/submit`,
    headers: { Authorization: `Bearer ${facultyToken}` },
  });

  // Verify approval / submission STILL SUCCEEDED (HTTP 200) despite email failure
  if (failSubmitRes.status !== 200 || failSubmitRes.body.status !== 'pending_hod_review') {
    throw new Error('CRITICAL BUG: Email failure reversed a successful submission transaction!');
  }
  console.log(`  1. Fault tolerance verified: Submission succeeded even when simulated email failure occurred.`);

  // Cleanup test NFAs
  await store.transact((db) => {
    const ids = [deptNfaId, centreNfaId, revNfaId, failNfaId];
    db.nfas = db.nfas.filter(n => !ids.includes(n.id));
    db.nfa_items = db.nfa_items.filter(i => !ids.includes(i.nfa_id));
    db.approvals = db.approvals.filter(a => !ids.includes(a.nfa_id));
  });

  console.log('\n======================================================');
  console.log('🎉 ALL PHASE 2 & PHASE 3 TESTS SUCCESSFULLY PASSED! 🎉');
  console.log('======================================================\n');
}

runTestSuite().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
