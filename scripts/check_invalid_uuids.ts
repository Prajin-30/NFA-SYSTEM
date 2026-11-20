import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'db.json'), 'utf8'));
const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const nonUuids: Record<string, Set<string>> = {};

for (const [table, rows] of Object.entries(db)) {
  if (!Array.isArray(rows)) continue;
  for (const row of rows as any[]) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string' && (k === 'id' || k.endsWith('_id') || k.endsWith('_by'))) {
        if (!uuidRe.test(v)) {
          const key = `${table}.${k}`;
          if (!nonUuids[key]) nonUuids[key] = new Set();
          nonUuids[key].add(v);
        }
      }
    }
  }
}

for (const [field, vals] of Object.entries(nonUuids)) {
  console.log(`${field}:`, Array.from(vals));
}
