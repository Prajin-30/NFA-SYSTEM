import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';

interface AuditCheck {
  id: string;
  name: string;
  passed: boolean;
  details: string;
}

const checks: AuditCheck[] = [];
function record(id: string, name: string, passed: boolean, details: string) {
  checks.push({ id, name, passed, details });
  console.log(`  ${passed ? '✅ PASS' : '❌ FAIL'}: [${id}] ${name} - ${details}`);
}

async function runReportLayoutAudit() {
  console.log('================================================================');
  console.log('  CU-NFA REPORT GENERATION LAYOUT, CONTROLS & FORMATTING AUDIT  ');
  console.log('================================================================\n');

  if (process.env.DATA_SOURCE !== 'json') {
    try {
      if (store.initPromise) {
        await store.initPromise;
      }
      await store.loadFromPostgres();
    } catch {}
  }

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const port = address.port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`Ephemeral test server listening on ${baseUrl}`);

  const tempUserDataDir = path.join(os.tmpdir(), `cu_nfa_rep_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    userDataDir: tempUserDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  try {
    const adminUser = store.data.users.find((u) => u.role === 'super_admin');
    if (!adminUser) throw new Error('Super admin user not found');
    const token = signToken(adminUser);

    await page.goto(baseUrl, { waitUntil: 'networkidle2' });
    await page.evaluate((tok, usr) => {
      localStorage.setItem('token', tok);
      localStorage.setItem('user', JSON.stringify({ ...usr, must_change_password: false }));
    }, token, adminUser);
    await page.goto(baseUrl, { waitUntil: 'networkidle2' });

    await page.waitForFunction(() => {
      const appEl = document.getElementById('app');
      return appEl && window.getComputedStyle(appEl).display !== 'none';
    }, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 600));

    // 1. Verify Fixed Header & Navigation on Scroll
    console.log('\n--- 1. AUDITING FIXED HEADER & NAVIGATION STACKING ---');
    const headerInitialPos = await page.evaluate(() => {
      const headerWrap = document.getElementById('app-header-wrap');
      const footer = document.getElementById('app-footer');
      if (!headerWrap || !footer) return null;
      const hRect = headerWrap.getBoundingClientRect();
      const fRect = footer.getBoundingClientRect();
      return {
        headerTop: hRect.top,
        headerHeight: hRect.height,
        footerBottom: window.innerHeight - fRect.bottom,
        headerZIndex: window.getComputedStyle(headerWrap).zIndex,
        headerPos: window.getComputedStyle(headerWrap).position
      };
    });

    record('HDR-01', 'Header wrapper fixed position', headerInitialPos?.headerPos === 'fixed', `Position: ${headerInitialPos?.headerPos}`);
    record('HDR-02', 'Header wrapper top: 0 and z-index: 1000', headerInitialPos?.headerTop === 0 && headerInitialPos?.headerZIndex === '1000', `Top: ${headerInitialPos?.headerTop}, z-index: ${headerInitialPos?.headerZIndex}`);

    // Scroll 400px down and re-verify header stays fixed at top: 0
    await page.evaluate(() => window.scrollTo(0, 400));
    await new Promise((r) => setTimeout(r, 200));

    const headerScrolledPos = await page.evaluate(() => {
      const headerWrap = document.getElementById('app-header-wrap');
      if (!headerWrap) return null;
      const hRect = headerWrap.getBoundingClientRect();
      return { headerTop: hRect.top };
    });
    record('HDR-03', 'Header wrapper remains fixed at top: 0 on scroll', headerScrolledPos?.headerTop === 0, `Scrolled Top: ${headerScrolledPos?.headerTop}`);

    // Return to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 200));

    // 2. Navigate to Reports & Analytics -> Report Generation
    console.log('\n--- 2. NAVIGATING TO REPORTS & ANALYTICS -> REPORT GENERATION ---');
    await page.evaluate(async () => {
      await (window as any).showTab('excel');
      await (window as any).switchReportsAnalyticsTab('reports');
    });
    await new Promise((r) => setTimeout(r, 600));

    // 3. Select Faculty-wise NFA Activity Report
    console.log('\n--- 3. SELECTING FACULTY-WISE NFA ACTIVITY REPORT ---');
    await page.evaluate(async () => {
      await (window as any).selectReportType('faculty_nfa');
    });
    await new Promise((r) => setTimeout(r, 1200));

    // 4. Inspect Workspace Grid Geometry
    console.log('\n--- 4. AUDITING REPORT WORKSPACE GEOMETRY ---');
    const layoutGeometry = await page.evaluate(() => {
      const grid = document.querySelector('.report-workspace-grid') as HTMLElement;
      const sidebar = document.querySelector('.report-catalogue-sidebar') as HTMLElement;
      const workspace = sidebar ? (sidebar.nextElementSibling as HTMLElement) : null;
      if (!grid || !sidebar || !workspace) {
        return { error: 'Grid, sidebar or workspace column missing' };
      }

      const previewTable = workspace.querySelector('.table-wrap table') as HTMLElement;
      const allSpans = Array.from(workspace.querySelectorAll('span'));
      const countBanner = allSpans.find(s => s.textContent && s.textContent.includes('records'));

      const gridRect = grid.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      const wsRect = workspace.getBoundingClientRect();
      const tableRect = previewTable ? previewTable.getBoundingClientRect() : null;

      const isTableInsideWorkspace = workspace.contains(previewTable);

      return {
        gridDisplay: window.getComputedStyle(grid).display,
        sidebarLeft: sidebarRect.left,
        sidebarRight: sidebarRect.right,
        sidebarWidth: sidebarRect.width,
        workspaceLeft: wsRect.left,
        workspaceWidth: wsRect.width,
        isSideBySide: wsRect.left >= sidebarRect.right - 5,
        isTableInsideWorkspace,
        tableTop: tableRect ? tableRect.top : 0,
        tableLeft: tableRect ? tableRect.left : 0,
        countBannerText: countBanner ? countBanner.textContent?.trim() : ''
      };
    });

    record('GEO-01', 'Report grid displays side-by-side columns', layoutGeometry.isSideBySide === true, `Sidebar Right: ${layoutGeometry.sidebarRight}, Workspace Left: ${layoutGeometry.workspaceLeft}`);
    record('GEO-02', 'Preview table rendered inside right workspace column', layoutGeometry.isTableInsideWorkspace === true, `Table inside workspace: ${layoutGeometry.isTableInsideWorkspace}`);

    // Switch to Department scope to verify entity dropdown presence
    await page.evaluate(async () => {
      await (window as any).onReportScopeChange('department');
    });
    await new Promise((r) => setTimeout(r, 600));

    // 5. Audit Report Controls Presence
    console.log('\n--- 5. AUDITING CONTROLS (SCOPE, ENTITY, FY, BUTTONS) ---');
    const controlsAudit = await page.evaluate(() => {
      const workspace = document.querySelector('.report-catalogue-sidebar')?.nextElementSibling as HTMLElement;
      const scopeButtons = Array.from(workspace?.querySelectorAll('button') || [])
        .filter(b => b.getAttribute('onclick')?.includes('onReportScopeChange'))
        .map(b => b.textContent?.trim() || '');

      const entityDropdown = document.getElementById('reportDeptSelect') || document.getElementById('reportSchoolSelect') || document.getElementById('reportCentreSelect');
      const fyDropdown = document.getElementById('reportFySelect');
      const allButtons = Array.from(workspace?.querySelectorAll('button') || []);
      const refreshBtn = allButtons.find(b => b.textContent?.includes('Refresh Preview'));
      const pdfBtn = allButtons.find(b => b.textContent?.includes('Download PDF'));
      const excelBtn = allButtons.find(b => b.textContent?.includes('Download Excel'));
      const facultyToggle = document.getElementById('chkAllFaculty');

      return {
        scopeOptions: scopeButtons,
        hasEntityDropdown: Boolean(entityDropdown),
        hasFyDropdown: Boolean(fyDropdown),
        hasRefreshBtn: Boolean(refreshBtn),
        hasPdfBtn: Boolean(pdfBtn),
        hasExcelBtn: Boolean(excelBtn),
        hasFacultyToggle: Boolean(facultyToggle),
        pdfBtnText: pdfBtn ? pdfBtn.textContent?.trim() : '',
        excelBtnText: excelBtn ? excelBtn.textContent?.trim() : ''
      };
    });

    record('CTL-01', 'Scope selection options present (Campus, School-Wise, Department, Centres / Offices)', controlsAudit.scopeOptions.some(s => s.toLowerCase().includes('campus')) && controlsAudit.scopeOptions.some(s => s.toLowerCase().includes('department')), `Scopes: ${controlsAudit.scopeOptions.join(', ')}`);
    record('CTL-02', 'Entity & Academic Year dropdowns present', controlsAudit.hasEntityDropdown && controlsAudit.hasFyDropdown, `Entity Dropdown: ${controlsAudit.hasEntityDropdown}, FY Dropdown: ${controlsAudit.hasFyDropdown}`);
    record('CTL-03', 'Action buttons present (Refresh, PDF, Excel)', controlsAudit.hasRefreshBtn && controlsAudit.hasPdfBtn && controlsAudit.hasExcelBtn, `PDF: ${controlsAudit.pdfBtnText}, Excel: ${controlsAudit.excelBtnText}`);
    record('CTL-04', 'Faculty-specific 0-proposals toggle present', controlsAudit.hasFacultyToggle, `Faculty Toggle: ${controlsAudit.hasFacultyToggle}`);

    // 6. Audit Number Formatting in Preview Table
    console.log('\n--- 6. AUDITING NUMBER FORMATTING IN FACULTY REPORT PREVIEW ---');
    const formattingAudit = await page.evaluate(() => {
      const workspace = document.querySelector('.report-catalogue-sidebar')?.nextElementSibling as HTMLElement;
      const headers = Array.from(workspace?.querySelectorAll('table th') || []).map(th => th.textContent?.trim() || '');
      const rows = Array.from(workspace?.querySelectorAll('table tbody tr') || []).map(tr => {
        return Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
      });

      const approvedIdx = headers.findIndex(h => h.toLowerCase().includes('approved') && !h.toLowerCase().includes('amount'));
      const pendingIdx = headers.findIndex(h => h.toLowerCase().includes('pending') && !h.toLowerCase().includes('amount'));
      const submittedIdx = headers.findIndex(h => h.toLowerCase().includes('submitted'));

      const sampleApprovedValues = rows.slice(0, 5).map(r => r[approvedIdx]);
      const samplePendingValues = rows.slice(0, 5).map(r => r[pendingIdx]);

      // Count values must NOT contain ₹ or Rs.
      const hasRupeeInApproved = sampleApprovedValues.some(v => v && (v.includes('₹') || v.includes('Rs.')));
      const hasRupeeInPending = samplePendingValues.some(v => v && (v.includes('₹') || v.includes('Rs.')));

      return {
        headers,
        approvedIdx,
        pendingIdx,
        sampleApprovedValues,
        samplePendingValues,
        hasRupeeInApproved,
        hasRupeeInPending,
        rowCount: rows.length
      };
    });

    record('FMT-01', 'Total Approved column has no currency rupee symbol', !formattingAudit.hasRupeeInApproved, `Values: ${formattingAudit.sampleApprovedValues.join(', ')}`);
    record('FMT-02', 'Total Pending column has no currency rupee symbol', !formattingAudit.hasRupeeInPending, `Values: ${formattingAudit.samplePendingValues.join(', ')}`);
    const bannerText = ('countBannerText' in layoutGeometry && typeof layoutGeometry.countBannerText === 'string')
      ? layoutGeometry.countBannerText
      : '';
    record('FMT-03', 'Record count banner verified', Boolean(bannerText && (bannerText.includes('records') || bannerText.includes('total'))), `Banner: "${bannerText}"`);

    // 7. Audit Absence of Decorative Emojis on Settings Page
    console.log('\n--- 7. AUDITING SETTINGS PAGE FOR ZERO EMOJIS ---');
    await page.evaluate(() => {
      (window as any).showTab('admin');
    });
    await new Promise((r) => setTimeout(r, 600));

    const settingsAudit = await page.evaluate(() => {
      const text = document.getElementById('main')?.innerHTML || '';
      const forbiddenEmojis = ['✉️', '📨', '🚀', '📑', '📦', '✍️', '📊', '🏫'];
      const foundEmojis = forbiddenEmojis.filter(e => text.includes(e));

      // Also check buttons
      const buttons = Array.from(document.querySelectorAll('#main button')).map(b => b.textContent?.trim() || '');
      const arrowsInButtons = buttons.filter(b => b.includes('→') || b.includes('←'));

      return {
        foundEmojis,
        arrowsInButtons
      };
    });

    record('STG-01', 'Zero forbidden emojis on Settings page', settingsAudit.foundEmojis.length === 0, `Found: ${settingsAudit.foundEmojis.join(', ') || 'None'}`);
    record('STG-02', 'Zero arrow symbols in Settings buttons', settingsAudit.arrowsInButtons.length === 0, `Found: ${settingsAudit.arrowsInButtons.join(', ') || 'None'}`);

    // Take screenshot of Report Generation
    await page.evaluate(async () => {
      await (window as any).showTab('excel');
      await (window as any).switchReportsAnalyticsTab('reports');
      await (window as any).selectReportType('faculty_nfa');
    });
    await new Promise((r) => setTimeout(r, 800));

    const screenshotDir = 'C:\\Users\\Prajin\\.gemini\\antigravity\\brain\\1cdef37b-f366-4206-8f40-960bf5bbfb15';
    const screenshotPath = path.join(screenshotDir, 'report_generation_verified_layout.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`\n📸 Screenshot captured and saved to: ${screenshotPath}`);

    // Summary
    console.log('\n================================================================');
    const passedCount = checks.filter(c => c.passed).length;
    const failedCount = checks.filter(c => !c.passed).length;
    console.log(`  REPORT LAYOUT AUDIT RESULTS: ${passedCount} PASSED / ${failedCount} FAILED (TOTAL ${checks.length})`);
    console.log('================================================================\n');

    record('CON-01', 'Zero console errors during browser execution', consoleErrors.length === 0, `Errors: ${consoleErrors.join(' | ') || 'None'}`);

    if (failedCount > 0 || consoleErrors.length > 0) {
      process.exit(1);
    }
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(0);
}

runReportLayoutAudit().catch((err) => {
  console.error('Fatal report audit error:', err);
  process.exit(1);
});
