import { query } from '../src/db/pool.js';
import { analyzeMasterBudgetWorkbook } from '../src/lib/excel.js';
import { store } from '../src/store.js';
import fs from 'fs';
import path from 'path';

async function compare() {
  console.log('=== COMPARING DATABASE SUB-CATEGORIES VS ORIGINAL EXCEL ===\n');

  if (store.initPromise) await store.initPromise;

  const excelPath = path.resolve('template', 'reference.xlsx');
  const buffer = fs.readFileSync(excelPath);
  const preview = await analyzeMasterBudgetWorkbook(buffer, 'reference.xlsx', store.data);

  console.log(`Excel Preview: ${preview.categories.length} categories, total: ₹${preview.total_allocated}`);

  // Fetch from PostgreSQL
  const dbRes = await query(`
    SELECT bs.id, bs.name, bs.allocated_amount, bs.sl_no, bs.cell_mapping, bc.name as category_name
    FROM budget_subcategories bs
    JOIN budget_categories bc ON bs.budget_category_id = bc.id
    ORDER BY bc.name, bs.name
  `);

  console.log(`Database Subcategories count in PostgreSQL: ${dbRes.rows.length}`);

  let missingSlNoCount = 0;
  let populatedSlNoCount = 0;
  for (const row of dbRes.rows) {
    if (row.sl_no === null || row.sl_no === undefined || row.sl_no === '') {
      missingSlNoCount++;
    } else {
      populatedSlNoCount++;
    }
  }

  console.log(`Current DB sl_no status: Populated=${populatedSlNoCount}, Missing/Null=${missingSlNoCount}`);

  // Show sample rows
  console.log('\nSample 15 DB rows:');
  for (const r of dbRes.rows.slice(0, 15)) {
    console.log(`- [${r.category_name}] "${r.name}": sl_no="${r.sl_no}", cell_mapping.sl_no="${r.cell_mapping?.sl_no}", alloc=₹${r.allocated_amount}`);
  }

  process.exit(0);
}

compare().catch(err => {
  console.error(err);
  process.exit(1);
});
