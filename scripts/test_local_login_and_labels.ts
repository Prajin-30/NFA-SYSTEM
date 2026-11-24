import http from 'http';
import puppeteer from 'puppeteer-core';
import { app } from '../src/server.js';
import { store } from '../src/store.js';

async function testLocalLoginAndLabels() {
  console.log('=== TESTING LOCAL LOGIN, LABELS, & DEVTOOLS CONSOLE ===');
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

  const consoleErrors: string[] = [];

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.error(`[Browser Console Error] ${msg.text()}`);
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle2' });

    // 1. Verify Login Label is "Email ID"
    const emailLabelText = await page.$eval('label[for="loginEmail"]', (el) => el.textContent?.trim());
    console.log(`Login Email Label Text: "${emailLabelText}"`);
    if (emailLabelText !== 'Email ID') {
      throw new Error(`Expected "Email ID", got "${emailLabelText}"`);
    }
    console.log('  ✅ Login label is exactly "Email ID"');

    // 2. Verify Favicon returns 200 OK
    const faviconRes = await fetch(`${baseUrl}/favicon.ico`);
    console.log(`Favicon HTTP Status: ${faviconRes.status} (Content-Type: ${faviconRes.headers.get('content-type')})`);
    if (faviconRes.status !== 200) {
      throw new Error(`Expected favicon 200 OK, got ${faviconRes.status}`);
    }
    console.log('  ✅ Favicon is 200 OK');

    // 3. Verify Form Associations across DOM
    const unassociatedLabels = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      return labels.filter((l) => (l as any).control === null).map((l) => ({
        text: l.textContent?.trim(),
        html: l.outerHTML.slice(0, 100),
      }));
    });
    console.log(`Unassociated labels count: ${unassociatedLabels.length}`);
    if (unassociatedLabels.length > 0) {
      console.error('Unassociated labels found:', unassociatedLabels);
      throw new Error(`Found ${unassociatedLabels.length} unassociated labels!`);
    }
    console.log('  ✅ Zero unassociated labels in the entire DOM (100% compliant)');

    // 4. Verify password field is inside <form>
    const isPasswordInForm = await page.$eval('#loginPassword', (el) => el.closest('form') !== null);
    console.log(`Password field in form: ${isPasswordInForm}`);
    if (!isPasswordInForm) {
      throw new Error('Password field is not inside a form!');
    }
    console.log('  ✅ Password field is properly inside <form>');

    // 5. Verify console errors
    console.log(`Total console errors: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
      throw new Error(`Console errors found: ${consoleErrors.join(', ')}`);
    }
    console.log('  ✅ ZERO console errors!');

    console.log('\n🎉 LOCAL LOGIN, LABELS & CONSOLE CHECKS 100% PASSED!\n');
  } finally {
    await browser.close();
    server.close();
  }
}

testLocalLoginAndLabels().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
