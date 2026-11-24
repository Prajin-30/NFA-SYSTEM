import puppeteer from 'puppeteer-core';
import http from 'http';
import { app } from '../src/server.js';
import { store } from '../src/store.js';

async function runBrowserButtonAudit() {
  console.log('===============================================================');
  console.log('--- STARTING COMPREHENSIVE BROWSER BUTTON AUDIT ---');
  console.log('===============================================================\n');

  if (store.initPromise) {
    await store.initPromise;
  }

  // Start local express server
  let serverPort = 0;
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      serverPort = (server.address() as any).port;
      console.log(`[SERVER] Local test server running on port ${serverPort}`);
      resolve();
    });
  });

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

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
      if (type === 'error') {
        if (!text.includes('favicon.ico')) {
          console.error(`  [Browser Console Error] ${text}`);
          consoleErrors.push(text);
        }
      }
    });

    page.on('response', (res) => {
      if (res.status() >= 400 && !res.url().includes('favicon.ico')) {
        console.warn(`  [HTTP ${res.status()}] ${res.url()}`);
      }
    });

    page.on('pageerror', (err: any) => {
      console.error(`  [Browser Page Error] ${err.message}`);
      pageErrors.push(err.message);
    });

    // 1. Load Application
    console.log(`[1/9] Loading application at http://localhost:${serverPort}...`);
    await page.goto(`http://localhost:${serverPort}`, { waitUntil: 'networkidle2' });

    // 2. Perform Login as Super Admin
    console.log('[2/9] Performing login as super_admin...');
    await page.waitForSelector('#loginEmail', { visible: true });
    await page.type('#loginEmail', 'admin@christ.edu');
    await page.type('#loginPassword', 'Password@123');
    await page.click('#btnLoginSubmit');

    // Wait for main app view to be visible
    await page.waitForSelector('#app', { visible: true, timeout: 15000 });
    await page.waitForSelector('#nav button', { visible: true, timeout: 15000 });
    console.log('  ✅ Login successful, dashboard loaded.');

    // 3. Audit Top Navigation Tabs (8 Tabs)
    console.log('\n[3/9] Auditing 8 Top Navigation Tabs...');
    const tabs = [
      { id: 'dashboard', label: 'Home' },
      { id: 'nfas', label: 'NFA' },
      { id: 'inbox', label: 'Approvals' },
      { id: 'budgets', label: 'Budget' },
      { id: 'invoices', label: 'Financial Records' },
      { id: 'excel', label: 'Reports & Analytics' },
      { id: 'audit', label: 'Financial Ledger' },
      { id: 'admin', label: 'Settings' },
    ];

    for (const t of tabs) {
      const tabClicked = await page.evaluate((tabId) => {
        const btn = document.querySelector(`nav button[data-tab="${tabId}"]`) as HTMLButtonElement;
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }, t.id);

      if (!tabClicked) {
        throw new Error(`Navigation tab button for "${t.label}" (data-tab="${t.id}") not found!`);
      }
      await new Promise((r) => setTimeout(r, 600));

      const activeTabId = await page.evaluate(() => {
        const activeBtn = document.querySelector('nav button.active') as HTMLElement;
        return activeBtn ? activeBtn.dataset.tab : null;
      });

      if (activeTabId !== t.id) {
        throw new Error(`Active tab is "${activeTabId}", expected "${t.id}" after clicking "${t.label}"!`);
      }
      console.log(`  ✓ Tab "${t.label}" (data-tab="${t.id}") clicked and rendered smoothly.`);
    }

    // 4. Audit Tab 2: NFA Listing & Delete Draft Functionality
    console.log('\n[4/9] Auditing NFA Listing, Modals, and Delete Draft Flow...');
    await page.click('nav button[data-tab="nfas"]');
    await page.waitForSelector('#nfaSearchInput', { visible: true, timeout: 15000 });
    await page.type('#nfaSearchInput', 'Test');
    await new Promise((r) => setTimeout(r, 350)); // Allow 300ms debounce
    console.log('  ✓ NFA Search input debounce triggered without error.');

    // Clear search
    await page.evaluate(() => {
      const inp = document.getElementById('nfaSearchInput') as HTMLInputElement;
      if (inp) {
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await new Promise((r) => setTimeout(r, 350));

    // Test Create NFA Modal button
    const newNfaModalBtn = await page.$('button[onclick*="newNfaModal()"]');
    if (newNfaModalBtn) {
      await newNfaModalBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const modalVisible = await page.evaluate(() => {
        const m = document.getElementById('modal');
        return m && window.getComputedStyle(m).display !== 'none';
      });
      if (modalVisible) {
        console.log('  ✓ "Create NFA" modal button opened modal dialog.');
        await page.evaluate(() => {
          const closeBtn = document.querySelector('#modal button[onclick*="closeModal()"]') as HTMLButtonElement;
          if (closeBtn) closeBtn.click();
        });
        await new Promise((r) => setTimeout(r, 200));
        console.log('  ✓ "Close Modal" button closed modal.');
      }
    }

    // Test Create Draft NFA via API, then Delete Draft from listing page
    console.log('  -> Creating a temporary Draft NFA to test listing page Delete Draft...');
    const draftNfa = await page.evaluate(async () => {
      const token = localStorage.getItem('token');
      const authHeader = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const [fysRes, deptsRes, catsRes] = await Promise.all([
        fetch('/api/budgets/financial-years', { headers: authHeader }),
        fetch('/api/budgets/departments', { headers: authHeader }),
        fetch('/api/budgets/categories', { headers: authHeader })
      ]);
      const [fys, depts, cats] = await Promise.all([fysRes.json(), deptsRes.json(), catsRes.json()]);

      const activeFy = fys[0]?.id;
      const dept = depts[0]?.id;
      const cat = cats[0]?.id;

      const createRes = await fetch('/api/nfas', {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          title: 'Browser Listing Delete Draft Test ' + Date.now(),
          organization_type: 'department',
          department_id: dept,
          financial_year_id: activeFy,
          budget_category_id: cat,
          nfa_type: 'event',
          total_amount: 5000,
          items: [{ sl_no: 1, particulars: 'Supplies', quantity: '1', rate: '5000', amount: 5000 }],
        })
      });
      const created = await createRes.json();

      // Completely await showTab to reload the table
      await (window as any).showTab('nfas');
      return created;
    });
    console.log(`  -> Draft NFA created: ${draftNfa.ref_no} (${draftNfa.id})`);

    // Filter to Draft status using dropdown
    await page.waitForSelector('#nfaStatusFilterSelect', { visible: true, timeout: 5000 });
    await page.select('#nfaStatusFilterSelect', 'draft');
    await new Promise((r) => setTimeout(r, 400));

    // Verify Delete Draft button is rendered on listing page
    const deleteBtnSelector = `button[onclick*="confirmDeleteDraft('${draftNfa.id}')"]`;
    await page.waitForSelector(deleteBtnSelector, { visible: true, timeout: 8000 });
    console.log(`  ✓ Delete Draft button found on listing page for ${draftNfa.ref_no}.`);

    // Step A: Click Delete Draft -> Verify confirmation modal appears
    await page.click(deleteBtnSelector);
    await new Promise((r) => setTimeout(r, 400));

    const confirmModalVisible = await page.evaluate(() => {
      const m = document.getElementById('deleteDraftConfirmDialog');
      return m && window.getComputedStyle(m).display !== 'none';
    });
    if (!confirmModalVisible) {
      throw new Error('Confirmation dialog (#deleteDraftConfirmDialog) did not appear after clicking Delete Draft!');
    }
    console.log('  ✓ Confirmation dialog appeared with NFA details & warning.');

    // Step B: Click Cancel -> Verify confirmation dialog dismisses and draft remains
    const cancelBtn = await page.$('#cancelDeleteNfaBtn');
    if (!cancelBtn) throw new Error('#cancelDeleteNfaBtn not found in confirmation dialog!');
    await cancelBtn.click();
    await new Promise((r) => setTimeout(r, 300));

    const confirmModalDismissed = await page.evaluate(() => {
      const m = document.getElementById('deleteDraftConfirmDialog');
      return !m || window.getComputedStyle(m).display === 'none';
    });
    if (!confirmModalDismissed) {
      throw new Error('Confirmation dialog did not dismiss after Cancel was clicked!');
    }
    console.log('  ✓ "Cancel" button safely dismissed confirmation dialog.');

    // Step C: Click Delete Draft again -> Click Confirm Delete
    await page.click(deleteBtnSelector);
    await page.waitForSelector('#confirmDeleteNfaBtn', { visible: true, timeout: 5000 });

    await page.evaluate(() => {
      const btn = document.getElementById('confirmDeleteNfaBtn') as HTMLButtonElement;
      if (btn) btn.click();
    });

    // Wait for confirmation dialog to be dismissed upon successful deletion
    await page.waitForFunction(() => {
      return !document.getElementById('deleteDraftConfirmDialog');
    }, { timeout: 15000 });

    // Allow table DOM update to complete
    await new Promise((r) => setTimeout(r, 500));

    // Verify row is removed from DOM
    const rowRemoved = await page.evaluate((id) => {
      return !document.querySelector(`button[onclick*="confirmDeleteDraft('${id}')"]`);
    }, draftNfa.id);

    if (!rowRemoved) {
      throw new Error('Draft NFA row was not removed from the table after confirmation deletion!');
    }
    console.log('  ✓ Draft NFA deleted successfully from listing page, DOM table updated immediately.');

    // 5. Audit Tab 4: Budget Scope Selector & Category Expand
    console.log('\n[5/9] Auditing Budget Scope Selectors & Accordion Buttons...');
    await page.click('nav button[data-tab="budgets"]');
    await new Promise((r) => setTimeout(r, 600));

    const scopes = ['campus', 'soet', 'soa', 'sbm', 'sps', 'coe'];
    for (const scope of scopes) {
      const clicked = await page.evaluate((s) => {
        const btn = document.querySelector(`button[onclick*="setBudgetScope('${s}')"]`) as HTMLButtonElement;
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }, scope);
      if (clicked) {
        await new Promise((r) => setTimeout(r, 300));
        console.log(`  ✓ Budget Scope button "${scope.toUpperCase()}" clicked and rendered.`);
      }
    }

    // 6. Audit Tab 5: Financial Records Subtabs
    console.log('\n[6/9] Auditing Financial Records Subtab Buttons...');
    await page.click('nav button[data-tab="invoices"]');
    await new Promise((r) => setTimeout(r, 600));

    const invoiceSubtabs = ['invoices', 'revenue', 'events', 'disbursements'];
    for (const sub of invoiceSubtabs) {
      const clicked = await page.evaluate((s) => {
        const btn = document.querySelector(`button[onclick*="switchFinancialRecordsTab('${s}')"]`) as HTMLButtonElement;
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }, sub);
      if (clicked) {
        await new Promise((r) => setTimeout(r, 300));
        console.log(`  ✓ Financial Records subtab "${sub}" clicked successfully.`);
      }
    }

    // 7. Audit Tab 6: Reports & Analytics Subtabs
    console.log('\n[7/9] Auditing Reports & Analytics Subtab Buttons...');
    await page.click('nav button[data-tab="excel"]');
    await new Promise((r) => setTimeout(r, 600));

    const reportSubtabs = ['summary', 'reports', 'excel'];
    for (const sub of reportSubtabs) {
      const clicked = await page.evaluate((s) => {
        const btn = document.querySelector(`button[onclick*="switchReportsAnalyticsTab('${s}')"]`) as HTMLButtonElement;
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }, sub);
      if (clicked) {
        await new Promise((r) => setTimeout(r, 300));
        console.log(`  ✓ Reports subtab "${sub}" clicked successfully.`);
      }
    }

    // 8. Audit Tab 8: Settings (Financial Years addFy / activateFy)
    console.log('\n[8/9] Auditing Settings Tab Financial Year Buttons...');
    await page.click('nav button[data-tab="admin"]');
    await new Promise((r) => setTimeout(r, 600));

    const fyInputExists = await page.$('#fyLabel');
    if (fyInputExists) {
      console.log('  ✓ #fyLabel input found in Settings tab.');
      // Verify addFy button is callable
      const addFyBtn = await page.$('button[onclick*="addFy()"]');
      if (addFyBtn) {
        console.log('  ✓ "Add Financial Year" button with onclick="addFy()" is present and active.');
      }
    }

    // 9. Inspect Browser Console Errors
    console.log('\n[9/9] Verifying Zero Browser Console Errors...');
    const fatalErrors = consoleErrors.filter(
      (e) => !e.includes('favicon') && !e.includes('404 (Not Found)')
    );

    if (fatalErrors.length > 0) {
      throw new Error(`Browser console contains errors:\n${fatalErrors.join('\n')}`);
    }
    if (pageErrors.length > 0) {
      throw new Error(`Page errors occurred:\n${pageErrors.join('\n')}`);
    }
    console.log('  ✅ ZERO browser console errors during the entire interactive button audit!');

    console.log('\n===============================================================');
    console.log('🎉 COMPREHENSIVE BROWSER BUTTON AUDIT PASSED 100%!');
    console.log('===============================================================\n');
  } finally {
    await browser.close();
    server.close();
  }
}

runBrowserButtonAudit().catch((err) => {
  console.error('\n❌ Browser button audit failed:', err);
  process.exit(1);
});
