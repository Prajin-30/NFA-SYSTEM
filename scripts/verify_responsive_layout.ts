import http from 'http';
import puppeteer from 'puppeteer-core';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';

interface ViewportResult {
  width: number;
  height: number;
  name: string;
  horizontalOverflow: boolean;
  docScrollWidth: number;
  innerWidth: number;
  mainMaxWidth: string;
  grid4Columns: number;
  consoleErrors: string[];
  passed: boolean;
}

const VIEWPORTS = [
  { width: 320, height: 568, name: 'Mobile XS (iPhone SE 1st gen)' },
  { width: 375, height: 667, name: 'Mobile S (iPhone 8/SE 2nd gen)' },
  { width: 390, height: 844, name: 'Mobile M (iPhone 12/13/14)' },
  { width: 430, height: 932, name: 'Mobile L (iPhone 14/15 Pro Max)' },
  { width: 768, height: 1024, name: 'Tablet Portrait (iPad Mini/Air)' },
  { width: 1024, height: 768, name: 'Tablet Landscape / Small Laptop' },
  { width: 1280, height: 800, name: 'Standard Laptop (1280x800)' },
  { width: 1366, height: 768, name: 'Standard Desktop / HD (1366x768)' },
  { width: 1440, height: 900, name: 'MacBook Pro 15/16 Retina (1440x900)' },
  { width: 1920, height: 1080, name: 'Full HD Desktop (1080p)' },
  { width: 2560, height: 1440, name: 'QHD / 2K Display (1440p)' },
];

