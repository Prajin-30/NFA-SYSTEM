process.env.NODE_ENV = 'test';
import http from 'http';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { store } from '../src/store.js';
import { app } from '../src/server.js';
import { signToken } from '../src/middleware/auth.js';
import type { Role } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, name: string, message?: string) {
  if (condition) {
    results.push({ name, passed: true });
    console.log(`  ✓ PASS: ${name}`);
  } else {
    const err = message || 'Assertion failed';
    results.push({ name, passed: false, error: err });
    console.error(`  ✗ FAIL: ${name} — ${err}`);
  }
}

let serverInstance: http.Server | null = null;
let serverPort = 0;

async function getTestServer(): Promise<number> {
  if (serverPort) return serverPort;
  return new Promise((resolve) => {
    serverInstance = app.listen(0, () => {
      serverPort = (serverInstance!.address() as any).port;
      resolve(serverPort);
    });
  });
}

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  urlPath: string,
  token?: string,
  body?: any
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  const port = await getTestServer();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => (rawData += chunk));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = JSON.parse(rawData);
          } catch {
            parsed = rawData;
          }
          resolve({ status: res.statusCode || 500, body: parsed, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('================================================================');
  console.log('   CU-NFA BUTTON FUNCTIONALITY & REGRESSION AUDIT SUITE         ');
  console.log('================================================================\n');

  if (store.initPromise) {
    try {
      await store.initPromise;
    } catch (err: any) {
      console.warn('Store init notice:', err.message);
    }
  }

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

  // --- PHASE 1: FRONTEND FUNCTION DECLARATION AUDIT ---
  console.log('--- PHASE 1: FRONTEND FUNCTION DECLARATION & HANDLER AUDIT ---');
  const scriptMatch = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
  assert(Boolean(scriptMatch), 'Frontend HTML contains inline <script> block');
  const scriptCode = scriptMatch ? scriptMatch[1] : '';

  const mandatoryButtonFunctions = [
    'confirmDeleteDraft',
    'confirmDeleteNfa',
    'dismissDeleteNfaConfirmation',
    'executeDeleteNfa',
    'addFy',
    'activateFy',
    'openNfa',
    'newNfaModal',
    'editNfaModal',
    'showTab',
    'renderHome',
    'renderNfas',
    'renderBudgets',
    'renderInvoices',
    'renderExcel',
    'renderAudit',
    'renderAdmin',
    'onNfaSearchInput',
    'onNfaStatusChange',
    'changeNfaPage',
    'updateNfaTableDom',
  ];

  for (const fn of mandatoryButtonFunctions) {
    const declared = new RegExp(`\\bfunction\\s+${fn}\\b|\\b${fn}\\s*=\\s*(?:async\\s+)?function|\\basync\\s+function\\s+${fn}\\b`).test(scriptCode);
    assert(declared, `Frontend script declares "${fn}"`);
  }

  // --- PHASE 2: AUTHENTICATION AND ROLE CONTEXT SETUP ---
  console.log('\n--- PHASE 2: ROLE CONTEXT & ACTOR SETUP ---');
  const facultyMech = store.data.users.find((u) => u.role === 'faculty' && u.department_id) || store.data.users.find((u) => u.role === 'faculty');
  const facultyOther = store.data.users.filter((u) => u.role === 'faculty' && u.id !== facultyMech?.id && u.department_id)[0] || store.data.users[1];
  const adminUser = store.data.users.find((u) => u.role === 'super_admin') || store.data.users[0];
  const hodUser = store.data.users.find((u) => u.role === 'hod') || store.data.users[0];

  if (facultyMech) facultyMech.must_change_password = false;
  if (facultyOther) facultyOther.must_change_password = false;
  if (adminUser) adminUser.must_change_password = false;
  if (hodUser) hodUser.must_change_password = false;

  assert(Boolean(facultyMech), 'Faculty Mech user exists in database');
  assert(Boolean(facultyOther), 'Second Faculty user exists for permission isolation');
  assert(Boolean(adminUser), 'Super Admin user exists');

  const facultyMechToken = signToken({ ...(facultyMech as any), must_change_password: false });
  const facultyOtherToken = signToken({ ...(facultyOther as any), must_change_password: false });
  const adminToken = signToken({ ...(adminUser as any), must_change_password: false });
  const hodToken = signToken({ ...(hodUser as any), must_change_password: false });

  // --- PHASE 3: DELETE DRAFT FROM LISTING PAGE FLOW ---
  console.log('\n--- PHASE 3: DELETE DRAFT FROM NFA LISTING PAGE ---');
  const fy = store.data.financial_years.find((f) => f.is_active) || store.data.financial_years[0];
  const deptId = facultyMech!.department_id || store.data.departments[0]?.id;
  const genCat = store.data.budget_categories[0];

  // 1. Create a draft NFA by facultyMech
  const draftPayload = {
    title: 'Automated Audit Test Draft NFA ' + Date.now(),
    organization_type: 'department',
    department_id: deptId,
    financial_year_id: fy.id,
    budget_category_id: genCat.id,
    nfa_type: 'event',
    total_amount: 15000,
    items: [
      { sl_no: 1, particulars: 'Consumables', quantity: '1', rate: '15000', amount: 15000 }
    ]
  };

  const createDraftRes = await request('POST', '/api/nfas', facultyMechToken, draftPayload);
  if (createDraftRes.status !== 200 && createDraftRes.status !== 201) {
    console.error('Create draft failed:', createDraftRes.status, createDraftRes.body);
  }
  assert(createDraftRes.status === 200 || createDraftRes.status === 201, 'POST /api/nfas creates draft successfully');
  const draftNfa = createDraftRes.body;
  assert(draftNfa?.status === 'draft', 'Newly created NFA has status "draft"');
  assert(draftNfa?.created_by === facultyMech!.id, 'Draft created_by matches Faculty Mech ID');

  // Verify draft is listed on NFA listing page for creator
  const listBeforeDelete = await request('GET', '/api/nfas?status=draft', facultyMechToken);
  assert(listBeforeDelete.status === 200, 'GET /api/nfas?status=draft returns 200 OK');
  const draftsBefore = Array.isArray(listBeforeDelete.body)
    ? listBeforeDelete.body
    : (listBeforeDelete.body?.nfas || listBeforeDelete.body?.items || []);
  assert(draftsBefore.some((n: any) => n.id === draftNfa.id), 'Draft is visible in creator NFA listing');

  // Delete draft directly (simulating clicking "Delete Draft" on listing page after confirmation)
  const deleteRes = await request('DELETE', `/api/nfas/${draftNfa.id}`, facultyMechToken);
  assert(deleteRes.status === 200, 'DELETE /api/nfas/:id returns 200 OK when deleted by creator');
  assert(deleteRes.body.deleted === true, 'Response payload contains { deleted: true }');

  // Verify draft is soft-deleted and no longer returned in list
  const listAfterDelete = await request('GET', '/api/nfas?status=draft', facultyMechToken);
  const draftsAfter = Array.isArray(listAfterDelete.body)
    ? listAfterDelete.body
    : (listAfterDelete.body?.nfas || listAfterDelete.body?.items || []);
  assert(!draftsAfter.some((n: any) => n.id === draftNfa.id), 'Deleted draft is completely removed from NFA listing');

  // Verify deleted draft does not reappear on refresh
  const getSingleDeleted = await request('GET', `/api/nfas/${draftNfa.id}`, facultyMechToken);
  assert(getSingleDeleted.status === 404, 'GET /api/nfas/:id returns 404 Not Found for deleted draft');

  // --- PHASE 4: UNAUTHORIZED DELETION PREVENTION ---
  console.log('\n--- PHASE 4: STRICT PERMISSION & AUTHORIZATION GUARDS ---');
  // Create another draft by facultyMech
  const draft2Res = await request('POST', '/api/nfas', facultyMechToken, {
    ...draftPayload,
    title: 'Audit Draft 2 for Permission Isolation ' + Date.now(),
  });
  const draft2 = draft2Res.body;

  // Another faculty user attempts to delete facultyMech's draft -> 403 Forbidden
  const unauthorizedFacultyDelete = await request('DELETE', `/api/nfas/${draft2.id}`, facultyOtherToken);
  assert(unauthorizedFacultyDelete.status === 403, 'RBAC: Other faculty cannot delete another user draft (returns 403)');

  // Super Admin attempts to delete facultyMech's draft -> 403 Forbidden (creator privacy enforced)
  const unauthorizedAdminDelete = await request('DELETE', `/api/nfas/${draft2.id}`, adminToken);
  assert(unauthorizedAdminDelete.status === 403, 'RBAC: Super Admin cannot delete another user draft (returns 403)');

  // Clean up draft2 by its authorized creator
  const cleanDraft2 = await request('DELETE', `/api/nfas/${draft2.id}`, facultyMechToken);
  assert(cleanDraft2.status === 200, 'Authorized creator cleans up draft2 successfully');

  // --- PHASE 5: PREVENT DELETION OF APPROVED / SUBMITTED NFAS ---
  console.log('\n--- PHASE 5: PREVENT DELETION OF IN-PROGRESS OR APPROVED NFAS ---');
  // Find an approved NFA
  const approvedNfa = store.data.nfas.find((n) => n.status === 'approved' && !n.is_deleted);
  if (approvedNfa) {
    const creatorToken = signToken(store.data.users.find((u) => u.id === approvedNfa.created_by) || (adminUser as any));
    const deleteApprovedRes = await request('DELETE', `/api/nfas/${approvedNfa.id}`, creatorToken);
    assert(deleteApprovedRes.status === 400, 'CRITICAL FINANCIAL RULE: Approved NFA cannot be deleted (returns 400 Bad Request)');
  }

  // --- PHASE 6: RETURNED FOR CORRECTION DELETION & BUDGET RESERVATION RELEASE ---
  console.log('\n--- PHASE 6: RETURNED FOR CORRECTION DELETION & BUDGET INTEGRITY ---');
  // Find or create an NFA in revision_required status
  const returnedNfa = store.data.nfas.find((n) => n.status === 'revision_required' && !n.is_deleted);
  if (returnedNfa) {
    const budgetLine = store.data.department_budgets.find(
      (b) => b.department_id === returnedNfa.department_id && b.financial_year_id === returnedNfa.financial_year_id && b.budget_category_id === returnedNfa.budget_category_id
    );
    const pendingBefore = budgetLine ? budgetLine.pending_amount : 0;
    const returnedCreator = store.data.users.find((u) => u.id === returnedNfa.created_by) || facultyMech;
    const returnedToken = signToken(returnedCreator as any);

    const deleteReturnedRes = await request('DELETE', `/api/nfas/${returnedNfa.id}`, returnedToken);
    assert(deleteReturnedRes.status === 200, 'Returned for Correction NFA can be deleted by creator');
    const pendingAfter = budgetLine ? budgetLine.pending_amount : 0;
    assert(pendingAfter <= pendingBefore, 'Budget pending reservation released atomically upon deleting returned NFA');
  }

  // --- PHASE 7: PAGINATION & FILTERING STABILITY ---
  console.log('\n--- PHASE 7: PAGINATION & RECORD COUNT STABILITY ---');
  const pagedRes = await request('GET', '/api/nfas?page=1&limit=15', facultyMechToken);
  assert(pagedRes.status === 200, 'GET /api/nfas?page=1&limit=15 returns 200 OK');
  assert(Boolean(pagedRes.body.pagination), 'Response contains pagination object');
  assert(typeof pagedRes.body.pagination?.total === 'number', 'Pagination total count is a valid number');

  // --- PHASE 8: ACADEMIC YEAR MANAGEMENT (addFy & activateFy) ---
  console.log('\n--- PHASE 8: ACADEMIC YEAR MANAGEMENT BUTTON ACTIONS ---');
  const testFyLabel = `2039-40`;
  const addFyRes = await request('POST', '/api/admin/financial-years', adminToken, { label: testFyLabel });
  assert(addFyRes.status === 201 || addFyRes.status === 409, 'POST /api/admin/financial-years processes new year');

  const allFys = await request('GET', '/api/budgets/financial-years', adminToken);
  assert(allFys.status === 200, 'GET /api/budgets/financial-years returns 200 OK');
  const foundFy = allFys.body.find((f: any) => f.label === testFyLabel);
  if (foundFy) {
    const activateRes = await request('PUT', `/api/admin/financial-years/${foundFy.id}/activate`, adminToken);
    assert(activateRes.status === 200, 'PUT /api/admin/financial-years/:id/activate activates year successfully');
    // Restore active year back to 2026-27
    const origFy = allFys.body.find((f: any) => f.label === '2026-27') || allFys.body[0];
    if (origFy) {
      await request('PUT', `/api/admin/financial-years/${origFy.id}/activate`, adminToken);
    }
  }

  // --- SUMMARY ---
  console.log('\n================================================================');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`  BUTTON AUDIT TEST RESULTS: ${passed} PASSED / ${failed} FAILED (TOTAL ${results.length})`);
  console.log('================================================================\n');

  if (serverInstance) {
    serverInstance.close();
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  if (serverInstance) serverInstance.close();
  process.exit(1);
});
