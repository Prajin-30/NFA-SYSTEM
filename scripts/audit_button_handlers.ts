import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');

// 1. Find all declared functions in <script>
const scriptMatch = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
if (!scriptMatch) {
  console.error('No script found');
  process.exit(1);
}
const script = scriptMatch[1];

const declaredFunctions = new Set<string>();
// Match function names: function foo, async function foo, const foo = function, let foo = ..., window.foo =
const fnDeclRegex = /(?:function\s+([a-zA-Z0-9_$]+)|(?:const|let|var|window\.)\s*([a-zA-Z0-9_$]+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|[a-zA-Z0-9_$]+\s*=>))/g;
let m: RegExpExecArray | null;
while ((m = fnDeclRegex.exec(script)) !== null) {
  declaredFunctions.add(m[1] || m[2]);
}

// Built-in globals to exclude
const standardGlobals = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'confirm', 'alert', 'prompt',
  'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'Boolean', 'String', 'Number', 'Date', 'Math', 'JSON', 'Object', 'Array',
  'event', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'getElementById', 'stopPropagation', 'preventDefault', 'closest', 'writeText',
  'querySelector', 'querySelectorAll', 'setAttribute', 'removeAttribute', 'classList',
  'focus', 'blur', 'reset', 'submit', 'click', 'remove', 'appendChild'
]);

console.log('Total declared functions found in script:', declaredFunctions.size);

// 2. Find all function calls in on* attributes across entire file (static and template)
const eventRegex = /\son[a-z]+\s*=\s*\\?["']([^"'\\]*(?:\\.[^"'\\]*)*)\\?["']/gi;
const calledFunctions = new Map<string, { count: number; sample: string; eventAttr: string }>();

while ((m = eventRegex.exec(html)) !== null) {
  const handlerCode = m[1];
  // Extract function names like foo(...)
  const callMatches = handlerCode.matchAll(/\b([a-zA-Z0-9_$]+)\s*\(/g);
  for (const cm of callMatches) {
    const fnName = cm[1];
    if (standardGlobals.has(fnName)) {
      continue;
    }
    if (!calledFunctions.has(fnName)) {
      calledFunctions.set(fnName, { count: 0, sample: handlerCode, eventAttr: m[0].split('=')[0].trim() });
    }
    calledFunctions.get(fnName)!.count++;
  }
}

console.log('Total unique function names called from event handlers:', calledFunctions.size);

const missing: { fnName: string; count: number; sample: string; eventAttr: string }[] = [];
for (const [fnName, info] of calledFunctions.entries()) {
  if (!declaredFunctions.has(fnName)) {
    missing.push({ fnName, count: info.count, sample: info.sample, eventAttr: info.eventAttr });
  }
}

console.log('\n===============================================================');
if (missing.length === 0) {
  console.log('✅ ALL called event handler functions are declared in script!');
} else {
  console.log(`❌ FOUND ${missing.length} MISSING / UNDEFINED FUNCTIONS:`);
  for (const miss of missing) {
    console.log(`  - "${miss.fnName}" (${miss.count} occurrences in ${miss.eventAttr})`);
    console.log(`    Sample: ${miss.sample.trim().slice(0, 100)}`);
  }
}
console.log('===============================================================\n');
