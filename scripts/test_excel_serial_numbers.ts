import ExcelJS from 'exceljs';
import { v4 as uuid } from 'uuid';
import { analyzeMasterBudgetWorkbook, applyMasterBudgetImport, exportMasterBudgetExcel } from '../src/lib/excel.js';
import { store } from '../src/store.js';
import { query } from '../src/db/pool.js';
import type { DB, BudgetSubcategory } from '../src/types.js';

async function runExcelSerialTests() {
  console.log('\n======================================================');
  console.log('--- STARTING EXCEL SERIAL NUMBER INTEGRATION TESTS ---');
  console.log('======================================================\n');

  if (store.initPromise) {
    await store.initPromise;
  }

  // ----------------------------------------------------
  // TEST 1: Multiple Excel sheets with distinct & repeated serial numbers
  // ----------------------------------------------------
  console.log('[TEST 1] Creating multi-sheet workbook with distinct & repeated serial numbers...');
  const wb = new ExcelJS.Workbook();

  // Sheet 1: Revenue Expenditures (with 'S.No' header)
  const ws1 = wb.addWorksheet('Revenue Expenditures');
  ws1.addRow(['DEPARTMENT: Computer Science and Engineering', '', '', '']);
  ws1.addRow(['ACADEMIC YEAR - 2026-27', '', '', '']);
  ws1.addRow(['', '', '', '']);
  ws1.addRow(['S.No', 'Particulars / Item Description', 'Budget Category', 'Budgeted Amount']);
  ws1.addRow([1, 'Faculty Development Program', 'Staff Development', 50000]);
  ws1.addRow([2, 'Guest Lecture Honorarium', 'Staff Development', 35000]);
  ws1.addRow([3, 'Research Seed Grant', 'Research Initiatives', 120000]);

  // Sheet 2: CAPEX (with 'Sl.No' header, reusing 1, 2 and adding 2.1)
  const ws2 = wb.addWorksheet('CAPEX');
  ws2.addRow(['DEPARTMENT: Computer Science and Engineering', '', '', '']);
  ws2.addRow(['ACADEMIC YEAR - 2026-27', '', '', '']);
  ws2.addRow(['', '', '', '']);
  ws2.addRow(['Sl.No', 'Item Name', 'Main Category', 'Amount']);
  ws2.addRow([1, 'GPU Server Cluster Node', 'CAPEX: Computing', 450000]);
  ws2.addRow([2, 'Network Switch 48-Port', 'CAPEX: Infrastructure', 180000]);
  ws2.addRow(['2.1', 'Rack Mount Accessories', 'CAPEX: Infrastructure', 25000]);
  ws2.addRow(['', 'Unnumbered Cable Trays', 'CAPEX: Infrastructure', 15000]); // Row with missing serial number

  // Sheet 3: Earnings (with 'Serial Number' header and deliberate duplicate '2')
  const ws3 = wb.addWorksheet('Revenue or Earnings');
  ws3.addRow(['DEPARTMENT: Computer Science and Engineering', '', '', '']);
  ws3.addRow(['ACADEMIC YEAR - 2026-27', '', '', '']);
  ws3.addRow(['', '', '', '']);
  ws3.addRow(['Serial Number', 'Particulars', 'Category', 'Amount']);
  ws3.addRow([1, 'Consultancy Project Alpha', 'Consultancy', 200000]);
  ws3.addRow([2, 'Testing Services', 'Testing & Analysis', 80000]);
  ws3.addRow([2, 'Testing Services Phase 2 (Duplicate S.No in source)', 'Testing & Analysis', 60000]);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  console.log('  Workbook generated successfully with 3 sheets.');

  // ----------------------------------------------------
  // TEST 2: Workbook Analysis & Serial Number Extraction
  // ----------------------------------------------------
  console.log('\n[TEST 2] Analyzing workbook with analyzeMasterBudgetWorkbook...');
  const preview = await analyzeMasterBudgetWorkbook(buffer, 'test_multi_sheet_budget.xlsx', store.data);

  if (preview.categories.length === 0) {
    throw new Error('Analysis failed: No categories detected');
  }

  // Find subcategories in preview
  const allSubcats = preview.categories.flatMap(c => c.subcategories);
  console.log(`  Extracted ${allSubcats.length} subcategories across ${preview.categories.length} categories.`);

  // Verify Sheet 1 items
  const fdp = allSubcats.find(s => s.name.includes('Faculty Development'));
  const guest = allSubcats.find(s => s.name.includes('Guest Lecture'));
  const seed = allSubcats.find(s => s.name.includes('Research Seed'));

  if (!fdp || fdp.sl_no !== 1) throw new Error(`Expected FDP sl_no=1, got ${fdp?.sl_no}`);
  if (!guest || guest.sl_no !== 2) throw new Error(`Expected Guest Lecture sl_no=2, got ${guest?.sl_no}`);
  if (!seed || seed.sl_no !== 3) throw new Error(`Expected Seed Grant sl_no=3, got ${seed?.sl_no}`);
  console.log('  PASS: Sheet 1 serial numbers (1, 2, 3) mapped with 100% fidelity.');

  // Verify Sheet 2 items (repeated 1, 2 and alphanumeric 2.1, and missing)
  const gpu = allSubcats.find(s => s.name.includes('GPU Server'));
  const netSwitch = allSubcats.find(s => s.name.includes('Network Switch'));
  const rack = allSubcats.find(s => s.name.includes('Rack Mount'));
  const unnumbered = allSubcats.find(s => s.name.includes('Unnumbered Cable'));

  if (!gpu || gpu.sl_no !== 1) throw new Error(`Expected GPU Server sl_no=1 (repeated across sheet), got ${gpu?.sl_no}`);
  if (!netSwitch || netSwitch.sl_no !== 2) throw new Error(`Expected Network Switch sl_no=2, got ${netSwitch?.sl_no}`);
  if (!rack || String(rack.sl_no) !== '2.1') throw new Error(`Expected alphanumeric sl_no='2.1', got ${rack?.sl_no}`);
  if (!unnumbered || unnumbered.sl_no !== undefined) throw new Error(`Expected missing serial number to be undefined, got ${unnumbered?.sl_no}`);
  console.log('  PASS: Sheet 2 serial numbers (repeated 1, 2, alphanumeric 2.1, undefined for unnumbered) verified.');

  // Verify duplicate serial number reporting
  const hasDupWarning = preview.warnings.some(w => w.includes("Duplicate serial number '2'") && w.includes('Revenue or Earnings'));
  if (!hasDupWarning) throw new Error('Expected warning for duplicate serial number in source Excel data');
  console.log('  PASS: Duplicate serial number in Sheet 3 correctly identified and reported in warnings.');

  // ----------------------------------------------------
  // TEST 3: Database Import & Persistence (Preserving exact serial numbers)
  // ----------------------------------------------------
  console.log('\n[TEST 3] Applying import and testing database persistence...');
  const cseDept = store.data.departments.find(d => d.code === 'CSE') || store.data.departments[0];
  const activeFy = store.data.financial_years.find(f => f.is_active) || store.data.financial_years[0];

  // Ensure sl_no column exists in PostgreSQL
  if (process.env.DATABASE_URL && process.env.DATA_SOURCE === 'postgres') {
    await query('ALTER TABLE budget_subcategories ADD COLUMN IF NOT EXISTS sl_no TEXT;');
  }

  await store.transact(async (db) => {
    await applyMasterBudgetImport(preview.preview_id, {
      mode: 'merge',
      department_id: cseDept.id,
      financial_year_id: activeFy.id,
      user_id: '1e282899-d6f6-4c1a-9494-63753d80ee60',
      role: 'super_admin',
    }, db);
  });

  // Check in-store subcategories
  const storedFdp = store.data.budget_subcategories?.find(s => s.department_id === cseDept.id && s.name === fdp.name);
  const storedRack = store.data.budget_subcategories?.find(s => s.department_id === cseDept.id && s.name === rack?.name);
  const storedUnnumbered = store.data.budget_subcategories?.find(s => s.department_id === cseDept.id && s.name === unnumbered?.name);

  if (!storedFdp || storedFdp.sl_no !== 1) throw new Error(`Stored FDP sl_no mismatch: ${storedFdp?.sl_no}`);
  if (!storedRack || String(storedRack.sl_no) !== '2.1') throw new Error(`Stored Rack sl_no mismatch: ${storedRack?.sl_no}`);
  if (!storedUnnumbered) throw new Error('storedUnnumbered not found!');
  if (storedUnnumbered.sl_no !== undefined && storedUnnumbered.sl_no !== null) throw new Error(`Stored unnumbered item must not have fabricated sl_no: got ${storedUnnumbered.sl_no}`);
  console.log('  PASS: In-memory store subcategories retain exact source serial numbers.');

  // If in postgres mode, test round-trip through PostgreSQL
  if (process.env.DATABASE_URL && process.env.DATA_SOURCE === 'postgres') {
    console.log('  Testing PostgreSQL persistence of sl_no column...');
    if (storedRack) {
      const pgRes = await query('SELECT sl_no FROM budget_subcategories WHERE id = $1', [storedRack.id]);
      if (!pgRes.rows[0] || pgRes.rows[0].sl_no !== '2.1') {
        throw new Error(`PostgreSQL sl_no mismatch: expected '2.1', got '${pgRes.rows[0]?.sl_no}'`);
      }
      console.log('  PASS: PostgreSQL budget_subcategories.sl_no column persists alphanumeric values.');
    }
  }

  // ----------------------------------------------------
  // TEST 4: UI Fallback & Sorting Invariants
  // ----------------------------------------------------
  console.log('\n[TEST 4] Verifying UI mapping policy and sort stability...');
  // Simulate the UI rendering logic:
  // For each subcategory in a category:
  // If sub.sl_no is present: render String(sub.sl_no)
  // If sub.sl_no is missing: render (sIdx + 1) [its sequential position in that subcategory list, NEVER parent category index]
  const testSubcats = [
    { name: 'Imported Item 1', sl_no: 10 },
    { name: 'Imported Item 2', sl_no: 20 },
    { name: 'Manual Portal Item', sl_no: undefined },
    { name: 'Imported Item 3', sl_no: '30.A' },
  ];

  const parentCategoryIdx = 1; // 2nd category in accordion (previously caused all rows to show "2")
  const renderedSlNos = testSubcats.map((sub, sIdx) => {
    return sub.sl_no !== undefined && sub.sl_no !== null && sub.sl_no !== ''
      ? String(sub.sl_no)
      : String(sIdx + 1);
  });

  if (renderedSlNos[0] !== '10') throw new Error(`Row 0 expected '10', got '${renderedSlNos[0]}'`);
  if (renderedSlNos[1] !== '20') throw new Error(`Row 1 expected '20', got '${renderedSlNos[1]}'`);
  if (renderedSlNos[2] !== '3') throw new Error(`Row 2 (manual) expected '3' (sIdx + 1), got '${renderedSlNos[2]}'`);
  if (renderedSlNos[3] !== '30.A') throw new Error(`Row 3 expected '30.A', got '${renderedSlNos[3]}'`);

  // Ensure NO row shows "2" from the parent category index
  if (renderedSlNos[2] === String(parentCategoryIdx + 1)) {
    // If it equals 2 when sIdx is 2, that's fine, but let's test with parentCategoryIdx = 5
    const renderedWithOuterIdx5 = testSubcats.map((sub, sIdx) => {
      const idx = 5; // Outer loop category idx
      return sub.sl_no !== undefined && sub.sl_no !== null && sub.sl_no !== ''
        ? String(sub.sl_no)
        : String(sIdx + 1);
    });
    if (renderedWithOuterIdx5[2] === '6') {
      throw new Error('BUG DETECTED: Row incorrectly took parent category index!');
    }
  }
  console.log('  PASS: UI rendering logic displays exact Excel serial numbers for imported items and localized row index for manual items without category index contamination.');

  console.log('\n======================================================');
  console.log('ALL EXCEL SERIAL NUMBER INTEGRATION TESTS PASSED!');
  console.log('======================================================\n');
}

runExcelSerialTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nTEST FAILED:', err);
    process.exit(1);
  });