async function runResponsiveAudit() {
  console.log('================================================================');
  console.log('   CU-NFA 11-VIEWPORT RESPONSIVE LAYOUT & FLUID AUDIT SUITE    ');
  console.log('================================================================\n');

  // Start local server on random port
  await store.loadFromPostgres();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const superAdmin = store.data.users.find((u) => u.role === 'super_admin');
  if (!superAdmin) throw new Error('Super Admin user not found');
  const token = signToken(superAdmin as any);

  const results: ViewportResult[] = [];
  let allPassed = true;

  try {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
      console.log(`[Browser Console ${msg.type().toUpperCase()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      console.error('[Browser Uncaught Error]', err);
    });

    for (const vp of VIEWPORTS) {
      console.log(`\n--- Testing Viewport: ${vp.width}x${vp.height} (${vp.name}) ---`);
      await page.setViewport({ width: vp.width, height: vp.height });
      await page.goto(baseUrl, { waitUntil: 'networkidle2' });

      // 1. Audit login view layout at this viewport
      const loginLayout = await page.evaluate(() => {
        const docW = document.documentElement.scrollWidth;
        const winW = window.innerWidth;
        const loginCard = document.querySelector('.login-box, .auth-card') as HTMLElement;
        const cardW = loginCard ? loginCard.getBoundingClientRect().width : 0;
        return {
          docW,
          winW,
          hasOverflow: docW > winW + 1, // allow 1px sub-pixel tolerance
          cardW,
        };
      });

      console.log(`  Login Page: innerWidth=${loginLayout.winW}px, scrollWidth=${loginLayout.docW}px, cardWidth=${loginLayout.cardW.toFixed(1)}px`);
      if (loginLayout.hasOverflow) {
        console.error(`  ❌ Horizontal overflow detected on login page at ${vp.width}px!`);
        allPassed = false;
      } else {
        console.log(`  ✅ Zero horizontal overflow on login page.`);
      }

      // 2. Set auth in localStorage and reload page so boot() executes naturally
      await page.evaluate((tok, usr) => {
        localStorage.setItem('token', tok);
        localStorage.setItem('user', JSON.stringify({ ...usr, must_change_password: false }));
      }, token, superAdmin);
      await page.goto(baseUrl, { waitUntil: 'networkidle2' });

      // Wait for app view to show
      await page.waitForFunction(() => {
        const appEl = document.getElementById('appView') || document.getElementById('app');
        return appEl && window.getComputedStyle(appEl).display !== 'none';
      }, { timeout: 10000 });

      // Evaluate main layout, grid-4 columns, main max-width, overflow
      const appMetrics = await page.evaluate(() => {
        const docW = document.documentElement.scrollWidth;
        const winW = window.innerWidth;
        const mainEl = document.querySelector('main');
        const mainStyle = mainEl ? window.getComputedStyle(mainEl) : null;
        const mainW = mainEl ? mainEl.getBoundingClientRect().width : 0;
        const mainMaxW = mainStyle ? mainStyle.maxWidth : 'none';

        // Check grid-4 computed template columns
        const grid4 = document.querySelector('.grid-4');
        let colCount = 0;
        if (grid4) {
          const style = window.getComputedStyle(grid4);
          const cols = style.gridTemplateColumns.split(' ').filter(Boolean);
          colCount = cols.length;
        }

        // Check stat-card amount nowrap and tabular-nums
        const statVals = Array.from(document.querySelectorAll('.stat-val'));
        let statValsCompliant = true;
        for (const sv of statVals) {
          const s = window.getComputedStyle(sv);
          if (s.whiteSpace !== 'nowrap' || !s.fontVariantNumeric.includes('tabular-nums')) {
            statValsCompliant = false;
          }
        }

        return {
          docW,
          winW,
          hasOverflow: docW > winW + 1,
          mainW,
          mainMaxW,
          colCount,
          statValsCompliant,
        };
      });

      console.log(`  App Dashboard: innerWidth=${appMetrics.winW}px, scrollWidth=${appMetrics.docW}px, mainWidth=${appMetrics.mainW.toFixed(1)}px, mainMaxWidth=${appMetrics.mainMaxW}`);
      console.log(`  Grid-4 Column Count: ${appMetrics.colCount}`);
      console.log(`  Stat Values Compliant: ${appMetrics.statValsCompliant}`);

      // Expected columns based on width
      let expectedCols = 4;
      if (vp.width <= 640) expectedCols = 1;
      else if (vp.width <= 1100) expectedCols = 2;
      else expectedCols = 4;

      const vpPassed = !appMetrics.hasOverflow &&
        (appMetrics.colCount === 0 || appMetrics.colCount === expectedCols) &&
        appMetrics.statValsCompliant &&
        consoleErrors.length === 0;

      if (!vpPassed) {
        if (appMetrics.hasOverflow) console.error(`  ❌ Horizontal overflow detected on app page!`);
        if (appMetrics.colCount !== expectedCols && appMetrics.colCount !== 0) {
          console.error(`  ❌ Grid-4 column count mismatch: expected ${expectedCols}, got ${appMetrics.colCount}!`);
        }
        allPassed = false;
      } else {
        console.log(`  ✅ Viewport ${vp.width}x${vp.height} fully compliant (4/2/1 balanced grid, fluid width, zero overflow).`);
      }

      results.push({
        width: vp.width,
        height: vp.height,
        name: vp.name,
        horizontalOverflow: appMetrics.hasOverflow,
        docScrollWidth: appMetrics.docW,
        innerWidth: appMetrics.winW,
        mainMaxWidth: appMetrics.mainMaxW,
        grid4Columns: appMetrics.colCount,
        consoleErrors: [...consoleErrors],
        passed: vpPassed,
      });

      // Reset session / clear localStorage for next viewport
      await page.evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
          (window as any).TOKEN = '';
          (window as any).USER = null;
        } catch {}
      });
    }

    console.log('\n================================================================');
    console.log('                 11-VIEWPORT AUDIT SUMMARY                      ');
    console.log('================================================================');
    for (const r of results) {
      console.log(`  ${r.passed ? '✅ PASS' : '❌ FAIL'}: ${r.width}x${r.height} (${r.name}) | Overflow: ${r.horizontalOverflow ? 'YES' : 'NO'} | Cols: ${r.grid4Columns} | mainMaxW: ${r.mainMaxWidth}`);
    }
    console.log('================================================================\n');

    if (!allPassed) {
      process.exit(1);
    }
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(0);
}

runResponsiveAudit().catch((err) => {
  console.error('Fatal responsive audit error:', err);
  process.exit(1);
});
