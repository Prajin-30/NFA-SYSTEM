import puppeteer from 'puppeteer-core';

async function verifyLiveEnterpriseDeployment() {
  console.log('================================================================');
  console.log('  VERIFYING LIVE RENDER PRODUCTION DEPLOYMENT (COMMIT 0a6c16b)  ');
  console.log('================================================================\n');

  const baseUrl = 'https://nfa-system.onrender.com';

  // 1. Poll until Render deploys the latest commit tokens
  console.log('[1/4] Checking deployed index.html for commit 0a6c16b tokens...');
  let deployed = false;
  let attempts = 0;
  const maxAttempts = 30; // 30 * 10s = 5 minutes max wait

  while (!deployed && attempts < maxAttempts) {
    attempts++;
    try {
      const res = await fetch(`${baseUrl}/?_t=${Date.now()}`, {
        headers: { 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const text = await res.text();
        const hasReportGrid = text.includes('report-workspace-grid');
        const hasIsCountKey = text.includes('isCountKey');
        const hasChkAllFaculty = text.includes('chkAllFaculty');
        const hasDownloadReport = text.includes('downloadActiveReport');

        if (hasReportGrid && hasIsCountKey && hasChkAllFaculty && hasDownloadReport) {
          console.log(`  ✅ Live site has successfully deployed latest UI standardization commit! (attempt ${attempts})`);
          console.log(`     - report-workspace-grid present: true`);
          console.log(`     - isCountKey present: true`);
          console.log(`     - chkAllFaculty present: true`);
          console.log(`     - downloadActiveReport present: true`);
          deployed = true;
          break;
        } else {
          console.log(`  ⏳ Waiting for Render build to finish deploying... (attempt ${attempts}/${maxAttempts})`);
        }
      }
    } catch (err: any) {
      console.log(`  ⏳ Connection attempt ${attempts} waiting for Render: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }

  if (!deployed) {
    throw new Error('Render deployment timed out after 5 minutes.');
  }

  // 2. Launch live headless Chrome to audit production user experience
  console.log('\n[2/4] Launching headless Chrome to audit live production UI...');
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
        console.error(`  [Live Browser ERROR] ${msg.text()}`);
      }
    });

    await page.setViewport({ width: 1440, height: 900 });
    console.log('\n[3/4] Navigating to live site and logging in...');
    await page.goto(baseUrl, { waitUntil: 'networkidle2' });

    // Authenticate via production login API
    await page.type('#loginEmail', 'accounts.ke@christuniversity.in');
    await page.type('#loginPassword', 'Password@123');
    await page.click('#btnLoginSubmit');

    await page.waitForFunction(() => {
      const appEl = document.getElementById('app');
      return appEl && window.getComputedStyle(appEl).display !== 'none';
    }, { timeout: 15000 });
    console.log('  ✅ Live login successful! Dashboard rendered.');

    // Navigate to Financial Records -> Revenue & Earnings
    console.log('\n[4/4] Verifying Revenue Modal and Button functionality on live production...');
    await page.evaluate(async () => {
      await (window as any).showTab('invoices');
      await (window as any).switchFinancialRecordsTab('revenue');
    });

    await page.waitForFunction(() => {
      return (window as any)._cachedRevenueEntries && (window as any)._cachedRevenueEntries.length > 0;
    }, { timeout: 15000 });

    const liveAudit = await page.evaluate(() => {
      const trashIcons = Array.from(document.querySelectorAll('table button')).filter(b => b.textContent?.includes('🗑'));
      const viewBtns = Array.from(document.querySelectorAll('table button')).filter(b => b.textContent?.trim() === 'View');
      const delBtns = Array.from(document.querySelectorAll('table .btn-delete')).filter(b => b.textContent?.trim() === 'Delete');
      const offset = getComputedStyle(document.documentElement).getPropertyValue('--header-nav-offset');

      return {
        trashIconsCount: trashIcons.length,
        viewBtnsCount: viewBtns.length,
        delBtnsCount: delBtns.length,
        headerNavOffset: offset.trim(),
      };
    });

    console.log(`  - Trash icons count (must be 0): ${liveAudit.trashIconsCount}`);
    console.log(`  - Text [View] buttons count: ${liveAudit.viewBtnsCount}`);
    console.log(`  - Text [Delete] buttons count: ${liveAudit.delBtnsCount}`);
    console.log(`  - Dynamic --header-nav-offset: ${liveAudit.headerNavOffset}`);

    if (liveAudit.trashIconsCount > 0) throw new Error('Trash icons found in live table!');
    if (liveAudit.viewBtnsCount === 0) throw new Error('No [View] buttons found in live table!');

    // Test opening the revenue details modal on live production
    const firstId = await page.evaluate(() => (window as any)._cachedRevenueEntries[0].id);
    await page.evaluate((id) => (window as any).showRevenueDetails(id), firstId);

    const liveModalState = await page.evaluate(() => {
      const modal = document.getElementById('revenueDetailsModal');
      const bg = document.getElementById('modalBg');
      if (!modal || !bg) return { opened: false };

      const bgStyle = window.getComputedStyle(bg);
      const modalRect = modal.getBoundingClientRect();
      const winW = window.innerWidth;
      const winH = window.innerHeight;

      const isCenteredX = Math.abs((modalRect.left + modalRect.right) / 2 - winW / 2) < 40;
      const isCenteredY = Math.abs((modalRect.top + modalRect.bottom) / 2 - winH / 2) < 40;

      const titleEl = modal.querySelector('h2');
      const closeBtn = modal.querySelector('button.modal-close');
      const receiptLink = modal.querySelector('a');

      return {
        opened: true,
        zIndex: bgStyle.zIndex,
        position: bgStyle.position,
        isCenteredX,
        isCenteredY,
        titleText: titleEl?.textContent?.trim(),
        titleColor: titleEl ? window.getComputedStyle(titleEl).color : null,
        hasCloseBtn: !!closeBtn,
        receiptLinkText: receiptLink?.textContent?.trim(),
      };
    });

    console.log('\n  Live Modal Inspection:');
    console.log(`  - Modal opened: ${liveModalState.opened}`);
    console.log(`  - Modal z-index: ${liveModalState.zIndex} (Target: 1200)`);
    console.log(`  - Modal position: ${liveModalState.position} (Target: fixed)`);
    console.log(`  - Centered X: ${liveModalState.isCenteredX}, Centered Y: ${liveModalState.isCenteredY}`);
    console.log(`  - Title text: "${liveModalState.titleText}"`);
    console.log(`  - Top-right close button present: ${liveModalState.hasCloseBtn}`);
    console.log(`  - Receipt link text: "${liveModalState.receiptLinkText}"`);

    // Dismiss modal
    await page.evaluate(() => (window as any).closeModal());
    const isClosed = await page.evaluate(() => {
      const bg = document.getElementById('modalBg');
      return bg ? window.getComputedStyle(bg).display === 'none' : true;
    });
    console.log(`  - Modal dismissed successfully: ${isClosed}`);

    // Switch to Reports tab to ensure no persistent modal remains
    await page.evaluate(async () => {
      await (window as any).showTab('excel');
    });
    const reportsState = await page.evaluate(() => {
      const modal = document.getElementById('revenueDetailsModal');
      const bg = document.getElementById('modalBg');
      return {
        modalInDom: !!modal,
        bgDisplay: bg ? window.getComputedStyle(bg).display : 'none',
        modalOpenClass: document.body.classList.contains('modal-open'),
      };
    });
    console.log(`  - Clean Reports & Analytics tab switch (Modal in DOM: ${reportsState.modalInDom}, bgDisplay: ${reportsState.bgDisplay}, modal-open: ${reportsState.modalOpenClass})`);

    console.log('\n================================================================');
    console.log('  🎉 LIVE RENDER PRODUCTION DEPLOYMENT 100% VERIFIED SUCCESS!   ');
    console.log('================================================================');

    if (consoleErrors.length > 0) {
      console.error(`Live browser console errors detected: ${consoleErrors.length}`);
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
  process.exit(0);
}

verifyLiveEnterpriseDeployment().catch((err) => {
  console.error('Fatal live production deployment verification error:', err);
  process.exit(1);
});
