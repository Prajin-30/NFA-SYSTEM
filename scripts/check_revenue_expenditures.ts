import ExcelJS from 'exceljs';
import path from 'path';

async function checkRevenueExpenditures() {
  const filePath = path.resolve('template', 'reference.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const sheet = wb.getWorksheet('Revenue Expenditures');
  if (!sheet) {
    console.log('Sheet not found!');
    return;
  }

  console.log(`Sheet: ${sheet.name}, Rows: ${sheet.rowCount}`);
  for (let r = 1; r <= 80; r++) {
    const row = sheet.getRow(r);
    const slCell = row.getCell(1).value;
    let sl = slCell;
    if (sl && typeof sl === 'object' && 'result' in sl) sl = (sl as any).result;

    const itemCell = row.getCell(2).value;
    let item = itemCell;
    if (item && typeof item === 'object') {
      if ('richText' in item) item = (item as any).richText.map((t: any) => t.text).join('');
      else if ('result' in item) item = (item as any).result;
    }

    const amtCell = row.getCell(6).value;
    let amt = amtCell;
    if (amt && typeof amt === 'object' && 'result' in amt) amt = (amt as any).result;

    if (sl !== null || item !== null || amt !== null) {
      console.log(`Row ${r}: SL=[${sl}] | Item=[${item}] | Amt=[${amt}]`);
    }
  }
}

checkRevenueExpenditures().catch(console.error);
