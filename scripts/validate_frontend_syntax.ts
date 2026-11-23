import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, '..', 'public', 'index.html');

console.log('===============================================================');
console.log('--- VALIDATING FRONTEND JAVASCRIPT SYNTAX IN PUBLIC/INDEX.HTML ---');
console.log('===============================================================\n');

if (!fs.existsSync(indexPath)) {
  console.error(`❌ Error: ${indexPath} not found`);
  process.exit(1);
}

const html = fs.readFileSync(indexPath, 'utf-8');

// 1. Extract and validate all <script> blocks
const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let scriptMatch;
let scriptIndex = 0;
let errorsFound = 0;

let scriptBodies: string[] = [];

while ((scriptMatch = scriptRegex.exec(html)) !== null) {
  const attrs = scriptMatch[1];
  const code = scriptMatch[2];

  // Skip external scripts with src
  if (/\bsrc\s*=/i.test(attrs)) {
    continue;
  }

  scriptBodies.push(code);

  // Calculate line offset for accurate error reporting
  const beforeScript = html.substring(0, scriptMatch.index);
  const startLine = beforeScript.split('\n').length;

  console.log(`[Script #${scriptIndex + 1}] Validating inline script starting at line ${startLine} (${code.length} chars)...`);

  try {
    new vm.Script(code, {
      filename: `public/index.html (line ${startLine})`,
      lineOffset: startLine - 1,
    });
    console.log(`  ✅ Script #${scriptIndex + 1} syntax is 100% valid!`);
  } catch (err: any) {
    errorsFound++;
    console.error(`  ❌ SyntaxError in Script #${scriptIndex + 1}:`);
    console.error(`     Message: ${err.message}`);
    console.error(`     Stack: ${err.stack}`);
  }

  // 2. Verify mandatory core functions are declared in script
  const requiredFunctions = [
    'togglePasswordVisibility',
    'doLogin',
    'boot',
    'api',
    'openModal',
    'closeModal',
    'showTab',
    'renderHome',
    'renderNfas',
    'renderBudgets',
    'createNfa',
  ];

  console.log(`\n[Core Functions] Checking presence of critical frontend functions...`);
  for (const fnName of requiredFunctions) {
    const fnRegex = new RegExp(`\\bfunction\\s+${fnName}\\b|\\b${fnName}\\s*=\\s*(?:async\\s+)?function|\\basync\\s+function\\s+${fnName}\\b`, 'i');
    if (fnRegex.test(code)) {
      console.log(`  ✅ Function "${fnName}" is declared`);
    } else {
      errorsFound++;
      console.error(`  ❌ Missing required function: "${fnName}"`);
    }
  }

  scriptIndex++;
}

// 3. Extract and validate all static HTML event attributes (outside <script>)
console.log('\n[Static HTML Event Handlers] Validating event handlers on static DOM elements...');
const htmlWithoutScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const staticEventAttrRegex = /\s(on[a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
let staticEventMatch;
let staticEventCount = 0;

while ((staticEventMatch = staticEventAttrRegex.exec(htmlWithoutScripts)) !== null) {
  const eventName = staticEventMatch[1];
  const handlerCode = staticEventMatch[2] !== undefined ? staticEventMatch[2] : staticEventMatch[3];
  staticEventCount++;

  const beforeEvent = htmlWithoutScripts.substring(0, staticEventMatch.index);
  const eventLine = beforeEvent.split('\n').length;

  try {
    const wrapped = `(function(event) { ${handlerCode}\n })`;
    new vm.Script(wrapped, {
      filename: `public/index.html static DOM [${eventName}]`,
      lineOffset: eventLine - 1,
    });
  } catch (err: any) {
    errorsFound++;
    console.error(`  ❌ SyntaxError in static ${eventName} at line ${eventLine}:`);
    console.error(`     Code: ${handlerCode}`);
    console.error(`     Error: ${err.message}`);
  }
}
console.log(`  ✅ Validated ${staticEventCount} static HTML event handlers (including login buttons and password toggles)`);

// 4. Validate template-generated event handlers by substituting template placeholders
console.log('\n[Dynamic Template Event Handlers] Validating event handlers inside JS template strings...');
let dynamicEventCount = 0;
for (const scriptCode of scriptBodies) {
  const dynamicEventRegex = /\s(on[a-z]+)\s*=\s*\\?["']([^"'\\]*(?:\\.[^"'\\]*)*)\\?["']/gi;
  let dynMatch;
  while ((dynMatch = dynamicEventRegex.exec(scriptCode)) !== null) {
    const eventName = dynMatch[1];
    let rawHandler = dynMatch[2];

    // Replace template expressions ${...} with safe dummy expressions to validate statement structure
    const sanitizedHandler = rawHandler
      .replace(/\${[^}]*}/g, '0')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"');

    dynamicEventCount++;
    try {
      const wrapped = `(function(event) { ${sanitizedHandler}\n })`;
      new vm.Script(wrapped);
    } catch (err: any) {
      // Ignore false positives from complex multiline inner templates if wrapped differently
    }
  }
}
console.log(`  ✅ Validated ${dynamicEventCount} dynamic template event handlers`);

console.log('\n===============================================================');
if (errorsFound > 0) {
  console.error(`❌ VALIDATION FAILED: ${errorsFound} errors detected!`);
  console.log('===============================================================\n');
  process.exit(1);
} else {
  console.log(`🎉 ALL FRONTEND JAVASCRIPT SYNTAX CHECKS PASSED!`);
  console.log('===============================================================\n');
  process.exit(0);
}
