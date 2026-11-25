process.env.NODE_ENV = 'test';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import puppeteer from 'puppeteer-core';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';

interface TestResult {
  step: number;
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function record(step: number, name: string, passed: boolean, details?: string) {
  results.push({ step, name, passed, details });
  console.log(`  [${passed ? '✓ PASS' : '✗ FAIL'}] Step ${step}: ${name}${details ? ` (${details})` : ''}`);
  if (!passed) throw new Error(`Test failed at step ${step}: ${name}`);
}

async function runAuthAndSessionLifecycleTests() {
  console.log('================================================================');
  console.log('  CU-NFA AUTHENTICATION, SESSION & ACCESSIBILITY AUDIT SUITE    ');
  console.log('================================================================\n');

  try {
    await store.loadFromPostgres();
  } catch (e: any) {
    console.log('Store init notice (using local authoritative dataset):', e.message);
    (store as any).isPostgres = false;
  }
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Local test server running at ${baseUrl}`);

  const tempUserDataDir = path.join(os.tmpdir(), `cu_nfa_auth_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);

  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    userDataDir: tempUserDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    const uncaughtExceptions: string[] = [];
    const requestedUrls: string[] = [];

    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') {
        consoleErrors.push(text);
      }
    });

    page.on('pageerror', (err) => {
      uncaughtExceptions.push(err.message);
    });

    page.on('request', (req) => {
      requestedUrls.push(req.url());
    });

    const superAdmin = store.data.users.find((u) => u.role === 'super_admin');
    if (!superAdmin) throw new Error('Super Admin user not found in store');

    // -------------------------------------------------------------
    // TEST 1: Cold start without token in localStorage
    // -------------------------------------------------------------
    console.log('\n--- TEST 1: Cold start without token ---');
    await page.goto(baseUrl, { waitUntil: 'networkidle2' });

    const loginDisplay = await page.evaluate(() => {
      const el = document.getElementById('login');
      return el ? window.getComputedStyle(el).display : 'none';
    });
    const appDisplay = await page.evaluate(() => {
      const el = document.getElementById('app');
      return el ? window.getComputedStyle(el).display : 'block';
    });

    record(1, 'Cold start renders #login form', loginDisplay !== 'none', `login display: ${loginDisplay}`);
    record(2, 'Cold start keeps #app hidden', appDisplay === 'none', `app display: ${appDisplay}`);

    const budgetCallsColdStart = requestedUrls.filter((u) => u.includes('/api/budgets/'));
    record(3, 'Zero /api/budgets/* calls on cold start without token', budgetCallsColdStart.length === 0, `Calls: ${budgetCallsColdStart.length}`);
    record(4, 'Zero console errors on clean cold start', consoleErrors.length === 0, `Errors: ${consoleErrors.join('; ')}`);
    record(5, 'Zero uncaught exceptions on clean cold start', uncaughtExceptions.length === 0);

    // -------------------------------------------------------------
    // TEST 2: Cold start with Expired Token in localStorage
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: Cold start with expired token (Cascading 401 prevention) ---');
    consoleErrors.length = 0;
    uncaughtExceptions.length = 0;
    requestedUrls.length = 0;

    // Craft an expired JWT (expired 2 hours ago)
    const jwtSecret = process.env.JWT_SECRET || 'dev_secret_university_nfa_system_2026';
    const expiredToken = jwt.sign(
      {
        id: superAdmin.id,
        email: superAdmin.email,
        role: superAdmin.role,
        department_id: superAdmin.department_id,
        name: superAdmin.name,
      },
      jwtSecret,
      { expiresIn: '-2h' }
    );

    // Inject expired token and user object into localStorage
    await page.evaluate((tok, usr) => {
      localStorage.setItem('token', tok);
      localStorage.setItem('user', JSON.stringify(usr));
    }, expiredToken, superAdmin);

    // Reload page
    await page.reload({ waitUntil: 'networkidle2' });

    const loginDisplayExpired = await page.evaluate(() => {
      const el = document.getElementById('login');
      return el ? window.getComputedStyle(el).display : 'none';
    });
    const appDisplayExpired = await page.evaluate(() => {
      const el = document.getElementById('app');
      return el ? window.getComputedStyle(el).display : 'block';
    });
    const loginNoticeText = await page.evaluate(() => {
      const err = document.getElementById('loginErr');
      return err ? err.textContent || '' : '';
    });

    record(6, 'Expired token does NOT show #app', appDisplayExpired === 'none', `app display: ${appDisplayExpired}`);
    record(7, 'Expired token shows #login', loginDisplayExpired !== 'none', `login display: ${loginDisplayExpired}`);
    record(8, 'Session expired user notice displayed', loginNoticeText.includes('session has expired') || loginNoticeText.includes('sign in'), `Notice: "${loginNoticeText.trim()}"`);

    const budgetCallsExpired = requestedUrls.filter((u) => u.includes('/api/budgets/'));
    record(9, 'CRITICAL: Zero cascading 401s to /api/budgets/* with dead token', budgetCallsExpired.length === 0, `Calls fired: ${budgetCallsExpired.length}`);
    record(10, 'Zero uncaught promise rejections on expired session auto-boot', uncaughtExceptions.length === 0, `Exceptions: ${uncaughtExceptions.join('; ')}`);

    // -------------------------------------------------------------
    // TEST 3: Fresh Login with Valid Credentials
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Fresh Login with valid Super Admin credentials ---');
    consoleErrors.length = 0;
    uncaughtExceptions.length = 0;

    await page.evaluate(() => {
      const emailInput = document.getElementById('loginEmail') as HTMLInputElement;
      const pwdInput = document.getElementById('loginPassword') as HTMLInputElement;
      if (emailInput) emailInput.value = 'hod@christ.edu';
      if (pwdInput) pwdInput.value = 'password123';
    });

    await page.click('#btnLoginSubmit');
    await page.waitForFunction(() => {
      const appEl = document.getElementById('app');
      return appEl && window.getComputedStyle(appEl).display === 'block';
    }, { timeout: 10000 });

    const activeUser = await page.evaluate(() => {
      return {
        name: document.getElementById('whoamiName')?.textContent || '',
        role: document.getElementById('whoamiRole')?.textContent || '',
        token: localStorage.getItem('token') || '',
      };
    });

    record(11, 'Smooth transition to #app on valid login', Boolean(activeUser.token), `Token present: ${Boolean(activeUser.token)}`);
    record(12, 'Logged-in user identity rendered in header', activeUser.name.length > 0, `User: ${activeUser.name} (${activeUser.role})`);
    record(13, 'Zero DevTools console errors during successful login and boot', consoleErrors.length === 0, `Errors: ${consoleErrors.join('; ')}`);

    // -------------------------------------------------------------
    // TEST 4: Single-Flight Token Refresh Execution
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: Single-Flight Token Refresh Endpoint ---');
    const refreshResult = await page.evaluate(async () => {
      const oldTok = localStorage.getItem('token');
      // Trigger 3 simultaneous refresh calls
      const p1 = (window as any).refreshTokenSingleFlight();
      const p2 = (window as any).refreshTokenSingleFlight();
      const p3 = (window as any).refreshTokenSingleFlight();
      const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
      const newTok = localStorage.getItem('token');
      return {
        sameTokenReturned: t1 === t2 && t2 === t3,
        tokenUpdatedInStorage: newTok !== oldTok && Boolean(newTok),
        newTok,
      };
    });

    record(14, 'Single-flight refresh coalesces simultaneous requests into one flight', refreshResult.sameTokenReturned);
    record(15, 'Token updated in localStorage after refresh', refreshResult.tokenUpdatedInStorage);

    // -------------------------------------------------------------
    // TEST 5: Proactive Token Refresh When Token Nears Expiry
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Proactive Token Refresh on Protected API Requests ---');
    // Issue a token expiring in 10 seconds for the logged-in HOD user
    const hodUser = store.data.users.find((u) => u.email === 'hod@christ.edu') || superAdmin;
    const expiringSoonToken = jwt.sign(
      {
        id: hodUser.id,
        email: hodUser.email,
        role: hodUser.role,
        department_id: hodUser.department_id,
        name: hodUser.name,
      },
      jwtSecret,
      { expiresIn: '10s' }
    );

    const proactiveRefreshResult = await page.evaluate(async (tok, usr) => {
      (window as any).setSessionToken(tok, usr);
      // Protected call should detect token expiring in <30s and proactively refresh before firing
      const userProfile = await (window as any).api('/users/me');
      const activeTok = localStorage.getItem('token');
      return {
        success: Boolean(userProfile && userProfile.email),
        refreshed: activeTok !== tok,
      };
    }, expiringSoonToken, hodUser);

    record(16, 'Proactive refresh triggered seamlessly on protected API request', proactiveRefreshResult.refreshed);
    record(17, 'Protected request succeeds after proactive refresh', proactiveRefreshResult.success);

    // -------------------------------------------------------------
    // TEST 6: Graceful Logout & State Teardown
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: Graceful Logout and Teardown ---');
    await page.evaluate(async () => {
      await (window as any).logout();
    });

    const logoutState = await page.evaluate(() => {
      return {
        appHidden: document.getElementById('app')?.style.display === 'none',
        loginVisible: document.getElementById('login')?.style.display === 'block',
        tokenCleared: localStorage.getItem('token') === null,
        userCleared: localStorage.getItem('user') === null,
      };
    });

    record(18, 'Logout cleanly hides #app and shows #login', logoutState.appHidden && logoutState.loginVisible);
    record(19, 'Logout wipes token and user state from localStorage', logoutState.tokenCleared && logoutState.userCleared);

    // -------------------------------------------------------------
    // TEST 7: Cross-Tab Logout Synchronization
    // -------------------------------------------------------------
    console.log('\n--- TEST 7: Cross-Tab Logout Synchronization ---');
    // Re-authenticate
    await page.evaluate((tok, usr) => {
      (window as any).setSessionToken(tok, usr);
      document.getElementById('login')!.style.display = 'none';
      document.getElementById('app')!.style.display = 'block';
    }, refreshResult.newTok, hodUser);

    // Dispatch cross-tab storage event
    await page.evaluate(() => {
      localStorage.removeItem('token');
      window.dispatchEvent(new StorageEvent('storage', { key: 'token', oldValue: 'someToken', newValue: null }));
    });

    const crossTabState = await page.evaluate(() => {
      return {
        appHidden: document.getElementById('app')?.style.display === 'none',
        loginVisible: document.getElementById('login')?.style.display === 'block',
      };
    });

    record(20, 'Cross-tab storage event triggers immediate session teardown', crossTabState.appHidden && crossTabState.loginVisible);

    // -------------------------------------------------------------
    // TEST 8: Form Accessibility WCAG 2.2 AA Audit in Live DOM
    // -------------------------------------------------------------
    console.log('\n--- TEST 8: Live DOM Form Accessibility Audit ---');
    const a11yAudit = await page.evaluate(() => {
      const issues: string[] = [];

      // Check all labels with 'for' attribute
      const labels = Array.from(document.querySelectorAll('label[for]'));
      labels.forEach((l) => {
        const forId = l.getAttribute('for');
        if (forId) {
          const target = document.getElementById(forId);
          if (!target) {
            issues.push(`Label for="${forId}" has no matching element in DOM`);
          }
        }
      });

      // Check all visible inputs/selects/textareas have accessible name
      const controls = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'));
      controls.forEach((c) => {
        const input = c as HTMLInputElement;
        const id = input.id;
        const ariaLabel = input.getAttribute('aria-label');
        const ariaLabelledBy = input.getAttribute('aria-labelledby');
        let hasLabel = false;
        if (id) {
          hasLabel = Boolean(document.querySelector(`label[for="${id}"]`));
        }
        const insideLabel = Boolean(input.closest('label'));

        if (!ariaLabel && !ariaLabelledBy && !hasLabel && !insideLabel) {
          issues.push(`Control <${input.tagName.toLowerCase()} id="${id || 'none'}" name="${input.name || 'none'}"> lacks accessible name`);
        }
      });

      return {
        labelCount: labels.length,
        controlCount: controls.length,
        issues,
      };
    });

    record(21, 'Live DOM labels with `for` reference valid elements', a11yAudit.issues.filter((i) => i.includes('Label for=')).length === 0, `Audited: ${a11yAudit.labelCount} labels`);
    record(22, 'Live DOM form controls have valid accessible names', a11yAudit.issues.filter((i) => i.includes('lacks accessible name')).length === 0, `Audited: ${a11yAudit.controlCount} controls`);

    console.log('\n================================================================');
    console.log(`🎉 ALL ${results.length} AUTH & ACCESSIBILITY TESTS PASSED WITH 0 FAILURES!`);
    console.log('================================================================\n');
  } finally {
    await browser.close();
    server.close();
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

runAuthAndSessionLifecycleTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
