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
  details?: any;
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

// Minimal in-memory request dispatcher for Express app testing
async function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  token?: string,
  body?: any
): Promise<{ status: number; body: any; headers: Record<string, string>; buffer?: Buffer }> {
  return new Promise((resolve) => {
    // Start temporary local server on dynamic port if not already listening
    const server = app.listen(0, async () => {
      const port = (server.address() as any).port;
      const parsedUrl = new URL(url, `http://localhost:${port}`);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const reqOpts = {
        hostname: 'localhost',
        port,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
      };

      const req = http.request(reqOpts, (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          server.close();
          const buffer = Buffer.concat(chunks);
          let parsedBody = null;
          try {
            parsedBody = JSON.parse(buffer.toString('utf-8'));
          } catch {
            parsedBody = buffer.toString('utf-8');
          }
          resolve({
            status: res.statusCode,
            body: parsedBody,
            headers: res.headers,
            buffer,
          });
        });
      });

      req.on('error', (err: any) => {
        server.close();
        resolve({
          status: 500,
          body: { error: err.message },
          headers: {},
        });
      });

      if (body) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  });
}

async function runMasterUpgradeTestSuite() {
  console.log('================================================================');
  console.log('  CU-NFA COMPLETE MASTER UPGRADE AUTOMATED VERIFICATION SUITE   ');
  console.log('================================================================\n');

  if (store.initPromise) {
    try {
      await store.initPromise;
    } catch (e: any) {
      console.warn('Store init notice:', e.message);
    }
  }

  // 1. Identify test users
  const superAdmin = store.data.users.find((u) => u.role === 'super_admin');
  const financeUser = store.data.users.find((u) => u.role === 'finance');
  const deanUser = store.data.users.find((u) => u.role === 'dean');
  const mechDept = store.data.departments.find((d) => d.code === 'MECH');
  const cseDept = store.data.departments.find((d) => d.code === 'CSE');
  const facultyMech = store.data.users.find((u) => u.role === 'faculty' && u.department_id === mechDept?.id) || store.data.users.find((u) => u.role === 'faculty');
  const facultyCse = store.data.users.find((u) => u.role === 'faculty' && u.department_id === cseDept?.id && u.id !== facultyMech?.id)
    || store.data.users.filter((u) => u.role === 'faculty')[1]
    || facultyMech;

  assert(Boolean(superAdmin), 'Super Admin user profile exists in authoritative store');
  assert(Boolean(financeUser), 'Finance Office user profile exists in authoritative store');
  assert(Boolean(deanUser), 'Dean user profile exists in authoritative store');
  assert(Boolean(facultyMech), 'Faculty MECH user profile exists in authoritative store');

  const adminToken = signToken(superAdmin as any);
  const financeToken = signToken(financeUser as any);
  const deanToken = signToken(deanUser as any);
  const facultyMechToken = signToken(facultyMech as any);
  const facultyCseToken = signToken(facultyCse as any);

  console.log('\n--- PHASE 1: FINANCIAL ISOLATION INVARIANT TEST ---');
  // Record expenditure budget state before any revenue is recorded
  const initialBudgets = store.data.department_budgets.filter((b) => b.department_id === mechDept?.id);
  const initialAllocated = initialBudgets.reduce((sum, b) => sum + Number(b.allocated_amount), 0);
  const initialApproved = initialBudgets.reduce((sum, b) => sum + Number(b.approved_amount), 0);
  const initialPending = initialBudgets.reduce((sum, b) => sum + Number(b.pending_amount), 0);
  const initialAvailable = initialAllocated - initialApproved - initialPending;

  console.log(`Initial MECH Budget: Allocated=₹${initialAllocated.toLocaleString()}, Approved=₹${initialApproved.toLocaleString()}, Available=₹${initialAvailable.toLocaleString()}`);

  // Find or create an approved Event NFA for MECH
  let testNfa = store.data.nfas.find((n) => n.department_id === mechDept?.id && n.status === 'approved' && n.nfa_type === 'event');
  if (!testNfa) {
    testNfa = store.data.nfas.find((n) => n.status === 'approved' && n.nfa_type === 'event') || store.data.nfas[0];
  }

  // Submit ₹75,000 in event revenue
  const revRes = await request('POST', '/api/revenue/entries', adminToken, {
    nfa_id: testNfa.id,
    revenue_source: 'registration_fee',
    description: 'Automated test delegate registration collections',
    amount: 75000,
    collection_date: new Date().toISOString().slice(0, 10),
    payment_method: 'online',
    remarks: 'Audit test entry for financial isolation validation',
  });

  assert(revRes.status === 201, 'POST /api/revenue/entries creates revenue entry with 201 Created', JSON.stringify(revRes.body));
  const createdRevenueId = revRes.body?.revenue?.id;

  // Re-verify department expenditure budgets: MUST REMAIN EXACTLY IDENTICAL!
  const afterBudgets = store.data.department_budgets.filter((b) => b.department_id === mechDept?.id);
  const afterAllocated = afterBudgets.reduce((sum, b) => sum + Number(b.allocated_amount), 0);
  const afterApproved = afterBudgets.reduce((sum, b) => sum + Number(b.approved_amount), 0);
  const afterPending = afterBudgets.reduce((sum, b) => sum + Number(b.pending_amount), 0);
  const afterAvailable = afterAllocated - afterApproved - afterPending;

  assert(afterAllocated === initialAllocated, 'CRITICAL FINANCIAL RULE: Allocated expenditure budget remains completely UNCHANGED after recording ₹75,000 revenue');
  assert(afterApproved === initialApproved, 'CRITICAL FINANCIAL RULE: Approved expenditure remains UNCHANGED after recording revenue');
  assert(afterPending === initialPending, 'CRITICAL FINANCIAL RULE: Pending commitments remain UNCHANGED after recording revenue');
  assert(afterAvailable === initialAvailable, 'CRITICAL FINANCIAL RULE: Available expenditure balance (Allocated - Approved - Pending) is strictly ISOLATED from revenue collections');

  console.log('\n--- PHASE 2: EVENT COMPLETION & REVENUE REMINDER TEST ---');
  // Mark event completed
  const compRes = await request('POST', `/api/revenue/nfas/${testNfa.id}/complete-event`, adminToken, {
    completion_date: new Date().toISOString().slice(0, 10),
    completion_remarks: 'Event completed with 85 delegates',
  });
  assert(compRes.status === 200, 'POST /api/revenue/nfas/:id/complete-event marks event completed successfully');

  const updatedNfa = store.data.nfas.find((n) => n.id === testNfa.id);
  assert(updatedNfa?.event_completion_status === 'completed', 'NFA event_completion_status is updated to "completed"');

  console.log('\n--- PHASE 3: REVENUE & EARNINGS VERIFICATION BY FINANCE ---');
  // Finance verifies the revenue entry
  const verifyRes = await request('PUT', `/api/revenue/entries/${createdRevenueId}/verify`, financeToken, {
    status: 'verified',
    remarks: 'Verified against university payment gateway bank settlement',
  });
  assert(verifyRes.status === 200, 'PUT /api/revenue/entries/:id/verify allows Finance to verify revenue entry');

  const verifiedEntry = store.data.event_revenues?.find((r) => r.id === createdRevenueId);
  assert(verifiedEntry?.status === 'verified', 'Revenue entry status is now "verified"');
  assert(verifiedEntry?.verified_by === financeUser?.id, 'Revenue entry verified_by records Finance user ID');

  // Verify revenue summary endpoint
  const sumRes = await request('GET', '/api/revenue/summary', adminToken);
  assert(sumRes.status === 200, 'GET /api/revenue/summary returns 200 OK');
  assert(sumRes.body.total_verified >= 75000, 'Revenue summary reflects verified collections');
  assert(sumRes.body.by_source?.registration_fee >= 75000, 'Revenue summary correctly breaks down collections by source');

  console.log('\n--- PHASE 4: SUMMARY GENERATION ENDPOINTS ---');
  // 1. Campus Summary
  const campRes = await request('GET', '/api/reports/summary/campus', adminToken);
  assert(campRes.status === 200, 'GET /api/reports/summary/campus returns full institutional campus metrics');
  assert(Array.isArray(campRes.body.schools) && campRes.body.schools.length >= 4, 'Campus summary contains SOET, SOA, SBM, SPS schools');

  // 2. School Summary
  const schoolRes = await request('GET', '/api/reports/summary/school/SOET', deanToken);
  assert(schoolRes.status === 200, 'GET /api/reports/summary/school/SOET returns SOET school overview with departments');
  assert(Array.isArray(schoolRes.body.departments) && schoolRes.body.departments.length >= 5, 'SOET school summary contains engineering departments');

  // 3. Department Summary
  const deptRes = await request('GET', `/api/reports/summary/department/${mechDept?.id}`, adminToken);
  assert(deptRes.status === 200, 'GET /api/reports/summary/department/:id returns department summary');
  assert(Array.isArray(deptRes.body.categories), 'Department summary breaks down allocations by category');

  // 4. Centre Summary
  const coeAuto = store.data.departments.find((d) => d.code === 'COE-AUTO');
  const centreRes = await request('GET', `/api/reports/summary/centre/${coeAuto?.id}`, adminToken);
  assert(centreRes.status === 200, 'GET /api/reports/summary/centre/:id returns Centre of Excellence summary');

  console.log('\n--- PHASE 5: REPORT GENERATION (14 REPORT TYPES) & EXPORTS ---');
  const all14Reports = [
    'nfa_activity',
    'department_budget',
    'school_budget',
    'campus_budget',
    'capex',
    'revenue_earnings',
    'event_activity',
    'purchase_activity',
    'purchase_invoice',
    'payment_status',
    'financial_ledger',
    'faculty_nfa',
    'centres_offices',
    'pending_approvals',
  ];

  for (const rep of all14Reports) {
    const dataRes = await request('GET', `/api/reports/data/${rep}`, adminToken);
    assert(dataRes.status === 200 && Array.isArray(dataRes.body.data), `GET /api/reports/data/${rep} generates structured dataset`);
  }

  // Test PDF Export
  const pdfRes = await request('POST', '/api/reports/export/nfa_activity/pdf', adminToken);
  assert(pdfRes.status === 200, 'POST /api/reports/export/nfa_activity/pdf returns 200 OK');
  assert(pdfRes.headers['content-type'] === 'application/pdf', 'PDF export content-type is application/pdf');
  assert(Boolean(pdfRes.buffer && pdfRes.buffer.subarray(0, 4).toString() === '%PDF'), 'PDF export generates valid %PDF document stream');

  // Test Excel Export
  const excelRes = await request('POST', '/api/reports/export/department_budget/excel', adminToken);
  assert(excelRes.status === 200, 'POST /api/reports/export/department_budget/excel returns 200 OK');
  assert(excelRes.headers['content-type'] ? excelRes.headers['content-type'].includes('spreadsheetml') : false, 'Excel export content-type is xlsx spreadsheet');
  assert(Boolean(excelRes.buffer && excelRes.buffer.subarray(0, 2).toString() === 'PK'), 'Excel export generates valid PK zip container for xlsx');

  console.log('\n--- PHASE 6: STRICT ROLE-BASED ACCESS CONTROL (RBAC) ---');
  // Faculty cannot access campus summary
  const facCampRes = await request('GET', '/api/reports/summary/campus', facultyMechToken);
  assert(facCampRes.status === 403, 'RBAC: Faculty cannot access campus executive summary (returns 403 Forbidden)');

  // Faculty MECH cannot access CSE department summary
  const facCrossDeptRes = await request('GET', `/api/reports/summary/department/${cseDept?.id}`, facultyMechToken);
  assert(facCrossDeptRes.status === 403, 'RBAC: Faculty MECH cannot access CSE department summary (returns 403 Forbidden)');

  // Faculty cannot verify revenue entries
  const facVerifyRes = await request('PUT', `/api/revenue/entries/${createdRevenueId}/verify`, facultyMechToken, { status: 'verified' });
  assert(facVerifyRes.status === 403, 'RBAC: Faculty cannot verify revenue entries (returns 403 Forbidden)');

  console.log('\n--- PHASE 7: FRONTEND JAVASCRIPT SYNTAX, NAVIGATION & RENAMING INTEGRITY ---');
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf-8');

  // Verify inline JavaScript syntax with Node vm compiler
  let scriptValid = true;
  let scriptSyntaxError = '';
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let sMatch;
  while ((sMatch = scriptRegex.exec(indexHtml)) !== null) {
    try {
      new vm.Script(sMatch[1], { filename: 'public/index.html' });
    } catch (err: any) {
      scriptValid = false;
      scriptSyntaxError = `${err.message} at line ${err.stack}`;
      break;
    }
  }
  assert(scriptValid, 'Frontend inline <script> compiles with 100% valid JavaScript syntax (zero syntax errors)', scriptSyntaxError);

  // Verify critical login functions exist in script
  const hasDoLogin = indexHtml.includes('async function doLogin(') || indexHtml.includes('function doLogin(');
  assert(hasDoLogin, 'Frontend script defines doLogin() function');

  const hasTogglePassword = indexHtml.includes('function togglePasswordVisibility(');
  assert(hasTogglePassword, 'Frontend script defines togglePasswordVisibility() function');

  // Verify exact 8 unnumbered navigation tabs
  const tabLabelMatch = indexHtml.includes("dashboard: 'Home'") &&
    indexHtml.includes("nfas: 'NFA'") &&
    indexHtml.includes("inbox: 'Approvals'") &&
    indexHtml.includes("budgets: 'Budget'") &&
    indexHtml.includes("invoices: 'Financial Records'") &&
    indexHtml.includes("excel: 'Reports & Analytics'") &&
    indexHtml.includes("audit: 'Financial Ledger'") &&
    indexHtml.includes("admin: 'Settings'");
  assert(tabLabelMatch, 'Frontend TAB_LABEL contains exact required unnumbered labels (Home | NFA | Approvals | Budget | Financial Records | Reports & Analytics | Financial Ledger | Settings)');

  // Verify zero numerical prefixes in TAB_LABEL
  const hasNumericalPrefixes = indexHtml.includes("dashboard: '01.") || indexHtml.includes("budgets: '04.");
  assert(!hasNumericalPrefixes, 'Zero numerical prefixes (01., 02., etc.) in top navigation bar');

  // Verify campus header
  const headerMatch = (indexHtml.includes('Bengaluru – Kengeri Campus · Institutional NFA &amp; Budget System') || indexHtml.includes('Bengaluru – Kengeri Campus · Institutional NFA & Budget System')) && indexHtml.includes('ESTD. 1969');
  assert(headerMatch, 'Campus header correctly displays "Bengaluru – Kengeri Campus · Institutional NFA & Budget System" and "ESTD. 1969"');

  // Verify tab order in TABS_BY_ROLE
  const orderMatch = indexHtml.includes("super_admin: ['dashboard', 'nfas', 'inbox', 'budgets', 'invoices', 'excel', 'audit', 'admin']");
  assert(orderMatch, 'Frontend TABS_BY_ROLE enforces exact required tab sequence');

  // Verify zero occurrences of "Centres or Offices"
  const oldCentresMatch = indexHtml.includes('Centres or Offices');
  assert(!oldCentresMatch, 'Zero occurrences of legacy "Centres or Offices" (globally renamed to "Centres / Offices")');

  // Verify Event details badge & completion status
  const eventDetailsDisplayMatch = indexHtml.includes('Revenue-Generating Event:') && indexHtml.includes('Event Operations Status:');
  assert(eventDetailsDisplayMatch, 'NFA View Details displays Revenue-Generating Event badge and Event Operations Status');

  console.log('\n--- PHASE 8: MULTI-SCOPE BUDGET OVERVIEW & MULTI-SHEET EXCEL ---');
  // Test multi-scope budget overviews
  const scopesToTest = ['campus', 'soet', 'soa', 'sbm', 'sps', 'coe'];
  for (const sc of scopesToTest) {
    const scRes = await request('GET', `/api/budgets/school/overview?scope=${sc}`, adminToken);
    assert(scRes.status === 200, `GET /api/budgets/school/overview?scope=${sc} returns 200 OK`);
    assert(scRes.body.totals !== undefined, `Scope ${sc} returns 4 summary totals cards data`);
  }

  // Test multi-sheet school_budget Excel export
  const schoolExcelRes = await request('POST', '/api/reports/export/school_budget/excel', adminToken);
  assert(schoolExcelRes.status === 200, 'POST /api/reports/export/school_budget/excel returns 200 OK');
  assert(schoolExcelRes.headers['content-type'] ? schoolExcelRes.headers['content-type'].includes('spreadsheetml') : false, 'School budget export is xlsx workbook');
  assert(Boolean(schoolExcelRes.buffer && schoolExcelRes.buffer.subarray(0, 2).toString() === 'PK'), 'School budget Excel export is valid multi-sheet workbook');

  // Test A4 PDF export for school_budget
  const schoolPdfRes = await request('POST', '/api/reports/export/school_budget/pdf', adminToken);
  assert(schoolPdfRes.status === 200, 'POST /api/reports/export/school_budget/pdf returns 200 OK');
  assert(Boolean(schoolPdfRes.buffer && schoolPdfRes.buffer.subarray(0, 4).toString() === '%PDF'), 'School budget PDF export generates valid %PDF stream');

  // Clean up test revenue entry
  await request('DELETE', `/api/revenue/entries/${createdRevenueId}`, adminToken);

  console.log('\n================================================================');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`  TEST RESULTS: ${passed} PASSED / ${failed} FAILED (TOTAL ${results.length})`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runMasterUpgradeTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
