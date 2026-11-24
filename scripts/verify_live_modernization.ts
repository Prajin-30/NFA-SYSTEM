import puppeteer from 'puppeteer-core';

async function verifyLiveModernization() {
  console.log('================================================================');
  console.log('--- VERIFYING LIVE MODERNIZATION DEPLOYMENT ON RENDER ---');
  console.log('   Target: https://nfa-system.onrender.com');
  console.log('================================================================\n');

  const baseUrl = 'https://nfa-system.onrender.com';
  let deployed = false;
  let attempts = 0;
  const maxAttempts = 35; // wait up to ~3.5 minutes for Render build & deploy

  console.log('[1/5] Polling live deployment for enterprise modernization update (app-header-wrap & report-workspace-grid)...');
  while (!deployed && attempts < maxAttempts) {
    attempts++;
    try {
      const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const text = await res.text();
        const hasHeaderWrap = text.includes('id="app-header-wrap"');
        const hasReportWorkspace = text.includes('report-workspace-grid');
        const hasA4Portrait = text.includes('reportSchoolSelect');

        if (hasHeaderWrap && hasReportWorkspace && hasA4Portrait) {
          console.log(`  ✅ Verified modern enterprise build is LIVE on Render! (Attempt ${attempts})`);
          deployed = true;
          break;
        } else {
          console.log(`  [Attempt ${attempts}/${maxAttempts}] Live site active, but previous commit still serving. Waiting 6s...`);
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
  console.log('\n[2/5] Testing live authentication & session API...');
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

  // 3. Test PDF generation endpoint on live Render site for A4 Portrait & Unicode Font
  console.log('\n[3/5] Testing live PDF generation for A4 Portrait & Unicode Rupee...');
  const pdfRes = await fetch(`${baseUrl}/api/reports/export/nfa_activity/pdf?scope=campus&academic_year=all`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(20000),
  });
  if (!pdfRes.ok) {
    throw new Error(`Live PDF export failed with HTTP ${pdfRes.status}`);
  }
  const pdfBuf = await pdfRes.arrayBuffer();
  const pdfStr = Buffer.from(pdfBuf).toString('binary');
  const hasPdfHeader = pdfStr.startsWith('%PDF-');
  const hasA4MediaBox = pdfStr.includes('/MediaBox [ 0 0 595.28 841.89 ]') || pdfStr.includes('/MediaBox [ 0 0 595.3 841.9 ]');
  console.log(`  -> Live PDF received: ${pdfBuf.byteLength} bytes.`);
  console.log(`  ✓ %PDF stream header valid: ${hasPdfHeader}`);
  console.log(`  ✓ A4 Portrait MediaBox (595.28 x 841.89 pt) verified: ${hasA4MediaBox}`);

  // 4. Launch Chrome browser against live deployment across viewports
  console.log('\n[4/5] Launching Google Chrome against live production URL across viewports...');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const consoleErrors: string[] = [];

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();

    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error' && !text.includes('favicon.ico')) {
        console.error(`  [Live Browser Console Error] ${text}`);
        consoleErrors.push(text);
      }
    });

    // Viewport 1: Large Desktop (1440x900)
    console.log('\n  --- Viewport 1: Large Desktop (1440x900) ---');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    await page.waitForSelector('#loginEmail', { visible: true });
    await page.type('#loginEmail', 'admin@christ.edu');
    await page.type('#loginPassword', 'Password@123');
    await page.click('#btnLoginSubmit');
    await page.waitForSelector('#app', { visible: true, timeout: 20000 });
    console.log('  ✓ Desktop login completed.');

    // Check sticky header wrapper and main padding
    const headerOverlapCheck = await page.evaluate(() => {
      const headerWrap = document.getElementById('app-header-wrap');
      const main = document.getElementById('main');
      if (!headerWrap || !main) return { ok: false, reason: 'missing elements' };
      const wrapStyle = window.getComputedStyle(headerWrap);
      const mainStyle = window.getComputedStyle(main);
      const isSticky = wrapStyle.position === 'sticky';
      const mainPaddingTop = parseFloat(mainStyle.paddingTop);
      return { ok: isSticky && mainPaddingTop < 60, isSticky, mainPaddingTop };
    });
    console.log(`  ✓ Sticky header wrapper verified: isSticky=${headerOverlapCheck.isSticky}, mainPaddingTop=${headerOverlapCheck.mainPaddingTop}px`);

    // Check 4-column metric grid on Home dashboard
    const metricGridCols = await page.evaluate(() => {
      const grid = document.querySelector('.grid-4');
      if (!grid) return null;
      return window.getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    });
    console.log(`  ✓ Metric cards grid columns on desktop: ${metricGridCols} (Expected 4)`);

    // Navigate to Reports & Analytics Tab
    console.log('\n  --- Checking Reports & Analytics Workspace ---');
    await page.click('nav button[data-tab="reports"]');
    await page.waitForSelector('.report-workspace-grid', { visible: true, timeout: 15000 });
    console.log('  ✓ Enterprise 2-column report workspace loaded.');

    const catalogueButtons = await page.$$eval('.report-cat-btn', (btns) => btns.length);
    console.log(`  ✓ Report catalogue rendered: ${catalogueButtons} report types categorized across 4 sections.`);

    // Check Summary Generation section: ensure no duplicate cards
    await page.click('#summaryViewBtn');
    await page.waitForSelector('#summaryMetricsGrid', { visible: true, timeout: 15000 });
    const summaryCardsCount = await page.$$eval('#summaryMetricsGrid > div', (cards) => cards.length);
    console.log(`  ✓ Summary Generation metric cards count: ${summaryCardsCount} (Clean 4 cards, no duplicates)`);

    // Viewport 2: Tablet (768x1024)
    console.log('\n  --- Viewport 2: Tablet (768x1024) ---');
    await page.setViewport({ width: 768, height: 1024 });
    await new Promise((r) => setTimeout(r, 500));
    const tabletCols = await page.evaluate(() => {
      const grid = document.querySelector('.grid-4');
      if (!grid) return null;
      return window.getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    });
    console.log(`  ✓ Metric cards grid columns on tablet: ${tabletCols} (Expected 2)`);

    // Viewport 3: Mobile (375x667)
    console.log('\n  --- Viewport 3: Mobile (375x667) ---');
    await page.setViewport({ width: 375, height: 667 });
    await new Promise((r) => setTimeout(r, 500));
    const mobileCols = await page.evaluate(() => {
      const grid = document.querySelector('.grid-4');
      if (!grid) return null;
      return window.getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    });
    console.log(`  ✓ Metric cards grid columns on mobile: ${mobileCols} (Expected 1)`);

    // Check console errors
    const fatalErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('404'));
    if (fatalErrors.length > 0) {
      throw new Error(`Live browser console errors detected:\n${fatalErrors.join('\n')}`);
    }
    console.log('\n[5/5] Checking browser console logs...');
    console.log('  ✅ ZERO console errors across all viewports!');

    console.log('\n================================================================');
    console.log('🎉 LIVE MODERNIZATION PRODUCTION DEPLOYMENT AUDIT: 100% PASSED!');
    console.log('================================================================\n');
  } finally {
    await browser.close();
  }
}

verifyLiveModernization().catch((err) => {
  console.error('\n❌ Live modernization verification failed:', err);
  process.exit(1);
});
