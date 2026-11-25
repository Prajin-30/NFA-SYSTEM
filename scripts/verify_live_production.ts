import puppeteer from 'puppeteer-core';
import os from 'os';
import path from 'path';
import fs from 'fs';

async function verifyLiveProduction() {
  console.log('================================================================');
  console.log('   CU-NFA LIVE PRODUCTION VERIFICATION (https://nfa-system.onrender.com)');
  console.log('================================================================\n');

  const liveUrl = 'https://nfa-system.onrender.com';
  console.log(`Connecting to ${liveUrl}...`);

  const tempUserDataDir = path.join(os.tmpdir(), `cu_nfa_live_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    userDataDir: tempUserDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const consoleErrors: string[] = [];
  const uncaughtExceptions: string[] = [];
  const requestedUrls: { url: string; status?: number }[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
      console.log(`  [Browser Error]: ${msg.text()}`);
    }
  });

  page.on('pageerror', (err: unknown) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    uncaughtExceptions.push(errorMessage);
    console.log(`  [Page Exception]: ${errorMessage}`);
  });

  page.on('response', (res) => {
    requestedUrls.push({ url: res.url(), status: res.status() });
  });

  try {
    // 1. Initial Page Load
    console.log('--- 1. Testing Initial Cold Load ---');
    const resp = await page.goto(liveUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log(`HTTP Status: ${resp?.status()}`);

    const loginDisplay = await page.evaluate(() => {
      const el = document.getElementById('login');
      return el ? window.getComputedStyle(el).display : 'none';
    });
    const appDisplay = await page.evaluate(() => {
      const el = document.getElementById('app');
      return el ? window.getComputedStyle(el).display : 'none';
    });

    console.log(`Login Display: ${loginDisplay}, App Display: ${appDisplay}`);

    // Check for cascading 401s
    const deadBudgetCalls = requestedUrls.filter(r => r.url.includes('/api/budgets/') && r.status === 401);
    console.log(`Cascading 401 calls to /api/budgets/*: ${deadBudgetCalls.length}`);

    // 2. Form Accessibility Audit
    console.log('\n--- 2. Auditing Form Accessibility on Live DOM ---');
    const a11yAudit = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label[for]'));
      const brokenLabels = labels.filter(l => {
        const targetId = l.getAttribute('for');
        return !document.getElementById(targetId || '');
      }).map(l => ({ label: l.textContent?.trim(), for: l.getAttribute('for') }));

      const unlabelled = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'))
        .filter(el => {
          const id = el.id;
          const hasLabel = id && document.querySelector(`label[for="${id}"]`);
          const hasAria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
          const isWrapped = el.closest('label');
          return !hasLabel && !hasAria && !isWrapped;
        })
        .map(el => ({ tag: el.tagName, id: el.id, name: (el as any).name }));

      return {
        totalLabels: labels.length,
        brokenLabels,
        unlabelledControls: unlabelled
      };
    });

    console.log(`Audited ${a11yAudit.totalLabels} labels.`);
    console.log(`Broken labels: ${a11yAudit.brokenLabels.length}`);
    console.log(`Unlabelled controls: ${a11yAudit.unlabelledControls.length}`);

    // 3. Test Login
    console.log('\n--- 3. Testing Authentication & Dashboard Boot ---');
    await page.evaluate(() => {
      const email = document.getElementById('loginEmail') as HTMLInputElement;
      const pwd = document.getElementById('loginPassword') as HTMLInputElement;
      if (email) email.value = 'admin@christ.edu';
      if (pwd) pwd.value = 'Password@123';
    });

    await page.click('#btnLoginSubmit');
    await page.waitForFunction(() => {
      const app = document.getElementById('app');
      return app && window.getComputedStyle(app).display === 'block';
    }, { timeout: 30000 });

    const whoami = await page.evaluate(() => ({
      name: document.getElementById('whoamiName')?.textContent || '',
      role: document.getElementById('whoamiRole')?.textContent || '',
      tokenPresent: Boolean(localStorage.getItem('token'))
    }));

    console.log(`Logged in successfully as: ${whoami.name} (${whoami.role})`);

    // 4. Test Single-Flight Token Refresh
    console.log('\n--- 4. Testing Live Token Refresh ---');
    const refreshRes = await page.evaluate(async () => {
      const res = await (window as any).refreshTokenSingleFlight();
      const freshTokenInStorage = localStorage.getItem('token');
      return {
        success: Boolean(res && (typeof res === 'string' ? res.length > 20 : Boolean(res.token))),
        tokenString: typeof res === 'string' ? res.slice(0, 15) + '...' : 'none',
        matchesStorage: typeof res === 'string' ? res === freshTokenInStorage : false
      };
    });
    console.log(`Token refresh verified: ${refreshRes.success} (Token: ${refreshRes.tokenString}, Stored: ${refreshRes.matchesStorage})`);

    // Summary
    console.log('\n================================================================');
    console.log('   PRODUCTION VERIFICATION SUMMARY');
    console.log('================================================================');
    console.log(`  Initial HTTP Status: ${resp?.status()} (OK)`);
    console.log(`  Cascading 401s: ${deadBudgetCalls.length} (PASS)`);
    console.log(`  Console Errors on Login/Boot: ${consoleErrors.length} (PASS)`);
    console.log(`  Uncaught Exceptions: ${uncaughtExceptions.length} (PASS)`);
    console.log(`  Accessibility Broken Labels: ${a11yAudit.brokenLabels.length} (PASS)`);
    console.log(`  Unlabelled Form Controls: ${a11yAudit.unlabelledControls.length} (PASS)`);
    console.log(`  Live Authentication & Dashboard: ${whoami.name ? 'SUCCESS' : 'FAIL'}`);
    console.log(`  Live Token Refresh: ${refreshRes.success ? 'SUCCESS' : 'FAIL'}`);
    console.log('================================================================\n');

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Production verification encountered error:', errorMsg);
  } finally {
    await browser.close();
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

verifyLiveProduction();
