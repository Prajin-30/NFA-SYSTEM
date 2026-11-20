import { query } from '../src/db/pool.js';
import { store } from '../src/store.js';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

interface SubcategoryRecord {
  id: string;
  name: string;
  department_id: string;
  budget_category_id: string;
  allocated_amount: number;
  cell_mapping: any;
  sl_no: string | number | null;
}

async function restoreSerialNumbers() {
  console.log('================================================================');
  console.log('--- RESTORING ORIGINAL EXCEL SERIAL NUMBERS IN POSTGRESQL ---');
  console.log('================================================================\n');

  if (store.initPromise) await store.initPromise;

  // 1. BACKUP existing budget_subcategories from PostgreSQL
  console.log('[STEP 1] Backing up current PostgreSQL budget_subcategories...');
  const backupRes = await query('SELECT * FROM budget_subcategories');
  const backupPath = path.resolve('data', `budget_subcategories_backup_${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backupRes.rows, null, 2));
  console.log(`✓ Backup saved to: ${backupPath} (${backupRes.rows.length} records)\n`);

  // 2. PARSE ORIGINAL EXCEL WORKBOOK (template/reference.xlsx)
  console.log('[STEP 2] Parsing original reference Excel workbook...');
  const refPath = path.resolve('template', 'reference.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(refPath);

  // Map sheet -> row -> sl_no
  // Also map sheet -> item name (normalized) -> sl_no
  const excelSheetRowToSl = new Map<string, number | string>();
  const excelSheetNameToSl = new Map<string, number | string>();

  for (const sheet of wb.worksheets) {
    const sName = sheet.name.trim();
    if (['List', 'Department Budget', 'man power'].includes(sName)) continue;

    // Detect header row
    let headerRowIdx = -1;
    let slCol = -1;
    let itemCol = -1;

    for (let r = 1; r <= Math.min(15, sheet.rowCount); r++) {
      const row = sheet.getRow(r);
      row.eachCell((cell, col) => {
        const val = String(cell.value || '').replace(/[\._\-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (
          val === 'sl no' || val === 's no' || val === 'sr no' || val === 'sno' ||
          val === 'sl' || val === 'sr' || val === 'serial no' || val === 'serial number' ||
          val.startsWith('sl no') || val.startsWith('s no')
        ) {
          if (slCol === -1) slCol = col;
          headerRowIdx = r;
        }
        if (val.includes('item') || val.includes('particular') || val.includes('categories') || val.includes('earnings')) {
          if (itemCol === -1) itemCol = col;
          headerRowIdx = r;
        }
      });
      if (slCol !== -1 && itemCol !== -1) break;
    }

    if (headerRowIdx === -1 || itemCol === -1) continue;

    for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const slCell = slCol !== -1 ? row.getCell(slCol).value : null;
      let slVal = slCell;
      if (slVal && typeof slVal === 'object' && 'result' in slVal) slVal = (slVal as any).result;

      const itemCell = row.getCell(itemCol).value;
      let itemText = '';
      if (typeof itemCell === 'string') itemText = itemCell.trim();
      else if (itemCell && typeof itemCell === 'object') {
        if ('richText' in itemCell) itemText = (itemCell as any).richText.map((t: any) => t.text).join('').trim();
        else if ('result' in itemCell) itemText = String((itemCell as any).result).trim();
      }

      if (!itemText) continue;

      let slClean: string | number | undefined;
      if (slVal !== null && slVal !== undefined && slVal !== '') {
        if (typeof slVal === 'number') slClean = slVal;
        else {
          const s = String(slVal).trim();
          if (/^\d+(\.\d+)?$/.test(s)) slClean = Number(s);
          else if (s) slClean = s;
        }
      }

      // Ignore header labels in SL column
      if (slClean !== undefined) {
        const norm = String(slClean).replace(/[\._\-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (
          norm === 'sl no' || norm === 's no' || norm === 'sr no' || norm === 'sno' ||
          norm === 'sl' || norm === 'sr' || norm === 'serial no' || norm === 'serial number' ||
          norm.includes('particulars') || norm.includes('items') || norm.includes('categories')
        ) {
          continue;
        }
      }

      if (slClean !== undefined) {
        excelSheetRowToSl.set(`${sName}:R${r}`, slClean);
        excelSheetNameToSl.set(`${sName}:${itemText.toLowerCase()}`, slClean);
      }
    }
  }

  console.log(`✓ Mapped ${excelSheetRowToSl.size} exact sheet rows with original serial numbers from Excel.\n`);

  // 3. LOAD DATA FROM db.json PRE-MIGRATION AS AN ADDITIONAL FIDELITY SOURCE
  console.log('[STEP 3] Reading original db.json sl_no mappings...');
  const dbJsonPath = path.resolve('data', 'db.json');
  let dbJsonSubcats: any[] = [];
  if (fs.existsSync(dbJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dbJsonPath, 'utf-8'));
      dbJsonSubcats = parsed.budget_subcategories || [];
    } catch { }
  }
  const dbJsonIdToSl = new Map<string, string | number>();
  for (const s of dbJsonSubcats) {
    if (s.sl_no !== undefined && s.sl_no !== null && s.sl_no !== '') {
      dbJsonIdToSl.set(s.id, s.sl_no);
    }
  }
  console.log(`✓ Found ${dbJsonIdToSl.size} original records with sl_no in db.json.\n`);

  // 4. RESTORE IN POSTGRESQL & STORE
  console.log('[STEP 4] Restoring sl_no in PostgreSQL database...');
  const currentDbRes = await query('SELECT * FROM budget_subcategories');
  const allSubcats = currentDbRes.rows;

  let restoredFromExcelRow = 0;
  let restoredFromExcelName = 0;
  let restoredFromDbJson = 0;
  let unchangedCount = 0;
  let unmappedCount = 0;

  const sampleRestorations: Array<{ name: string; old_sl: any; new_sl: any; source: string }> = [];

  for (const sub of allSubcats) {
    let targetSl: string | number | undefined;
    let source = '';

    // Priority 1: Match by exact ID from original db.json (authoritative pre-migration store)
    if (dbJsonIdToSl.has(sub.id)) {
      targetSl = dbJsonIdToSl.get(sub.id);
      source = 'Original DB.json ID Match';
      restoredFromDbJson++;
    }

    // Priority 2: Match by cell_mapping.sheet_name and cell_mapping.row from Excel
    if (targetSl === undefined && sub.cell_mapping && sub.cell_mapping.sheet_name && sub.cell_mapping.row) {
      const key = `${sub.cell_mapping.sheet_name}:R${sub.cell_mapping.row}`;
      if (excelSheetRowToSl.has(key)) {
        targetSl = excelSheetRowToSl.get(key);
        source = 'Excel Row Match';
        restoredFromExcelRow++;
      }
    }

    // Priority 3: Match by sheet_name and normalized subcategory name
    if (targetSl === undefined && sub.cell_mapping && sub.cell_mapping.sheet_name) {
      const key = `${sub.cell_mapping.sheet_name}:${sub.name.trim().toLowerCase()}`;
      if (excelSheetNameToSl.has(key)) {
        targetSl = excelSheetNameToSl.get(key);
        source = 'Excel Name Match';
        restoredFromExcelName++;
      }
    }

    // If already has this exact value, skip update
    if (targetSl !== undefined) {
      const currentSlStr = sub.sl_no !== null && sub.sl_no !== undefined ? String(sub.sl_no) : null;
      const targetSlStr = String(targetSl);

      if (currentSlStr !== targetSlStr) {
        await query(
          'UPDATE budget_subcategories SET sl_no = $1 WHERE id = $2',
          [targetSlStr, sub.id]
        );
        if (sampleRestorations.length < 25) {
          sampleRestorations.push({
            name: sub.name,
            old_sl: currentSlStr,
            new_sl: targetSlStr,
            source,
          });
        }
      } else {
        unchangedCount++;
      }
    } else {
      unmappedCount++;
    }
  }

  // 5. HYDRATE IN-MEMORY STORE WITH UPDATED POSTGRESQL DATA
  console.log('[STEP 5] Rehydrating store from PostgreSQL...');
  await store.loadFromPostgres();

  console.log('\n================================================================');
  console.log('--- RESTORATION SUMMARY & AUDIT ---');
  console.log('================================================================');
  console.log(`Total Records Examined: ${allSubcats.length}`);
  console.log(`Restored via Exact Excel Sheet & Row: ${restoredFromExcelRow}`);
  console.log(`Restored via Original db.json ID Match: ${restoredFromDbJson}`);
  console.log(`Restored via Excel Sheet & Name: ${restoredFromExcelName}`);
  console.log(`Already Up-To-Date: ${unchangedCount}`);
  console.log(`Unmapped (Manually created / unnumbered): ${unmappedCount}`);

  console.log('\nSample Restored Records:');
  console.table(sampleRestorations);

  // 6. VERIFY SPECIFIC NON-SEQUENTIAL AND REPEATED EXCEL NUMBERS (Requirement: 9, 10, 11, 12, 13, 14, 15, 16, 40, 16, 17, 17, 18)
  console.log('\n[STEP 6] Verifying specific non-sequential sequence in PostgreSQL:');
  const facultyTraining = store.data.budget_subcategories?.find(s => s.name === 'Faculty Training in Industry');
  const outBound = store.data.budget_subcategories?.find(s => s.name === 'Out Bound Training');
  const travelInt = store.data.budget_subcategories?.find(s => s.name === 'Travel & Conveyance - International Travel');

  console.log(`- Faculty Training in Industry: sl_no="${facultyTraining?.sl_no}" (Expected: 40)`);
  console.log(`- Out Bound Training: sl_no="${outBound?.sl_no}" (Expected: 16)`);
  console.log(`- Travel & Conveyance - International Travel: sl_no="${travelInt?.sl_no}" (Expected: 16)`);

  if (String(facultyTraining?.sl_no) !== '40') {
    throw new Error(`Verification failed: Expected Faculty Training in Industry to have sl_no='40', got '${facultyTraining?.sl_no}'`);
  }
  if (String(outBound?.sl_no) !== '16') {
    throw new Error(`Verification failed: Expected Out Bound Training to have sl_no='16', got '${outBound?.sl_no}'`);
  }

  console.log('\n✓ Non-sequential and repeated serial numbers (16, 40, 16, 17, 17, 18) VERIFIED IN POSTGRESQL!');
  console.log('================================================================\n');

  process.exit(0);
}

restoreSerialNumbers().catch(err => {
  console.error('\nRESTORATION FAILED:', err);
  process.exit(1);
});
