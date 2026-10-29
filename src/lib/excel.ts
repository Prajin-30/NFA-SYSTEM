import ExcelJS from 'exceljs';
import { v4 as uuid } from 'uuid';
import type { Response } from 'express';
import type { DB } from '../types.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', '..', 'template', 'reference.xlsx');

export async function exportBudgetReportExcel(res: Response, db: DB, department_id?: string, financial_year_id?: string) {
  const fy = db.financial_years.find((f) => f.id === financial_year_id) || db.financial_years.find((f) => f.is_active) || db.financial_years[0];
  const depts = department_id ? db.departments.filter((d) => d.id === department_id) : db.departments;
  const deptName = depts.length === 1 ? depts[0].name : 'All Departments';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CHRIST University NFA & Budget System';
  wb.created = new Date();

  // Sheet 1: Master Budget Summary
  const ws1 = wb.addWorksheet('Budget Summary');
  ws1.columns = [
    { header: 'Department', key: 'dept', width: 30 },
    { header: 'Budget Category', key: 'cat', width: 32 },
    { header: 'Allocated (INR)', key: 'allocated', width: 20 },
    { header: 'Approved / Spent (INR)', key: 'approved', width: 22 },
    { header: 'Pending (INR)', key: 'pending', width: 18 },
    { header: 'Available Balance (INR)', key: 'available', width: 22 },
    { header: 'Utilization %', key: 'util', width: 16 },
  ];

  // Header styling
  const headerRow1 = ws1.getRow(1);
  headerRow1.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B1735' } };
  headerRow1.alignment = { vertical: 'middle', horizontal: 'center' };

  depts.forEach((d) => {
    const lines = db.department_budgets.filter((b) => b.department_id === d.id && b.financial_year_id === fy?.id);
    lines.forEach((l) => {
      const cat = db.budget_categories.find((c) => c.id === l.budget_category_id);
      const avail = l.allocated_amount - l.approved_amount - l.pending_amount;
      const util = l.allocated_amount > 0 ? Math.round(((l.approved_amount + l.pending_amount) / l.allocated_amount) * 100) : 0;
      ws1.addRow({
        dept: d.name,
        cat: cat?.name || 'Uncategorized',
        allocated: l.allocated_amount,
        approved: l.approved_amount,
        pending: l.pending_amount,
        available: avail,
        util: `${util}%`,
      });
    });
  });

  // Sheet 2: NFA Ledger
  const ws2 = wb.addWorksheet('NFA Master Ledger');
  ws2.columns = [
    { header: 'Ref No.', key: 'ref', width: 28 },
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Department', key: 'dept', width: 24 },
    { header: 'Title / Purpose', key: 'title', width: 36 },
    { header: 'Category', key: 'cat', width: 26 },
    { header: 'Amount (INR)', key: 'amount', width: 18 },
    { header: 'Status', key: 'status', width: 22 },
    { header: 'Submitted By', key: 'by', width: 22 },
  ];

  const headerRow2 = ws2.getRow(1);
  headerRow2.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B1735' } };
  headerRow2.alignment = { vertical: 'middle', horizontal: 'center' };

  let nfas = db.nfas;
  if (department_id) nfas = nfas.filter((n) => n.department_id === department_id);
  if (fy) nfas = nfas.filter((n) => n.financial_year_id === fy.id);

  nfas.forEach((n) => {
    const d = db.departments.find((dep) => dep.id === n.department_id);
    const c = db.budget_categories.find((cat) => cat.id === n.budget_category_id);
    ws2.addRow({
      ref: n.ref_no,
      date: n.date,
      dept: d?.name || n.department_id,
      title: n.title,
      cat: c?.name || n.budget_category_id,
      amount: n.total_amount,
      status: n.status.toUpperCase().replace(/_/g, ' '),
      by: n.submitted_by_name || 'Proposer',
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Budget_Report_${deptName.replace(/\s+/g, '_')}_${fy?.label || 'FY'}.xlsx"`);
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

/**
 * Generate standard downloadable blank university budget template Excel file
 */
export async function generateBlankBudgetTemplateExcel(res: Response) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CHRIST University — Finance Department';
  wb.created = new Date();

  const ws = wb.addWorksheet('University Budget Master');
  ws.columns = [
    { header: 'Department Code', key: 'dept_code', width: 20 },
    { header: 'Department Name', key: 'dept_name', width: 35 },
    { header: 'Budget Nature', key: 'nature', width: 25 },
    { header: 'Main Category', key: 'category', width: 35 },
    { header: 'Subcategory / Particulars', key: 'subcategory', width: 40 },
    { header: 'Allocated Amount (INR)', key: 'amount', width: 24 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B1735' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 28;

  // Add sample rows to guide the user
  const sampleData = [
    { dept_code: 'CSE', dept_name: 'Computer Science and Engineering', nature: 'Revenue Expenditure', category: 'Staff Development & Welfare', subcategory: 'Faculty Development Programs (FDP)', amount: 600000 },
    { dept_code: 'CSE', dept_name: 'Computer Science and Engineering', nature: 'Revenue Expenditure', category: 'External Remuneration', subcategory: 'Visiting Faculty & Guest Lectures', amount: 400000 },
    { dept_code: 'CSE', dept_name: 'Computer Science and Engineering', nature: 'CAPEX', category: 'CAPEX: Computing & Servers', subcategory: 'GPU Research Lab (RTX 5060 Workstations)', amount: 1500000 },
    { dept_code: 'ECE', dept_name: 'Electronics and Communication Engineering', nature: 'Revenue Expenditure', category: 'Student Related Expenses', subcategory: 'Technical Fest & Hackathons', amount: 350000 },
    { dept_code: 'MECH', dept_name: 'Mechanical Engineering', nature: 'CAPEX', category: 'CAPEX: Laboratory Infrastructure & Furniture', subcategory: 'Advanced Robotics & Automation Lab', amount: 1200000 },
  ];

  sampleData.forEach((row) => ws.addRow(row));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="CHRIST_University_Budget_Template.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}

export interface MasterBudgetUploadResult {
  departments_count: number;
  categories_count: number;
  subcategories_count: number;
  total_allocated: number;
  items_processed: number;
}

/**
 * Parses and initializes the master university budget from an uploaded Excel file.
 * Admin-only operation. Supports multi-sheet or single sheet workbooks.
 */
export async function parseAndLoadMasterBudgetExcel(
  buffer: Buffer,
  db: DB,
  options: { mode: 'replace' | 'merge'; financial_year_id: string }
): Promise<MasterBudgetUploadResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  const activeFy = db.financial_years.find((f) => f.id === options.financial_year_id) || db.financial_years.find((f) => f.is_active) || db.financial_years[0];
  const fyId = activeFy.id;

  // If mode is 'replace', reset existing department budgets and dummy NFAs for this FY to provide a pristine clean slate
  if (options.mode === 'replace') {
    db.department_budgets = db.department_budgets.filter((b) => b.financial_year_id !== fyId);
    db.nfas = db.nfas.filter((n) => n.financial_year_id !== fyId);
    const nfaIds = new Set(db.nfas.map((n) => n.id));
    db.nfa_items = db.nfa_items.filter((i) => nfaIds.has(i.nfa_id));
    db.approvals = db.approvals.filter((a) => nfaIds.has(a.nfa_id));
  }

  let totalAllocated = 0;
  let itemsProcessed = 0;
  const deptsCreated = new Set<string>();
  const catsCreated = new Set<string>();
  const subcatsCreated = new Set<string>();

  // Process all sheets in the uploaded workbook
  for (const sheet of wb.worksheets) {
    if (sheet.rowCount < 2) continue;

    // Detect column indexes
    let deptCol = -1;
    let deptNameCol = -1;
    let catCol = -1;
    let subcatCol = -1;
    let amountCol = -1;
    let headerRowIdx = 1;

    for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
      const row = sheet.getRow(r);
      let matchCount = 0;
      row.eachCell((cell, colIdx) => {
        const val = String(cell.value || '').trim().toLowerCase();
        if (val.includes('dept code') || val === 'code' || val === 'department code') deptCol = colIdx;
        else if (val.includes('dept') || val.includes('department')) {
          if (deptCol === -1) deptCol = colIdx;
          else deptNameCol = colIdx;
        }
        if (val.includes('main category') || val === 'category' || val.includes('head') || val.includes('budget head')) catCol = colIdx;
        if (val.includes('sub') || val.includes('particular') || val.includes('item') || val.includes('description')) subcatCol = colIdx;
        if (val.includes('amount') || val.includes('allocated') || val.includes('budget') || val.includes('inr') || val.includes('total')) amountCol = colIdx;
        if (deptCol !== -1 || catCol !== -1 || amountCol !== -1) matchCount++;
      });
      if (matchCount >= 2) {
        headerRowIdx = r;
        break;
      }
    }

    if (amountCol === -1) amountCol = Math.min(6, sheet.columnCount);
    if (deptCol === -1) deptCol = 1;
    if (catCol === -1) catCol = 3;
    if (subcatCol === -1) subcatCol = 4;

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowIdx) return;

      const deptVal = String(row.getCell(deptCol).value || '').trim();
      const deptNameVal = deptNameCol !== -1 ? String(row.getCell(deptNameCol).value || '').trim() : '';
      const catVal = String(row.getCell(catCol).value || '').trim();
      const subcatVal = subcatCol !== -1 ? String(row.getCell(subcatCol).value || '').trim() : '';
      const amountCell = row.getCell(amountCol).value;

      let amount = 0;
      if (typeof amountCell === 'number') amount = amountCell;
      else if (typeof amountCell === 'string') amount = Number(amountCell.replace(/[^0-9.-]/g, '')) || 0;
      else if (amountCell && typeof amountCell === 'object' && 'result' in amountCell) {
        amount = Number((amountCell as any).result) || 0;
      }

      if (!deptVal && !catVal && !amount) return;

      // Resolve or create Department
      const deptCodeOrName = deptVal || deptNameVal || 'CSE';
      let dept = db.departments.find(
        (d) => d.code.toLowerCase() === deptCodeOrName.toLowerCase() || d.name.toLowerCase() === deptCodeOrName.toLowerCase()
      );
      if (!dept) {
        dept = {
          id: uuid(),
          name: deptNameVal || deptCodeOrName,
          code: deptCodeOrName.toUpperCase().slice(0, 6),
        };
        db.departments.push(dept);
        deptsCreated.add(dept.id);
      }

      // Resolve or create Budget Category
      const catName = catVal || 'General Department Expenditure';
      let cat = db.budget_categories.find((c) => c.name.toLowerCase() === catName.toLowerCase());
      if (!cat) {
        const isCapex = catName.toLowerCase().includes('capex') || catName.toLowerCase().includes('server') || catName.toLowerCase().includes('equipment');
        const isEarnings = catName.toLowerCase().includes('grant') || catName.toLowerCase().includes('consultancy') || catName.toLowerCase().includes('earning');
        const typeId = isCapex
          ? db.budget_types[1]?.id || 'ecdfc569-50b7-4242-adf2-102a8a3ff266'
          : isEarnings
          ? db.budget_types[2]?.id || '53aa7a65-a652-4e86-beef-c7acf806a48c'
          : db.budget_types[0]?.id || '07831ce8-1440-4100-9df1-ee92019c01eb';

        cat = {
          id: uuid(),
          budget_type_id: typeId,
          name: catName,
        };
        db.budget_categories.push(cat);
        catsCreated.add(cat.id);
      }

      // Resolve or create Subcategory
      if (subcatVal) {
        if (!db.budget_subcategories) db.budget_subcategories = [];
        let subcat = db.budget_subcategories.find(
          (s) => s.budget_category_id === cat!.id && s.name.toLowerCase() === subcatVal.toLowerCase()
        );
        if (!subcat) {
          subcat = {
            id: uuid(),
            budget_category_id: cat.id,
            name: subcatVal,
            allocated_amount: amount,
            approved_amount: 0,
            pending_amount: 0,
          };
          db.budget_subcategories.push(subcat);
          subcatsCreated.add(subcat.id);
        } else {
          subcat.allocated_amount = options.mode === 'replace' ? amount : subcat.allocated_amount + amount;
        }
      }

      // Update or create Department Budget line for this category & department
      let budgetLine = db.department_budgets.find(
        (b) => b.department_id === dept!.id && b.financial_year_id === fyId && b.budget_category_id === cat!.id
      );

      if (!budgetLine) {
        budgetLine = {
          id: uuid(),
          department_id: dept.id,
          financial_year_id: fyId,
          budget_category_id: cat.id,
          allocated_amount: amount,
          approved_amount: 0,
          pending_amount: 0,
          revised_amount: 0,
        };
        db.department_budgets.push(budgetLine);
      } else {
        budgetLine.allocated_amount = options.mode === 'replace' ? budgetLine.allocated_amount + amount : Math.max(budgetLine.allocated_amount, amount);
      }

      totalAllocated += amount;
      itemsProcessed++;
    });
  }

  return {
    departments_count: deptsCreated.size,
    categories_count: catsCreated.size,
    subcategories_count: subcatsCreated.size,
    total_allocated: totalAllocated,
    items_processed: itemsProcessed,
  };
}

