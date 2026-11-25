import fs from 'fs';

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

function getLineNumber(index: number) {
  let count = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') count++;
  }
  return count;
}

// 1. Find all label tags
const labelRegex = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
let match: RegExpExecArray | null;
const labelForList: { forId: string; full: string; line: number }[] = [];
const unassociatedLabels: { full: string; line: number }[] = [];

while ((match = labelRegex.exec(content)) !== null) {
  const attrs = match[1];
  const inner = match[2];
  const forMatch = attrs.match(/for=["']([^"']+)["']/i);
  const line = getLineNumber(match.index);

  if (forMatch) {
    labelForList.push({ forId: forMatch[1], full: match[0].substring(0, 80), line });
  } else {
    // Check if inner content wraps an input/select/textarea
    if (!/<(input|select|textarea)\b/i.test(inner)) {
      unassociatedLabels.push({ full: match[0].substring(0, 100), line });
    }
  }
}

console.log('--- ACCESSIBILITY FORM LABELS AUDIT ---');
console.log(`Total <label> elements with 'for': ${labelForList.length}`);
console.log(`Total unassociated <label> elements (no 'for', not wrapping control): ${unassociatedLabels.length}\n`);

unassociatedLabels.forEach((l, idx) => {
  console.log(`  [Unassociated Label #${idx + 1}] Line ${l.line}: ${l.full.replace(/\s+/g, ' ')}`);
});

function escapeRegex(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Check which forIds exist as id="..." in content
const missingForIds: { forId: string; full: string; line: number }[] = [];
labelForList.forEach((l) => {
  // Check exact id match: id="forId" or id='forId'
  const idRegex = new RegExp(`id=["']${escapeRegex(l.forId)}["']`, 'i');
  if (!idRegex.test(content)) {
    missingForIds.push(l);
  }
});

console.log(`\nLabels referencing non-existent IDs: ${missingForIds.length}`);
missingForIds.forEach((l, idx) => {
  console.log(`  [Incorrect for Reference #${idx + 1}] Line ${l.line}: for="${l.forId}" in ${l.full.replace(/\s+/g, ' ')}`);
});

// Check duplicate IDs
const idRegex = /\bid=["']([^"']+)["']/gi;
const idCounts = new Map<string, number>();
const idLines = new Map<string, number[]>();

while ((match = idRegex.exec(content)) !== null) {
  const id = match[1];
  // Ignore dynamic template IDs that use JS interpolation like ${idx}
  if (id.includes('${')) continue;
  idCounts.set(id, (idCounts.get(id) || 0) + 1);
  const line = getLineNumber(match.index);
  if (!idLines.has(id)) idLines.set(id, []);
  idLines.get(id)!.push(line);
}

console.log('\n--- DUPLICATE STATIC ELEMENT IDs ---');
let dupCount = 0;
idCounts.forEach((count, id) => {
  if (count > 1) {
    dupCount++;
    console.log(`  Duplicate ID "${id}": appears ${count} times on lines ${idLines.get(id)!.join(', ')}`);
  }
});
if (dupCount === 0) {
  console.log('  ✅ Zero duplicate static element IDs!');
}

// Check inputs without accessible name / without label
console.log('\n--- INPUTS WITHOUT ACCESSIBLE NAME / LABEL ---');
const inputRegex = /<(input|select|textarea)\b([^>]*)>/gi;
const unlabeledControls: { tag: string; line: number; snippet: string }[] = [];

while ((match = inputRegex.exec(content)) !== null) {
  const tag = match[1].toLowerCase();
  const attrs = match[2];
  const line = getLineNumber(match.index);

  // Hidden inputs don't need labels
  if (/type=["']hidden["']/i.test(attrs)) continue;

  const idMatch = attrs.match(/id=["']([^"']+)["']/i);
  const id = idMatch ? idMatch[1] : null;

  const hasAriaLabel = /aria-label=["']/i.test(attrs) || /aria-labelledby=["']/i.test(attrs);
  let hasMatchingLabel = false;
  if (id) {
    hasMatchingLabel = labelForList.some((l) => l.forId === id);
  }

  // Also check if control is inside a label (search 200 chars before match)
  const beforeSnippet = content.substring(Math.max(0, match.index - 250), match.index);
  const insideLabel = /<label\b[^>]*>[^<]*$/i.test(beforeSnippet) || /<label\b[^>]*>[\s\S]*?$/i.test(beforeSnippet);

  if (!hasAriaLabel && !hasMatchingLabel && !insideLabel) {
    unlabeledControls.push({ tag, line, snippet: match[0].substring(0, 100).replace(/\s+/g, ' ') });
  }
}

console.log(`Controls potentially missing accessible name/label: ${unlabeledControls.length}`);
unlabeledControls.forEach((c, idx) => {
  console.log(`  [Unlabeled #${idx + 1}] Line ${c.line} <${c.tag}>: ${c.snippet}`);
});
