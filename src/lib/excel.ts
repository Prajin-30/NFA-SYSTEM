import ExcelJS from 'exceljs';
import type { Response } from 'express';
import type { DB } from '../types.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', '..', 'template', 'reference.xlsx');

/**
 * Export: one workbook per department/financial year, one sheet per budget category,
 * plus a summary sheet - mirrors the structure of the original CSE budget workbook
 * (SL NO / ITEMS / QTY / RATE / AMOUNT columns) so it round-trips cleanly.
 */
export async function exportDepartmentBudgetExcel(res: Response, db: DB, department_id: string, financial_year_id: string) {
  const dept = db.departments.find((d) => d.id === department_id);
  const fy = db.financial_years.find((f) => f.id === financial_year_id);
  if (!dept) throw new Error('Department not found');
  if (!fy) throw new Error('Financial year not found');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const set = (sheet: string, cell: string, value: string | number) => { wb.getWorksheet(sheet).getCell(cell).value = value; };
  set('List', 'C4', fy.label);
  set('Department Budget', 'A3', `DEPARTMENT: ${dept.code}`);
  set('Department Budget', 'B4', dept.hod_name || '');
  set('Department Budget', 'F4', dept.dean_name || '');
  set('Revenue or Earnings', 'C3', dept.name);
  set('Revenue or Earnings', 'B4', dept.hod_name || '');
  set('Revenue or Earnings', 'F4', `DEAN: ${dept.dean_name || ''}`);
  set('Revenue Expenditures', 'C3', dept.name);
  set('CAPEX', 'A3', `DEPARTMENT: ${dept.name}`);
  set('CAPEX', 'B4', dept.hod_name || '');
  set('CAPEX', 'F4', `DEAN: ${dept.dean_name || ''}`);
  set('Fest and Other Events', 'C3', dept.name);
  set('man power', 'A3', `Department: ${dept.name}`);

  const nfas = db.nfas.filter((n) => n.department_id === department_id && n.financial_year_id === financial_year_id && n.status === 'approved');
  const project = nfas[0];
  if (project) {
    set('Revenue Expenditures', 'B50', project.title);
    set('Revenue Expenditures', 'C50', project.description || project.purpose || '');
    set('Revenue Expenditures', 'F50', project.total_amount);
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${dept.code}_budget_${fy.label}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

export interface ExcelDiffRow {
  particulars: string;
  old_amount: number | null;
  new_amount: number;
  difference: number;
  matched_nfa_id: string | null;
  change_type?: 'changed' | 'new';
}

export interface ExcelSheetPreview {
  name: string;
  rows: number;
  columns: number;
  headers: string[];
}

export async function inspectExcelWorkbook(buffer: Buffer): Promise<ExcelSheetPreview[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb.worksheets.map((sheet) => ({
    name: sheet.name,
    rows: sheet.rowCount,
    columns: sheet.columnCount,
    headers: (sheet.getRow(4).values as ExcelJS.CellValue[]).slice(1).concat((sheet.getRow(5).values as ExcelJS.CellValue[]).slice(1)).filter(Boolean).map(String).slice(0, 12),
  }));
}

/**
 * Import (step 1 of 2 - preview only, per requirement #13/#14): parses the uploaded
 * 'Revenue Expenditures' sheet, matches rows to existing NFA items by particulars name,
 * and returns a diff. Nothing is written to the DB here - confirmDiff() does that.
 */
export async function parseExcelDiff(buffer: Buffer, db: DB, department_id: string, financial_year_id: string): Promise<ExcelDiffRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const sheet = wb.getWorksheet('Revenue Expenditures');
  if (!sheet) throw new Error("Uploaded workbook has no 'Revenue Expenditures' sheet");

  let headerRow = 1;
  let particularsColumn = 2;
  let amountColumn = 4;
  sheet.eachRow((row, rowNumber) => {
    row.eachCell((cell, columnNumber) => {
      const value = String(cell.value || '').replace(/\s+/g, ' ').trim().toUpperCase();
      if (value.includes('REVENUE EXP') && value.includes('ITEM')) {
        headerRow = rowNumber;
        particularsColumn = columnNumber;
      }
      if (value.includes('AMOUNT BUDGETED')) amountColumn = columnNumber;
    });
  });

  const existingItems = db.nfa_items
    .map((it) => ({ it, nfa: db.nfas.find((n) => n.id === it.nfa_id)! }))
    .filter(({ nfa }) => nfa && nfa.department_id === department_id && nfa.financial_year_id === financial_year_id && nfa.status === 'approved');

  const diffs: ExcelDiffRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const particulars = String(row.getCell(particularsColumn).value || '').trim();
    const amountCell = row.getCell(amountColumn).value;
    const newAmount = typeof amountCell === 'number' ? amountCell : Number(amountCell) || 0;
    if (!particulars || !newAmount) return;

    const match = existingItems.find(({ it }) => it.particulars.trim().toLowerCase() === particulars.toLowerCase());
    if (match) {
      if (match.it.amount !== newAmount) {
        diffs.push({
          particulars,
          old_amount: match.it.amount,
          new_amount: newAmount,
          difference: newAmount - match.it.amount,
          matched_nfa_id: match.nfa.id,
          change_type: 'changed',
        });
      }
    } else {
      diffs.push({ particulars, old_amount: null, new_amount: newAmount, difference: newAmount, matched_nfa_id: null, change_type: 'new' });
    }
  });

  return diffs;
}
