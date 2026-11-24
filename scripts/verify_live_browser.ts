import puppeteer from 'puppeteer-core';

async function verifyLiveBrowser() {
  console.log('Testing live production site https://nfa-system.onrender.com in Chrome...');
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
        console.error(`[Live Console Error] ${msg.text()}`);
        consoleErrors.push(msg.text());
      }
    });

    // 1. Mobile viewport (375x667)
    await page.setViewport({ width: 375, height: 667 });
    await page.goto('https://nfa-system.onrender.com', { waitUntil: 'networkidle2' });

    const mobileMetrics = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth;
      const winW = window.innerWidth;
      const hasOverflow = docW > winW + 1;
      const labelText = document.querySelector('label[for="loginEmail"]')?.textContent || '';
      return { docW, winW, hasOverflow, labelText };
    });

    console.log(`Mobile (375px): winW=${mobileMetrics.winW}, docW=${mobileMetrics.docW}, overflow=${mobileMetrics.hasOverflow}, label="${mobileMetrics.labelText}"`);

    // 2. Desktop viewport (1440x900)
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto('https://nfa-system.onrender.com', { waitUntil: 'networkidle2' });

    const desktopMetrics = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth;
      const winW = window.innerWidth;
      const hasOverflow = docW > winW + 1;
      const mainEl = document.querySelector('main');
      const maxW = mainEl ? window.getComputedStyle(mainEl).maxWidth : '';
      return { docW, winW, hasOverflow, maxW };
    });

    console.log(`Desktop (1440px): winW=${desktopMetrics.winW}, docW=${desktopMetrics.docW}, overflow=${desktopMetrics.hasOverflow}, mainMaxW=${desktopMetrics.maxW}`);

    console.log(`Total live console errors: ${consoleErrors.length}`);
    if (consoleErrors.length > 0 || mobileMetrics.hasOverflow || desktopMetrics.hasOverflow) {
      console.error('❌ Live production verification failed!');
      process.exit(1);
    }

    console.log('🎉 LIVE PRODUCTION VERIFICATION 100% PASSED!');
    process.exit(0);
  } finally {
    await browser.close();
  }
}

verifyLiveBrowser().catch((e) => {
  console.error('Fatal live browser error:', e);
  process.exit(1);
});
