import puppeteer from 'puppeteer-core';

async function diagnoseDevtools() {
  console.log('--- DIAGNOSING DEVTOOLS CONSOLE ERRORS & FORM LABELS ---');
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    page.on('console', (msg) => {
      console.log(`[PAGE CONSOLE ${msg.type().toUpperCase()}] ${msg.text()}`);
    });

    page.on('pageerror', (err) => {
      console.log(`[PAGE UNCAUGHT ERROR] ${err.message}`);
    });

    page.on('requestfailed', (req) => {
      console.log(`[REQUEST FAILED] ${req.url()} - ${req.failure()?.errorText}`);
    });

    page.on('response', (res) => {
      if (res.status() >= 400) {
        console.log(`[HTTP ${res.status()}] ${res.url()}`);
      }
    });

    await page.goto('https://nfa-system.onrender.com', { waitUntil: 'networkidle2' });

    // Inspect all labels on login view
    const labelAudit = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      const unassociated = [];
      for (const l of labels) {
        const forAttr = l.getAttribute('for');
        const hasControl = (l as any).control !== null;
        const text = l.textContent?.trim().slice(0, 40) || '';
        const isVisible = (l.offsetWidth > 0 || l.offsetHeight > 0 || l.getClientRects().length > 0);
        if (!hasControl) {
          unassociated.push({
            text,
            forAttr,
            isVisible,
            outerHTML: l.outerHTML.slice(0, 150),
            parentTag: l.parentElement?.tagName,
            parentId: l.parentElement?.id,
          });
        }
      }
      return { totalLabels: labels.length, unassociated };
    });

    console.log(`\nTotal Labels Found: ${labelAudit.totalLabels}`);
    console.log(`Unassociated Labels (label.control === null): ${labelAudit.unassociated.length}`);
    labelAudit.unassociated.forEach((u, i) => {
      console.log(`[#${i + 1}] Text: "${u.text}", for: "${u.forAttr}", visible: ${u.isVisible}`);
      console.log(`     Snippet: ${u.outerHTML}`);
      console.log(`     Parent: <${u.parentTag} id="${u.parentId}">`);
    });

    // Also check after opening Forgot Password modal
    console.log('\n--- Checking Forgot Password Modal ---');
    await page.evaluate(() => {
      (window as any).openForgotPasswordModal();
    });
    await new Promise((r) => setTimeout(r, 500));
    const forgotModalAudit = await page.evaluate(() => {
      const modal = document.getElementById('forgotPasswordModal');
      if (!modal) return null;
      const labels = Array.from(modal.querySelectorAll('label'));
      return labels.map((l) => ({
        text: l.textContent?.trim() || '',
        forAttr: l.getAttribute('for'),
        hasControl: (l as any).control !== null,
        outerHTML: l.outerHTML.slice(0, 120),
      }));
    });
    console.log('Forgot Modal Labels:', forgotModalAudit);

    // Also check Mandatory Password Change Modal
    console.log('\n--- Checking Mandatory Change Password Modal ---');
    await page.evaluate(() => {
      (window as any).showMustChangePasswordModal();
    });
    await new Promise((r) => setTimeout(r, 500));
    const mustChangeModalAudit = await page.evaluate(() => {
      const modal = document.getElementById('mustChangePasswordModal');
      if (!modal) return null;
      const labels = Array.from(modal.querySelectorAll('label'));
      return labels.map((l) => ({
        text: l.textContent?.trim() || '',
        forAttr: l.getAttribute('for'),
        hasControl: (l as any).control !== null,
        outerHTML: l.outerHTML.slice(0, 120),
      }));
    });
    console.log('Must Change Password Modal Labels:', mustChangeModalAudit);
  } finally {
    await browser.close();
  }
}

diagnoseDevtools().catch((e) => console.error(e));
