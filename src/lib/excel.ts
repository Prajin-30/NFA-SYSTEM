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

import fs from 'fs';

const uploadsDir = path.join(__dirname, '..', '..', 'data', 'budget-uploads');

export interface MasterBudgetUploadResult {
  departments_count: number;
  categories_count: number;
  subcategories_count: number;
  total_allocated: number;
  items_processed: number;
}

// In-memory cache for upload preview staging
export interface CachedPreview {
  buffer: Buffer;
  filename: string;
  preview: MasterBudgetPreviewResponse;
  created_at: number;
}

export const previewCache = new Map<string, CachedPreview>();

// Clean up previews older than 1 hour periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of previewCache.entries()) {
    if (now - item.created_at > 3600000) {
      previewCache.delete(id);
    }
  }
}, 600000).unref();

import type {
  MasterBudgetPreviewResponse,
  MasterBudgetSheetPreview,
  MasterBudgetCategoryPreview,
  MasterBudgetSubcategoryPreview,
  Role,
} from '../types.js';

/**
 * Requirement #2 & #3: Analyze multi-sheet workbook, detect hierarchy, categories,
 * subcategories, cell references, and compare declared totals. Returns preview without saving.
 */
export async function analyzeMasterBudgetWorkbook(
  buffer: Buffer,
  filename: string,
  db: DB,
  defaults?: { department_id?: string; financial_year_id?: string }
): Promise<MasterBudgetPreviewResponse> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  const sheetsPreview: MasterBudgetSheetPreview[] = [];
  const categoriesMap = new Map<string, MasterBudgetCategoryPreview>();
  let totalAllocated = 0;
  const warnings: string[] = [];
  const errors: string[] = [];

  let detectedDeptCodeOrName: string | undefined;
  let detectedAcademicYear: string | undefined;

  // 1. Scan sheets for overall metadata (e.g. List, Department Budget)
  for (const sheet of wb.worksheets) {
    const sName = sheet.name.trim();

    // Check List sheet for Academic Year
    if (sName.toLowerCase() === 'list') {
      sheet.eachRow((row) => {
        const itemVal = String(row.getCell(2).value || '').trim().toLowerCase();
        const inputVal = String(row.getCell(3).value || '').trim();
        if (itemVal.includes('academic year') && inputVal) {
          detectedAcademicYear = inputVal;
        }
      });
    }

    // Check Department Budget or headers for Department & Academic Year
    for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
      const row = sheet.getRow(r);
      row.eachCell((cell) => {
        let text = '';
        if (typeof cell.value === 'string') text = cell.value.trim();
        else if (cell.value && typeof cell.value === 'object' && 'result' in cell.value) {
          text = String((cell.value as any).result || '').trim();
        }
        if (!text) return;

        const lower = text.toLowerCase();
        if (lower.startsWith('department:')) {
          const raw = text.replace(/^department:\s*/i, '').trim();
          if (raw && !detectedDeptCodeOrName) detectedDeptCodeOrName = raw;
        }
        if (lower.includes('academic year -') || lower.includes('academic year:')) {
          const match = text.match(/\d{4}[-/]\d{2,4}/);
          if (match && !detectedAcademicYear) detectedAcademicYear = match[0];
        }
      });
    }
  }

  // 2. Process each sheet
  for (const sheet of wb.worksheets) {
    const sName = sheet.name.trim();
    const lowerSheetName = sName.toLowerCase();

    // Skip non-financial sheets
    if (lowerSheetName === 'list') {
      sheetsPreview.push({
        name: sName,
        sheet_type: 'skipped',
        reason: 'Lookup and metadata configuration sheet',
        extracted_total: 0,
        categories_count: 0,
        items_count: 0,
      });
      continue;
    }

    if (lowerSheetName.includes('man power') || lowerSheetName.includes('workload')) {
      sheetsPreview.push({
        name: sName,
        sheet_type: 'skipped',
        reason: 'Departmental workload statement (workload formulas & teaching hours, non-financial)',
        extracted_total: 0,
        categories_count: 0,
        items_count: 0,
      });
      warnings.push(`Ignored non-financial workload sheet '${sName}'`);
      continue;
    }

    if (lowerSheetName === 'department budget') {
      sheetsPreview.push({
        name: sName,
        sheet_type: 'summary',
        reason: 'Consolidated master summary sheet (formula-driven department overview)',
        extracted_total: 0,
        categories_count: 0,
        items_count: 0,
      });
      continue;
    }

    // Identify header row and key columns
    let headerRowIdx = -1;
    let slCol = -1;
    let itemCol = -1;
    let amountCol = -1;
    let catCol = -1;
    let subcatCol = -1;
    let deptCol = -1;
    let natureCol = -1;

    for (let r = 1; r <= Math.min(15, sheet.rowCount); r++) {
      const row = sheet.getRow(r);
      row.eachCell((cell, col) => {
        const val = String(cell.value || '').trim().toLowerCase();
        if (val.includes('item') || val.includes('particular') || val.includes('earnings') || val.includes('categories')) {
          if (itemCol === -1) {
            itemCol = col;
            headerRowIdx = r;
          }
        }
        if (val.includes('amount') || val.includes('cost') || val.includes('approx') || val.includes('budgeted')) {
          if (amountCol === -1) {
            amountCol = col;
            headerRowIdx = r;
          }
        }
        if (val.includes('sl no') || val === 'sl' || val === 'sl.') {
          if (slCol === -1) slCol = col;
        }
        if (val.includes('main category') || val === 'category' || val.includes('budget head')) catCol = col;
        if (val.includes('sub') || val.includes('particulars')) subcatCol = col;
        if (val.includes('dept') || val.includes('department')) deptCol = col;
        if (val.includes('nature') || val.includes('type')) natureCol = col;
      });
      if (itemCol !== -1 && amountCol !== -1) break;
    }

    if (itemCol === -1 || amountCol === -1) {
      sheetsPreview.push({
        name: sName,
        sheet_type: 'skipped',
        reason: 'No budget item and amount columns detected',
        extracted_total: 0,
        categories_count: 0,
        items_count: 0,
      });
      continue;
    }

    // Determine Budget Nature / Type
    let budgetTypeName = 'Revenue Expenditure';
    if (lowerSheetName.includes('capex') || lowerSheetName.includes('capital')) {
      budgetTypeName = 'CAPEX';
    } else if (lowerSheetName.includes('earning') || lowerSheetName.includes('income')) {
      budgetTypeName = 'Revenue / Earnings';
    }

    let currentCategory = sName;
    if (budgetTypeName === 'CAPEX') currentCategory = 'CAPEX: Infrastructure & Equipment';
    else if (budgetTypeName === 'Revenue / Earnings') currentCategory = 'Academic & Research Earnings';

    let declaredTotal: number | undefined;
    let sheetExtractedTotal = 0;
    let sheetItemsCount = 0;
    const sheetCategories = new Set<string>();

    let pendingParentItem: { name: string; row: number } | null = null;

    for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);

      // Check if row indicates a Grand Total row in the label columns (slCol or itemCol)
      const labelText = (
        (slCol !== -1 ? String(row.getCell(slCol).value || '') : '') +
        ' ' +
        (itemCol !== -1 ? String(row.getCell(itemCol).value || '') : '')
      ).trim().toLowerCase();

      if (
        labelText.startsWith('total') ||
        labelText.includes('total revenue') ||
        labelText.includes('total capex') ||
        labelText.includes('total earnings') ||
        labelText.includes('total income') ||
        labelText.includes('total expenditure') ||
        labelText.includes('grand total')
      ) {
        const amtCell = row.getCell(amountCol).value;
        if (typeof amtCell === 'number') declaredTotal = amtCell;
        else if (amtCell && typeof amtCell === 'object' && 'result' in amtCell) {
          declaredTotal = Number((amtCell as any).result) || 0;
        } else if (typeof amtCell === 'string') {
          declaredTotal = Number(amtCell.replace(/[^0-9.-]/g, '')) || 0;
        }
        break; // Stop parsing data rows once grand total is reached
      }

      const slCell = slCol !== -1 ? row.getCell(slCol).value : null;
      const itemCell = row.getCell(itemCol).value;
      const amountCell = row.getCell(amountCol).value;

      let slVal = slCell;
      if (slVal && typeof slVal === 'object' && 'result' in slVal) slVal = slVal.result;

      let itemText = '';
      if (typeof itemCell === 'string') itemText = itemCell.trim();
      else if (itemCell && typeof itemCell === 'object') {
        if ('richText' in itemCell && Array.isArray((itemCell as any).richText)) {
          itemText = (itemCell as any).richText.map((t: any) => t.text).join('').trim();
        } else if ('result' in itemCell) {
          itemText = String((itemCell as any).result).trim();
        }
      }

      let amountVal = 0;
      if (typeof amountCell === 'number') amountVal = amountCell;
      else if (typeof amountCell === 'string') amountVal = Number(amountCell.replace(/[^0-9.-]/g, '')) || 0;
      else if (amountCell && typeof amountCell === 'object' && 'result' in amountCell) {
        amountVal = Number((amountCell as any).result) || 0;
      }

      if (!itemText && !amountVal) continue;

      const lowerItem = itemText.toLowerCase();

      // Check footnote or instructions to ignore
      if (
        lowerItem.startsWith('note:') ||
        lowerItem.startsWith('1. ') ||
        lowerItem.startsWith('2. ') ||
        lowerItem.startsWith('3. ') ||
        lowerItem.startsWith('4. ') ||
        lowerItem.startsWith('5. ') ||
        lowerItem.startsWith('6. ') ||
        lowerItem.startsWith('7. ') ||
        lowerItem.startsWith('8. ') ||
        lowerItem.startsWith('date:') ||
        lowerItem.startsWith('hod') ||
        lowerItem.startsWith('dean')
      ) {
        continue;
      }

      // Check section header / Main Category (e.g. in hierarchical sheets where row has item text, no amount, and no SL)
      const isSectionHeader = (!slVal || slVal === null || slVal === undefined) && amountVal === 0 && !itemText.startsWith('(') && itemText.length > 2;
      if (
        isSectionHeader &&
        (sName === 'Revenue Expenditures' ||
          lowerItem.includes('remuneration') ||
          lowerItem.includes('welfare') ||
          lowerItem.includes('expenses') ||
          lowerItem.includes('others'))
      ) {
        currentCategory = itemText;
        pendingParentItem = null;
        continue;
      }

      // Handle items with 0 on row N, followed by amount on row N+1 (e.g. Meeting Expenses)
      if (amountVal === 0 && !itemText.startsWith('(') && itemText.length > 3) {
        pendingParentItem = { name: itemText, row: r };
        continue;
      }

      // Valid budget item with an amount
      if (amountVal > 0) {
        let finalItemName = itemText;
        let finalRow = r;
        if (itemText.startsWith('(') && pendingParentItem) {
          finalItemName = pendingParentItem.name;
          finalRow = r;
          pendingParentItem = null;
        }

        const cellAddress = sheet.getCell(r, amountCol).address;

        // Tabular template override if explicit Category column exists
        let finalCatName = currentCategory;
        if (catCol !== -1 && subcatCol !== -1) {
          const directCat = String(row.getCell(catCol).value || '').trim();
          const directSubcat = String(row.getCell(subcatCol).value || '').trim();
          if (directCat) finalCatName = directCat;
          if (directSubcat) finalItemName = directSubcat;
          if (natureCol !== -1) {
            const directNature = String(row.getCell(natureCol).value || '').trim();
            if (directNature) budgetTypeName = directNature;
          }
        }

        if (!categoriesMap.has(finalCatName)) {
          categoriesMap.set(finalCatName, {
            category_name: finalCatName,
            budget_type_name: budgetTypeName,
            allocated_amount: 0,
            cell_address: cellAddress,
            subcategories: [],
          });
        }

        const catData = categoriesMap.get(finalCatName)!;
        catData.allocated_amount += amountVal;
        catData.subcategories.push({
          name: finalItemName,
          allocated_amount: amountVal,
          cell_address: cellAddress,
          row: finalRow,
          col: amountCol,
        });

        sheetCategories.add(finalCatName);
        sheetExtractedTotal += amountVal;
        sheetItemsCount++;
        totalAllocated += amountVal;
      }
    }

    const variance = declaredTotal !== undefined ? sheetExtractedTotal - declaredTotal : undefined;
    if (variance !== undefined && variance !== 0) {
      warnings.push(`Worksheet '${sName}': Extracted total (₹${sheetExtractedTotal.toLocaleString('en-IN')}) differs from declared total (₹${declaredTotal!.toLocaleString('en-IN')}) by ₹${variance.toLocaleString('en-IN')}`);
    }

    sheetsPreview.push({
      name: sName,
      sheet_type: 'financial',
      budget_type_name: budgetTypeName,
      declared_total: declaredTotal,
      extracted_total: sheetExtractedTotal,
      variance,
      categories_count: sheetCategories.size,
      items_count: sheetItemsCount,
    });
  }

  // Resolve department matching
  let matchedDept: { id?: string; code?: string; name?: string } | undefined;
  if (defaults?.department_id) {
    const d = db.departments.find((dep) => dep.id === defaults.department_id);
    if (d) matchedDept = { id: d.id, code: d.code, name: d.name };
  } else if (detectedDeptCodeOrName) {
    const search = detectedDeptCodeOrName.toLowerCase();
    const d = db.departments.find((dep) => dep.code.toLowerCase() === search || dep.name.toLowerCase().includes(search) || search.includes(dep.code.toLowerCase()));
    if (d) matchedDept = { id: d.id, code: d.code, name: d.name };
    else matchedDept = { name: detectedDeptCodeOrName, code: detectedDeptCodeOrName.slice(0, 6).toUpperCase() };
  }

  // Resolve financial year matching
  let matchedFy: { id?: string; label?: string } | undefined;
  if (defaults?.financial_year_id) {
    const fy = db.financial_years.find((f) => f.id === defaults.financial_year_id);
    if (fy) matchedFy = { id: fy.id, label: fy.label };
  } else if (detectedAcademicYear) {
    const fy = db.financial_years.find((f) => f.label.toLowerCase() === detectedAcademicYear!.toLowerCase());
    if (fy) matchedFy = { id: fy.id, label: fy.label };
    else matchedFy = { label: detectedAcademicYear };
  } else {
    const activeFy = db.financial_years.find((f) => f.is_active) || db.financial_years[0];
    if (activeFy) matchedFy = { id: activeFy.id, label: activeFy.label };
  }

  const previewId = uuid();
  const response: MasterBudgetPreviewResponse = {
    preview_id: previewId,
    filename,
    detected_department: matchedDept,
    detected_financial_year: matchedFy,
    sheets: sheetsPreview,
    categories: Array.from(categoriesMap.values()),
    total_allocated: totalAllocated,
    warnings,
    errors,
  };

  // Cache buffer and preview for confirmation step
  previewCache.set(previewId, {
    buffer,
    filename,
    preview: response,
    created_at: Date.now(),
  });

  return response;
}

