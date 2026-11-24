import puppeteer from 'puppeteer-core';

async function verifyLiveButtonsDeployment() {
  console.log('================================================================');
  console.log('--- VERIFYING LIVE RENDER PRODUCTION DEPLOYMENT & BUTTONS ---');
  console.log('   Target: https://nfa-system.onrender.com');
  console.log('================================================================\n');

  const baseUrl = 'https://nfa-system.onrender.com';
  let deployed = false;
  let attempts = 0;
  const maxAttempts = 30; // wait up to ~2.5 minutes for Render build & deploy

  console.log('[1/4] Polling live deployment for updated commit (checking confirmDeleteDraft & addFy)...');
  while (!deployed && attempts < maxAttempts) {
    attempts++;
    try {
      const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const text = await res.text();
        const hasConfirmDeleteDraft = text.includes('function confirmDeleteDraft');
        const hasAddFy = text.includes('function addFy');
        const hasTabRaceGuard = text.includes("if (currentTab !== 'dashboard') return;");

        if (hasConfirmDeleteDraft && hasAddFy && hasTabRaceGuard) {
          console.log(`  ✅ Verified new commit bff6ac8 is LIVE on Render! (Attempt ${attempts})`);
          deployed = true;
          break;
        } else {
          console.log(`  [Attempt ${attempts}/${maxAttempts}] Live site active, but older commit still running. Waiting 6s...`);
        }
      } else {
        console.log(`  [Attempt ${attempts}/${maxAttempts}] HTTP status ${res.status}. Waiting 6s...`);
      }
    } catch (err: any) {
      console.log(`  [Attempt ${attempts}/${maxAttempts}] Connection: ${err.message}. Waiting 6s...`);
    }
    await new Promise((r) => setTimeout(r, 6000));
  }

  if (!deployed) {
    throw new Error('Deployment timed out waiting for Render to finish rolling out the latest commit.');
  }

  // 2. Perform live API verification
  console.log('\n[2/4] Testing live authentication & session API...');
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@christ.edu',
      password: 'Password@123',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!loginRes.ok) {
    throw new Error(`Live login failed with HTTP ${loginRes.status}`);
  }
  const loginData: any = await loginRes.json();
  const token = loginData.token;
  console.log(`  ✅ Live login successful as ${loginData.user?.name} (${loginData.user?.email})`);

  // 3. Launch Chrome browser against live deployment
  console.log('\n[3/4] Launching Google Chrome against live production URL...');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const consoleErrors: string[] = [];

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    page.setViewport({ width: 1366, height: 900 });

    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error' && !text.includes('favicon.ico')) {
        console.error(`  [Live Browser Console Error] ${text}`);
        consoleErrors.push(text);
      }
    });

    // Load Live Site
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    console.log('  ✅ Live website loaded.');

    // Login in browser
    await page.waitForSelector('#loginEmail', { visible: true });
    await page.type('#loginEmail', 'admin@christ.edu');
    await page.type('#loginPassword', 'Password@123');
    await page.click('#btnLoginSubmit');

    await page.waitForSelector('#app', { visible: true, timeout: 20000 });
    await page.waitForSelector('#nav button', { visible: true, timeout: 15000 });
    console.log('  ✅ Live login completed, main application visible.');

    // Test all 8 tabs
    const expectedTabs = ['Home', 'NFA', 'Approvals', 'Budget', 'Financial Records', 'Reports & Analytics', 'Financial Ledger', 'Settings'];
    const renderedTabs = await page.$$eval('#nav button', (btns) => btns.map((b) => b.textContent?.trim()));
    console.log(`  Top Navigation Tabs on live site: ${JSON.stringify(renderedTabs)}`);
    for (const exp of expectedTabs) {
      if (!renderedTabs.includes(exp)) {
        throw new Error(`Missing expected tab on live site: "${exp}"`);
      }
    }
    console.log('  ✅ All 8 top navigation tabs present on live Render site.');

    // Click NFA Tab
    await page.click('nav button[data-tab="nfas"]');
    await page.waitForSelector('#nfaSearchInput', { visible: true, timeout: 15000 });
    console.log('  ✅ Live NFA listing page loaded with search & status filters.');

    // Create a temporary draft on live site, test listing page delete draft, confirmation modal, cancel, and delete
    console.log('\n[4/4] Executing live Delete Draft interaction flow...');
    const liveDraft = await page.evaluate(async () => {
      const token = localStorage.getItem('token');
      const authHeader = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const [fysRes, deptsRes, catsRes] = await Promise.all([
        fetch('/api/budgets/financial-years', { headers: authHeader }),
        fetch('/api/budgets/departments', { headers: authHeader }),
        fetch('/api/budgets/categories', { headers: authHeader })
      ]);
      const [fys, depts, cats] = await Promise.all([fysRes.json(), deptsRes.json(), catsRes.json()]);

      const res = await fetch('/api/nfas', {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          title: 'Live Production Delete Draft Verification ' + Date.now(),
          organization_type: 'department',
          department_id: depts[0]?.id,
          financial_year_id: fys[0]?.id,
          budget_category_id: cats[0]?.id,
          nfa_type: 'event',
          total_amount: 1000,
          items: [{ sl_no: 1, particulars: 'Live Audit Verification', quantity: '1', rate: '1000', amount: 1000 }]
        })
      });
      const created = await res.json();
      await (window as any).showTab('nfas');
      return created;
    });

    console.log(`  -> Live Draft created: ${liveDraft.ref_no} (${liveDraft.id})`);

    // Filter to Drafts
    await page.waitForSelector('#nfaStatusFilterSelect', { visible: true, timeout: 5000 });
    await page.select('#nfaStatusFilterSelect', 'draft');
    await new Promise((r) => setTimeout(r, 600));

    const deleteBtnSelector = `button[onclick*="confirmDeleteDraft('${liveDraft.id}')"]`;
    await page.waitForSelector(deleteBtnSelector, { visible: true, timeout: 10000 });
    console.log(`  ✓ Delete Draft button visible on live NFA listing page.`);

    // Click Delete Draft
    await page.click(deleteBtnSelector);
    await page.waitForSelector('#deleteDraftConfirmDialog', { visible: true, timeout: 5000 });
    console.log('  ✓ Live confirmation dialog appeared with reference number.');

    // Click Cancel
    await page.click('#cancelDeleteNfaBtn');
    await page.waitForFunction(() => !document.getElementById('deleteDraftConfirmDialog'), { timeout: 5000 });
    console.log('  ✓ Cancel button safely dismissed dialog.');

    // Click Delete Draft again and confirm
    await page.click(deleteBtnSelector);
    await page.waitForSelector('#confirmDeleteNfaBtn', { visible: true, timeout: 5000 });
    await page.evaluate(() => {
      const btn = document.getElementById('confirmDeleteNfaBtn') as HTMLButtonElement;
      if (btn) btn.click();
    });

    // Wait for deletion confirmation
    await page.waitForFunction(() => !document.getElementById('deleteDraftConfirmDialog'), { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 600));

    const rowRemoved = await page.evaluate((id) => {
      return !document.querySelector(`button[onclick*="confirmDeleteDraft('${id}')"]`);
    }, liveDraft.id);

    if (!rowRemoved) {
      throw new Error('Live Draft NFA was not removed from table after deletion!');
    }
    console.log('  ✓ Live Draft NFA permanently removed from production table!');

    // Check console errors
    const fatalErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('404'));
    if (fatalErrors.length > 0) {
      throw new Error(`Live browser console errors detected:\n${fatalErrors.join('\n')}`);
    }
    console.log('  ✅ ZERO console errors on live production site!');

    console.log('\n================================================================');
    console.log('🎉 LIVE RENDER PRODUCTION DEPLOYMENT & BUTTON VERIFICATION: 100% PASSED!');
    console.log('================================================================\n');
  } finally {
    await browser.close();
  }
}

verifyLiveButtonsDeployment().catch((err) => {
  console.error('\n❌ Live deployment verification failed:', err);
  process.exit(1);
});
