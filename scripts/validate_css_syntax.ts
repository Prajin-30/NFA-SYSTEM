import fs from 'fs';
import puppeteer from 'puppeteer-core';

async function validateCss() {
  console.log('===============================================================');
  console.log('--- VALIDATING CSS SYNTAX IN PUBLIC/INDEX.HTML ---');
  console.log('===============================================================');

  const html = fs.readFileSync('public/index.html', 'utf-8');

  // Extract <style> block
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!styleMatch) {
    console.error('❌ No <style> tag found in public/index.html');
    process.exit(1);
  }

  const cssText = styleMatch[1];
  console.log(`CSS stylesheet extracted (${cssText.length} characters).`);

  // 1. Text-level brace balance analysis
  let braceCount = 0;
  let parenCount = 0;
  let inComment = false;
  let inString: string | null = null;
  const lines = cssText.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    for (let charIdx = 0; charIdx < line.length; charIdx++) {
      const char = line[charIdx];
      const nextChar = line[charIdx + 1];

      if (inComment) {
        if (char === '*' && nextChar === '/') {
          inComment = false;
          charIdx++;
        }
        continue;
      }

      if (char === '/' && nextChar === '*') {
        inComment = true;
        charIdx++;
        continue;
      }

      if (inString) {
        if (char === inString && line[charIdx - 1] !== '\\') {
          inString = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inString = char;
        continue;
      }

      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount < 0) {
          console.error(`❌ Unmatched closing brace '}' at line ${lineIdx + 16}, column ${charIdx + 1}!`);
          process.exit(1);
        }
      } else if (char === '(') {
        parenCount++;
      } else if (char === ')') {
        parenCount--;
        if (parenCount < 0) {
          console.error(`❌ Unmatched closing parenthesis ')' at line ${lineIdx + 16}, column ${charIdx + 1}!`);
          process.exit(1);
        }
      }
    }
  }

  if (braceCount !== 0) {
    console.error(`❌ Unclosed opening brace(s) detected! Missing ${braceCount} closing brace(s).`);
    process.exit(1);
  }
  if (parenCount !== 0) {
    console.error(`❌ Unclosed parenthesis detected! Missing ${parenCount} closing parenthesis.`);
    process.exit(1);
  }
  if (inComment) {
    console.error(`❌ Unclosed comment block detected!`);
    process.exit(1);
  }

  console.log('  ✅ Brace balance check passed: exactly 0 unmatched braces or parentheses.');

  // 2. Headless Chrome DOM CSS Parser Audit
  console.log('\n[Browser CSS Engine] Auditing stylesheet via Chromium CSS parser...');
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const result = await page.evaluate((css) => {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        return {
          valid: true,
          rulesCount: sheet.cssRules.length,
        };
      } catch (err: any) {
        return {
          valid: false,
          error: err.message,
        };
      }
    }, cssText);

    if (!result.valid) {
      console.error('❌ Chromium CSSStyleSheet parser failed:', result.error);
      process.exit(1);
    }

    console.log(`  ✅ Chromium CSSStyleSheet.replaceSync parsed successfully: ${result.rulesCount} top-level CSS rules.`);
  } finally {
    await browser.close();
  }

  console.log('\n===============================================================');
  console.log('🎉 ALL CSS SYNTAX CHECKS PASSED WITH 0 ERRORS!');
  console.log('===============================================================');
  process.exit(0);
}

validateCss().catch((err) => {
  console.error('Fatal CSS validation error:', err);
  process.exit(1);
});