/**
 * Requirement #3 & #13: Confirm and safely apply the previewed master budget import.
 * Supports 'replace' or 'merge'. CRITICAL: Never deletes existing NFAs or approval history.
 */
export async function applyMasterBudgetImport(
  previewId: string,
  options: {
    mode: 'replace' | 'merge';
    department_id: string;
    financial_year_id: string;
    user_id: string;
    role: Role;
  },
  db: DB
): Promise<MasterBudgetUploadResult> {
  const cached = previewCache.get(previewId);
  if (!cached) {
    throw new Error('Preview session expired or not found. Please upload the workbook again to generate a fresh preview.');
  }

  const { buffer, filename, preview } = cached;
  const deptId = options.department_id;
  const fyId = options.financial_year_id;

  // Verify department and financial year exist
  let dept = db.departments.find((d) => d.id === deptId);
  if (!dept) {
    // If department was detected by name from preview, create it
    if (preview.detected_department?.name) {
      dept = {
        id: deptId || uuid(),
        name: preview.detected_department.name,
        code: preview.detected_department.code || 'DEPT',
      };
      db.departments.push(dept);
    } else {
      throw new Error('Department not found in database');
    }
  }

  let fy = db.financial_years.find((f) => f.id === fyId);
  if (!fy) {
    if (preview.detected_financial_year?.label) {
      fy = {
        id: fyId || uuid(),
        label: preview.detected_financial_year.label,
        is_active: false,
      };
      db.financial_years.push(fy);
    } else {
      throw new Error('Financial year not found in database');
    }
  }

  // Save the uploaded workbook to data/budget-uploads/
  fs.mkdirSync(uploadsDir, { recursive: true });
  const uploadId = uuid();
  const cleanFilename = `${uploadId}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const storedFilePath = path.join(uploadsDir, cleanFilename);
  fs.writeFileSync(storedFilePath, buffer);

  let totalAllocated = 0;
  let itemsProcessed = 0;
  const catsProcessed = new Set<string>();
  const subcatsProcessed = new Set<string>();
  const cellMappings: Array<{ sheet_name: string; cell_address: string; category_id?: string; subcategory_id?: string; field: string }> = [];

  // In 'replace' mode, we replace budget allocations for this dept and FY,
  // but PRESERVE existing NFAs, approved commitments, and pending reservations!
  // If a category was previously allocated and has approved NFAs, we keep its approved_amount.
  const existingBudgetLines = db.department_budgets.filter((b) => b.department_id === dept!.id && b.financial_year_id === fy!.id);

  if (options.mode === 'replace') {
    // Zero out old allocations before setting new ones, but retain approved/pending figures
    existingBudgetLines.forEach((b) => {
      b.allocated_amount = 0;
    });
  }

  for (const catPreview of preview.categories) {
    // 1. Resolve or create BudgetType
    const typeName = catPreview.budget_type_name || 'Revenue Expenditure';
    let bType = db.budget_types.find((t) => t.name.toLowerCase() === typeName.toLowerCase());
    if (!bType) {
      bType = { id: uuid(), name: typeName };
      db.budget_types.push(bType);
    }

    // 2. Resolve or create BudgetCategory
    let cat = db.budget_categories.find((c) => c.name.toLowerCase() === catPreview.category_name.toLowerCase());
    if (!cat) {
      cat = {
        id: uuid(),
        budget_type_id: bType.id,
        name: catPreview.category_name,
      };
      db.budget_categories.push(cat);
    }
    catsProcessed.add(cat.id);

    // 3. Process Subcategories and Cell Mappings
    if (!db.budget_subcategories) db.budget_subcategories = [];

    let categorySum = 0;
    for (const subPreview of catPreview.subcategories) {
      let subcat = db.budget_subcategories.find(
        (s) => s.budget_category_id === cat!.id && s.name.toLowerCase() === subPreview.name.toLowerCase()
      );

      const cellMap = {
        sheet_name: catPreview.budget_type_name === 'CAPEX' ? 'CAPEX' : catPreview.budget_type_name === 'Revenue / Earnings' ? 'Revenue or Earnings' : 'Revenue Expenditures',
        cell_address: subPreview.cell_address,
        row: subPreview.row,
        col: subPreview.col,
        original_value: subPreview.allocated_amount,
      };

      if (!subcat) {
        subcat = {
          id: uuid(),
          budget_category_id: cat.id,
          department_id: dept.id,
          name: subPreview.name,
          allocated_amount: subPreview.allocated_amount,
          approved_amount: 0,
          pending_amount: 0,
          cell_mapping: cellMap,
        };
        db.budget_subcategories.push(subcat);
      } else {
        subcat.allocated_amount = subPreview.allocated_amount;
        subcat.cell_mapping = cellMap;
      }

      subcatsProcessed.add(subcat.id);
      cellMappings.push({
        sheet_name: cellMap.sheet_name,
        cell_address: cellMap.cell_address,
        category_id: cat.id,
        subcategory_id: subcat.id,
        field: 'allocated',
      });

      categorySum += subPreview.allocated_amount;
      itemsProcessed++;
    }

    // If category has no subcategories, use catPreview.allocated_amount
    const finalAllocated = catPreview.subcategories.length > 0 ? categorySum : catPreview.allocated_amount;

    // 4. Update or create DepartmentBudget line
    let budgetLine = db.department_budgets.find(
      (b) => b.department_id === dept!.id && b.financial_year_id === fy!.id && b.budget_category_id === cat!.id
    );

    if (!budgetLine) {
      budgetLine = {
        id: uuid(),
        department_id: dept.id,
        financial_year_id: fy.id,
        budget_category_id: cat.id,
        allocated_amount: finalAllocated,
        approved_amount: 0,
        pending_amount: 0,
        revised_amount: 0,
        cell_mapping: catPreview.cell_address
          ? {
              sheet_name: catPreview.budget_type_name === 'CAPEX' ? 'CAPEX' : catPreview.budget_type_name === 'Revenue / Earnings' ? 'Revenue or Earnings' : 'Revenue Expenditures',
              cell_address: catPreview.cell_address,
              row: 0,
              col: 0,
              original_value: finalAllocated,
            }
          : undefined,
      };
      db.department_budgets.push(budgetLine);
    } else {
      budgetLine.allocated_amount = finalAllocated;
      if (catPreview.cell_address) {
        budgetLine.cell_mapping = {
          sheet_name: catPreview.budget_type_name === 'CAPEX' ? 'CAPEX' : catPreview.budget_type_name === 'Revenue / Earnings' ? 'Revenue or Earnings' : 'Revenue Expenditures',
          cell_address: catPreview.cell_address,
          row: 0,
          col: 0,
          original_value: finalAllocated,
        };
      }
    }

    totalAllocated += finalAllocated;
  }

  // Mark previous master uploads for this dept & FY as archived
  db.budget_uploads.forEach((u) => {
    if (u.department_id === dept!.id && u.financial_year_id === fy!.id && u.is_master) {
      u.status = 'archived';
    }
  });

  // Save new active budget upload
  const uploadRecord = {
    id: uploadId,
    financial_year_id: fy.id,
    department_id: dept.id,
    filename,
    stored_filename: cleanFilename,
    uploaded_by: options.user_id,
    uploaded_at: new Date().toISOString(),
    status: 'active' as const,
    is_master: true,
    sheets_info: preview.sheets,
    cell_mappings: cellMappings,
  };
  db.budget_uploads.push(uploadRecord);

  // Version history & Audit trail
  db.budget_changes.push({
    id: uuid(),
    version: db.budget_changes.length + 1,
    financial_year_id: fy.id,
    department_id: dept.id,
    project_id: null,
    changed_by: options.user_id,
    action: `Master Budget ${options.mode === 'replace' ? 'Replacement' : 'Merge'}`,
    previous_value: '',
    new_value: `₹${totalAllocated.toLocaleString('en-IN')}`,
    description: `Imported '${filename}' (${options.mode} mode) for ${dept.name} (${fy.label}): ${itemsProcessed} items across ${catsProcessed.size} categories.`,
    approval_status: 'approved',
    created_at: uploadRecord.uploaded_at,
  });

  db.audit_logs.push({
    id: uuid(),
    entity_type: 'department_budget',
    entity_id: fy.id,
    department_id: dept.id,
    old_amount: null,
    new_amount: totalAllocated,
    difference: totalAllocated,
    changed_by: options.user_id,
    role: options.role,
    reason: `Master budget import confirmed (${options.mode} mode): ${filename} -> Total allocation ₹${totalAllocated.toLocaleString('en-IN')}`,
    source: 'excel',
    approval_status: 'confirmed',
    created_at: uploadRecord.uploaded_at,
  });

  // Remove preview from cache once confirmed
  previewCache.delete(previewId);

  return {
    departments_count: 1,
    categories_count: catsProcessed.size,
    subcategories_count: subcatsProcessed.size,
    total_allocated: totalAllocated,
    items_processed: itemsProcessed,
  };
}

/**
 * Requirement #11 & #12: Export budget to Excel in the ORIGINAL format.
 * Loads the original uploaded multi-sheet workbook (or template), preserves all sheets,
 * layout, styles, merged cells, formulas, colors, and updates only the mapped budget cells.
 */
export async function exportMasterBudgetExcel(res: Response, db: DB, department_id?: string, financial_year_id?: string) {
  const fy = db.financial_years.find((f) => f.id === financial_year_id) || db.financial_years.find((f) => f.is_active) || db.financial_years[0];
  const dept = department_id ? db.departments.find((d) => d.id === department_id) : undefined;
  const deptName = dept ? dept.name : 'Master Department Budget';

  // Locate active master workbook
  let sourceFilePath: string = templatePath;
  const activeUpload = db.budget_uploads
    .slice()
    .reverse()
    .find((u) => u.is_master && (!department_id || u.department_id === department_id) && (!fy || u.financial_year_id === fy.id) && fs.existsSync(path.join(uploadsDir, u.stored_filename)));

  if (activeUpload) {
    sourceFilePath = path.join(uploadsDir, activeUpload.stored_filename);
  } else if (!fs.existsSync(sourceFilePath)) {
    // Fall back to clean tabular export if template does not exist
    return exportBudgetReportExcel(res, db, department_id, financial_year_id);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(sourceFilePath);

  // Update mapped cells with latest website values
  const allSubcats = db.budget_subcategories || [];
  allSubcats.forEach((subcat) => {
    if (subcat.cell_mapping && subcat.cell_mapping.sheet_name && subcat.cell_mapping.cell_address) {
      const ws = wb.getWorksheet(subcat.cell_mapping.sheet_name);
      if (ws) {
        const cell = ws.getCell(subcat.cell_mapping.cell_address);
        cell.value = subcat.allocated_amount;
      }
    }
  });

  // Also update category-level lines if directly mapped
  db.department_budgets.forEach((line) => {
    if (line.cell_mapping && line.cell_mapping.sheet_name && line.cell_mapping.cell_address) {
      const ws = wb.getWorksheet(line.cell_mapping.sheet_name);
      if (ws) {
        const cell = ws.getCell(line.cell_mapping.cell_address);
        cell.value = line.allocated_amount;
      }
    }
  });

  const filename = `CHRIST_University_Master_Budget_${(dept?.code || 'Master').replace(/[^a-zA-Z0-9]/g, '_')}_${(fy?.label || 'FY').replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

/** Legacy wrapper kept for backward compatibility */
export async function parseAndLoadMasterBudgetExcel(
  buffer: Buffer,
  db: DB,
  options: { mode: 'replace' | 'merge'; financial_year_id: string }
): Promise<MasterBudgetUploadResult> {
  const preview = await analyzeMasterBudgetWorkbook(buffer, 'uploaded_budget.xlsx', db, { financial_year_id: options.financial_year_id });
  return applyMasterBudgetImport(
    preview.preview_id,
    {
      mode: options.mode,
      department_id: preview.detected_department?.id || db.departments[0]?.id || 'CSE',
      financial_year_id: options.financial_year_id,
      user_id: 'system',
      role: 'super_admin',
    },
    db
  );
}

