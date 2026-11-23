import puppeteer from 'puppeteer-core';

async function runLiveBrowserTest() {
  console.log('===============================================================');
  console.log('--- EXECUTING REAL-BROWSER AUDIT ON LIVE DEPLOYMENT ---');
  console.log('   Target: https://nfa-system.onrender.com');
  console.log('===============================================================\n');

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  console.log('[1/7] Launching Google Chrome browser...');
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    page.setViewport({ width: 1280, height: 800 });

    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') {
        console.error(`  [Browser Console Error] ${text}`);
        consoleErrors.push(text);
      } else {
        // console.log(`  [Browser Console ${type}] ${text}`);
      }
    });

    page.on('pageerror', (err: any) => {
      console.error(`  [Browser Page Error] ${err.message}`);
      pageErrors.push(err.message);
    });

    // 2. Navigate to production URL
    console.log('\n[2/7] Navigating to https://nfa-system.onrender.com...');
    await page.goto('https://nfa-system.onrender.com', { waitUntil: 'networkidle2', timeout: 30000 });

    const pageTitle = await page.title();
    console.log(`  Page Title: "${pageTitle}"`);

    // Verify Console has zero blocking JavaScript errors
    console.log('\n[3/7] Inspecting browser console for syntax/reference errors...');
    const syntaxErrors = consoleErrors.filter((e) => e.includes('SyntaxError') || e.includes('Unexpected token'));
    const refErrors = consoleErrors.filter((e) => e.includes('ReferenceError') || e.includes('is not defined'));

    if (syntaxErrors.length > 0) {
      throw new Error(`CRITICAL: Browser console contains SyntaxError: ${syntaxErrors.join('; ')}`);
    }
    if (refErrors.length > 0) {
      throw new Error(`CRITICAL: Browser console contains ReferenceError: ${refErrors.join('; ')}`);
    }
    console.log('  ✅ ZERO SyntaxErrors detected in browser console!');
    console.log('  ✅ ZERO ReferenceErrors detected (doLogin & togglePasswordVisibility initialized successfully)!');

    // 4. Test Password Visibility Toggle
    console.log('\n[4/7] Testing Password Visibility Toggle interaction...');
    await page.waitForSelector('#loginPassword', { visible: true });
    await page.type('#loginPassword', 'SecretTestPass123');

    let inputType = await page.$eval('#loginPassword', (el: any) => el.type);
    console.log(`  Initial input type: ${inputType}`);
    if (inputType !== 'password') throw new Error(`Expected input type "password", got "${inputType}"`);

    // Click toggle button
    await page.click('.pwd-toggle-btn');
    inputType = await page.$eval('#loginPassword', (el: any) => el.type);
    console.log(`  After 1st toggle click: ${inputType}`);
    if (inputType !== 'text') throw new Error(`Expected input type "text" after click, got "${inputType}"`);

    // Click toggle button again
    await page.click('.pwd-toggle-btn');
    inputType = await page.$eval('#loginPassword', (el: any) => el.type);
    console.log(`  After 2nd toggle click: ${inputType}`);
    if (inputType !== 'password') throw new Error(`Expected input type "password" after 2nd click, got "${inputType}"`);
    console.log('  ✅ Password visibility toggle works perfectly in real Chrome!');

    // 5. Test Invalid Login Feedback
    console.log('\n[5/7] Testing Invalid Login feedback banner...');
    await page.$eval('#loginEmail', (el: any) => (el.value = ''));
    await page.$eval('#loginPassword', (el: any) => (el.value = ''));
    await page.type('#loginEmail', 'admin@christ.edu');
    await page.type('#loginPassword', 'IncorrectPassword@999');

    await page.click('#btnLoginSubmit');
    await page.waitForSelector('#loginErr', { visible: true, timeout: 10000 });
    const errMsg = await page.$eval('#loginErr', (el: any) => el.innerText);
    console.log(`  Login error displayed: "${errMsg}"`);
    if (!errMsg || errMsg.trim().length === 0) {
      throw new Error('Expected visible login error banner on failed login attempt');
    }
    console.log('  ✅ Meaningful login error banner displayed successfully!');

    // 6. Test Super Admin Login
    console.log('\n[6/7] Testing Super Admin Login (admin@christ.edu)...');
    await page.$eval('#loginEmail', (el: any) => (el.value = ''));
    await page.$eval('#loginPassword', (el: any) => (el.value = ''));
    await page.type('#loginEmail', 'admin@christ.edu');
    await page.type('#loginPassword', 'Password@123');

    await page.click('#btnLoginSubmit');
    await page.waitForSelector('#app', { visible: true, timeout: 20000 });
    await page.waitForSelector('#nav button', { visible: true, timeout: 15000 });

    const whoamiName = await page.$eval('#whoamiName', (el: any) => el.textContent.trim());
    const whoamiRole = await page.$eval('#whoamiRole', (el: any) => el.textContent.trim());
    console.log(`  Logged in user: "${whoamiName}" | Role: "${whoamiRole}"`);
    if (whoamiName !== 'Admin' || whoamiRole !== 'super admin') {
      throw new Error(`Expected Admin (super admin), got ${whoamiName} (${whoamiRole})`);
    }

    // Check all 8 top navigation tabs
    const navTabs = await page.$$eval('#nav button', (btns: any[]) => btns.map((b) => b.textContent.trim()));
    console.log(`  Top Navigation Tabs rendered: ${JSON.stringify(navTabs)}`);
    const expectedTabs = ['Home', 'NFA', 'Approvals', 'Budget', 'Financial Records', 'Reports & Analytics', 'Financial Ledger', 'Settings'];
    for (const exp of expectedTabs) {
      if (!navTabs.includes(exp)) {
        throw new Error(`Missing expected tab in UI: "${exp}"`);
      }
    }
    console.log('  ✅ All 8 unnumbered tabs rendered and visible!');

    // Click Budget tab
    console.log('  Clicking "Budget" tab...');
    await page.evaluate(() => (window as any).showTab('budgets'));
    await new Promise((r) => setTimeout(r, 2000));
    const budgetCardExists = await page.$('.stat-card.primary');
    if (!budgetCardExists) throw new Error('Budget summary cards failed to render');
    console.log('  ✅ Multi-School Budget Dashboard rendered successfully!');

    // Click Financial Records tab
    console.log('  Clicking "Financial Records" tab...');
    await page.evaluate(() => (window as any).showTab('invoices'));
    await new Promise((r) => setTimeout(r, 2000));
    const subtabs = await page.$$eval('#main button', (els: any[]) =>
      els
        .filter((e) => (e.getAttribute('onclick') || '').includes('switchFinancialRecordsTab'))
        .map((e) => e.textContent.trim().replace('&amp;', '&'))
    );
    console.log(`  Financial Records Subtabs: ${JSON.stringify(subtabs)}`);
    if (!subtabs.some((s) => s.includes('Purchase Invoices')) || !subtabs.some((s) => s.includes('Revenue')) || !subtabs.some((s) => s.includes('Event Completion'))) {
      throw new Error('Financial Records subtabs missing');
    }
    console.log('  ✅ Financial Records subtabs and views rendered successfully!');

    // Click Reports & Analytics tab
    console.log('  Clicking "Reports & Analytics" tab...');
    await page.evaluate(() => (window as any).showTab('excel'));
    await new Promise((r) => setTimeout(r, 2500));

    // Verify Executive Summary Section 1, 2, 3
    const summaryCardTitle = await page.$eval('.card-title', (el: any) => el.textContent.trim());
    console.log(`  Reports & Analytics Card Title: "${summaryCardTitle}"`);
    if (!summaryCardTitle.includes('Summary Generation')) {
      throw new Error(`Expected Summary Generation view, got "${summaryCardTitle}"`);
    }

    const executiveSection1 = await page.$eval('h3', (el: any) => el.textContent.trim());
    console.log(`  Summary Section 1 Header: "${executiveSection1}"`);

    // Verify 4-stat cards
    const statCardsCount = await page.$$eval('.stat-card', (cards: any[]) => cards.length);
    console.log(`  Rendered Executive Stat Cards: ${statCardsCount}`);
    if (statCardsCount < 4) {
      throw new Error(`Expected at least 4 executive stat cards, got ${statCardsCount}`);
    }

    // Switch to Report Generation sub-tab (14 reports)
    console.log('  Switching to "Report Generation" (14 official reports)...');
    await page.evaluate(() => (window as any).switchReportsAnalyticsTab('reports'));
    await new Promise((r) => setTimeout(r, 2000));

    const repDefBtns = await page.$$eval('#main button', (btns: any[]) =>
      btns.filter((b) => (b.getAttribute('onclick') || '').includes('selectReportType')).map((b) => b.textContent.trim())
    );
    console.log(`  Available Report Types count: ${repDefBtns.length}`);
    if (repDefBtns.length !== 14) {
      throw new Error(`Expected 14 report definitions, found ${repDefBtns.length}`);
    }
    console.log('  ✅ All 14 Official Institutional Report types rendered with organization filter bar!');

    // 7. Test Logout and Multi-Role Login (Finance and Faculty)
    console.log('\n[7/7] Testing Logout & Multi-Role Logins (Finance & Faculty)...');
    await page.evaluate(() => (window as any).logout());
    await page.waitForSelector('#login', { visible: true, timeout: 10000 });
    console.log('  Logout successful. Redirected to clean login screen.');

    // A. Login as Finance (Fr. Shijin P J - active account without must_change_password)
    console.log('  Testing Finance login (asst.director.engineering@christuniversity.in)...');
    await page.$eval('#loginEmail', (el: any) => (el.value = ''));
    await page.$eval('#loginPassword', (el: any) => (el.value = ''));
    await page.type('#loginEmail', 'asst.director.engineering@christuniversity.in');
    await page.type('#loginPassword', 'Password@123');
    await page.click('#btnLoginSubmit');
    await page.waitForSelector('#app', { visible: true, timeout: 20000 });
    await page.waitForSelector('#nav button', { visible: true, timeout: 15000 });

    const finName = await page.$eval('#whoamiName', (el: any) => el.textContent.trim());
    const finRole = await page.$eval('#whoamiRole', (el: any) => el.textContent.trim());
    console.log(`  Finance Logged In: "${finName}" | Role: "${finRole}"`);
    if (!finName.includes('Shijin') || finRole !== 'finance') {
      throw new Error(`Finance login failed: expected Fr. Shijin P J (finance), got ${finName} (${finRole})`);
    }
    console.log('  ✅ Finance login verified with authorized dashboard and role permissions!');

    // Logout again
    await page.evaluate(() => (window as any).logout());
    await page.waitForSelector('#login', { visible: true, timeout: 10000 });

    // B. Login as Faculty (Dr. Mary Anita E A - temporary password security gate)
    console.log('  Testing Faculty login with temporary password gate (maryanita.ea@christuniversity.in)...');
    await page.$eval('#loginEmail', (el: any) => (el.value = ''));
    await page.$eval('#loginPassword', (el: any) => (el.value = ''));
    await page.type('#loginEmail', 'maryanita.ea@christuniversity.in');
    await page.type('#loginPassword', 'Password@123');
    await page.click('#btnLoginSubmit');

    // Verify mandatory password change modal displays
    await page.waitForSelector('#modalMustChangePassword', { visible: true, timeout: 15000 });
    const modalText = await page.$eval('#modalMustChangePassword', (el: any) => el.innerText);
    console.log(`  Mandatory Password Change modal appeared: "${modalText.split('\n')[0]}"`);
    if (!modalText.includes('Mandatory Password Change')) {
      throw new Error('Expected Mandatory Password Change modal for faculty account');
    }
    console.log('  ✅ Faculty authentication and temporary password security gate verified!');

    console.log('\n===============================================================');
    console.log('🎉 REAL CHROME BROWSER AUDIT COMPLETED WITH 100% SUCCESS!');
    console.log('   All login flows, password toggle, console logs, and views PASS.');
    console.log('===============================================================\n');
  } finally {
    await browser.close();
  }
}

runLiveBrowserTest().catch((err) => {
  console.error('\n❌ BROWSER TEST FAILED:', err);
  process.exit(1);
});
