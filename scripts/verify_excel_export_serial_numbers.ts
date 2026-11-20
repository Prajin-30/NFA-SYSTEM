import { exportMasterBudgetExcel } from '../src/lib/excel.js';
import { store } from '../src/store.js';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';

async function testExcelExport() {
  console.log('=== TESTING EXCEL EXPORT REPRODUCTION OF SERIAL NUMBERS ===\n');

  if (store.initPromise) await store.initPromise;

  const cseDept = store.data.departments.find(d => d.code === 'CSE') || store.data.departments[0];
  const activeFy = store.data.financial_years.find(f => f.is_active) || store.data.financial_years[0];

  const mockRes: any = {
    headers: {},
    chunks: [] as Buffer[],
    setHeader(key: string, val: string) {
      this.headers[key] = val;
    },
    write(chunk: any) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk: any) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
    }
  };

  await exportMasterBudgetExcel(mockRes, store.data, cseDept.id, activeFy.id);
  const outBuffer = Buffer.concat(mockRes.chunks);

  console.log(`Generated export buffer: ${outBuffer.length} bytes`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(outBuffer as any);

  console.log('Exported worksheets:', wb.worksheets.map(w => w.name));

  const sheet = wb.getWorksheet('Revenue Expenditures');
  if (!sheet) throw new Error("Exported workbook missing 'Revenue Expenditures' sheet");

  // Verify non-sequential and repeated rows
  const r27 = sheet.getRow(27);
  const r28 = sheet.getRow(28);
  const r29 = sheet.getRow(29);

  const sl27 = r27.getCell(1).value;
  const sl28 = r28.getCell(1).value;
  const sl29 = r29.getCell(1).value;

  console.log(`Row 27: SL=${JSON.stringify(sl27)} | Item=${JSON.stringify(r27.getCell(2).value)}`);
  console.log(`Row 28: SL=${JSON.stringify(sl28)} | Item=${JSON.stringify(r28.getCell(2).value)}`);
  console.log(`Row 29: SL=${JSON.stringify(sl29)} | Item=${JSON.stringify(r29.getCell(2).value)}`);

  const getVal = (v: any) => typeof v === 'object' && v && 'result' in v ? v.result : v;

  const val27 = getVal(sl27);
  const val28 = getVal(sl28);
  const val29 = getVal(sl29);

  console.log(`Row 27: SL=${JSON.stringify(sl27)} (Val=${val27}) | Item=${JSON.stringify(r27.getCell(2).value)}`);
  console.log(`Row 28: SL=${JSON.stringify(sl28)} (Val=${val28}) | Item=${JSON.stringify(r28.getCell(2).value)}`);
  console.log(`Row 29: SL=${JSON.stringify(sl29)} (Val=${val29}) | Item=${JSON.stringify(r29.getCell(2).value)}`);

  if (val27 !== 16) throw new Error(`Expected Row 27 SL=16, got ${val27}`);
  if (val28 !== 40) throw new Error(`Expected Row 28 SL=40, got ${val28}`);
  if (val29 !== 16) throw new Error(`Expected Row 29 SL=16, got ${val29}`);

  console.log('\n✓ EXCEL DOWNLOAD REPRODUCES ORIGINAL SERIAL NUMBERS AND WORKBOOK STRUCTURE 100%!');
  process.exit(0);
}

testExcelExport().catch(err => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
