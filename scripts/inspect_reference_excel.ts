import ExcelJS from 'exceljs';
import path from 'path';

async function inspectReference() {
  const filePath = path.resolve('template', 'reference.xlsx');
  console.log('Inspecting:', filePath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  console.log('Worksheets:', wb.worksheets.map(w => w.name));

  for (const sheet of wb.worksheets) {
    console.log(`\n--- Sheet: ${sheet.name} (Rows: ${sheet.rowCount}, Cols: ${sheet.columnCount}) ---`);
    for (let r = 1; r <= Math.min(25, sheet.rowCount); r++) {
      const row = sheet.getRow(r);
      const vals: any[] = [];
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        vals.push(`[C${colNumber}] ${JSON.stringify(cell.value)}`);
      });
      if (vals.length > 0) {
        console.log(`Row ${r}:`, vals.slice(0, 6).join(' | '));
      }
    }
  }
}

inspectReference().catch(console.error);
