import { Router, type Response } from 'express';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { store } from '../store.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { registerUnicodeFonts, formatPdfCurrency, type RegisteredPdfFonts } from '../lib/fontResolver.js';
import {
  checkReportScopeAuthorization,
  resolveAuthorizedScope,
  computeDepartmentMetrics,
  getExecutiveSummaryData,
  getSchoolReportBundle,
  getReportDataset,
  isCurrencyKey,
  formatStatusLabel,
  getHeaderLabel,
  type ScopeResolution,
} from '../services/reportService.js';

// Re-export all service functions for backward compatibility with scripts and tests
export {
  checkReportScopeAuthorization,
  resolveAuthorizedScope,
  computeDepartmentMetrics,
  getExecutiveSummaryData,
  getSchoolReportBundle,
  getReportDataset,
  isCurrencyKey,
  formatStatusLabel,
  getHeaderLabel,
  type ScopeResolution,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logoPath = path.join(__dirname, '..', '..', 'public', 'christ-logo.png');

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const CHRIST_BLUE = '#003D8F';
const TEXT_DARK = '#1E293B';
const BORDER_LIGHT = '#CBD5E1';
const ROW_BG_ALT = '#F8FAFC';

// ==========================================
// 1. SUMMARY GENERATION ENDPOINTS
// ==========================================

/**
 * GET /api/reports/summary/overview
 * Unified executive summary endpoint serving complete 3-section institutional reports
 */
reportsRouter.get('/summary/overview', (req: AuthedRequest, res) => {
  const data = getExecutiveSummaryData(req.user!, req.query);
  res.json(data);
});

/**
 * GET /api/reports/summary/campus
 */
reportsRouter.get('/summary/campus', (req: AuthedRequest, res) => {
  if (!checkReportScopeAuthorization(req.user!, 'campus')) {
    return res.status(403).json({ error: 'Forbidden: Campus summary requires institutional executive role' });
  }

  const fyId = (req.query.financial_year_id as string) || (req.query.fy_id as string);
  const allDepts = store.data.departments;
  const academicDepts = allDepts.filter((d) => d.category !== 'coe' && !d.code.startsWith('COE-'));
  const centreDepts = allDepts.filter((d) => d.category === 'coe' || d.code.startsWith('COE-'));

  const overallMetrics = computeDepartmentMetrics(allDepts.map((d) => d.id), fyId);
  const academicMetrics = computeDepartmentMetrics(academicDepts.map((d) => d.id), fyId);
  const centreMetrics = computeDepartmentMetrics(centreDepts.map((d) => d.id), fyId);

  const schools = (store.data.schools || []).map((s) => {
    const sDepts = allDepts.filter((d) => d.school_id === s.id);
    return {
      ...s,
      departments_count: sDepts.length,
      metrics: computeDepartmentMetrics(sDepts.map((d) => d.id), fyId),
    };
  });

  res.json({
    scope: 'campus',
    title: 'CHRIST University Campus Financial & Operational Summary',
    generated_at: new Date().toISOString(),
    metrics: overallMetrics,
    breakdown: {
      academic: academicMetrics,
      centres_offices: centreMetrics,
    },
    schools,
  });
});

/**
 * GET /api/reports/summary/school/:id
 */
reportsRouter.get('/summary/school/:id', (req: AuthedRequest, res) => {
  const { id } = req.params;
  const school = store.data.schools?.find((s) => s.id === id || s.code === id.toUpperCase());
  if (!school) {
    return res.status(404).json({ error: 'School not found' });
  }

  if (!checkReportScopeAuthorization(req.user!, 'school', school.id)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to view this school summary' });
  }

  const fyId = (req.query.financial_year_id as string) || (req.query.fy_id as string);
  const depts = store.data.departments.filter((d) => d.school_id === school.id);
  const metrics = computeDepartmentMetrics(depts.map((d) => d.id), fyId);

  const departmentBreakdown = depts.map((d) => ({
    id: d.id,
    name: d.name,
    code: d.code,
    metrics: computeDepartmentMetrics([d.id], fyId),
  }));

  res.json({
    scope: 'school',
    school,
    school_name: school.name,
    metrics,
    departments: departmentBreakdown,
  });
});

/**
 * GET /api/reports/summary/department/:id
 */
reportsRouter.get('/summary/department/:id', (req: AuthedRequest, res) => {
  const { id } = req.params;
  const dept = store.data.departments.find((d) => d.id === id || d.code.toUpperCase() === id.toUpperCase());
  if (!dept) {
    return res.status(404).json({ error: 'Department not found' });
  }

  if (!checkReportScopeAuthorization(req.user!, 'department', dept.id)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to view this department summary' });
  }

  const fyId = (req.query.financial_year_id as string) || (req.query.fy_id as string);
  const metrics = computeDepartmentMetrics([dept.id], fyId);
  const budgets = store.data.department_budgets.filter((b) => b.department_id === dept.id && (!fyId || b.financial_year_id === fyId));
  const catMap = new Map(store.data.budget_categories.map((c) => [c.id, c.name]));

  const categories = budgets.map((b) => ({
    category_id: b.budget_category_id,
    category_name: catMap.get(b.budget_category_id) || 'Category',
    allocated: Number(b.allocated_amount) || 0,
    approved: Number(b.approved_amount) || 0,
    pending: Number(b.pending_amount) || 0,
    available: Number(b.allocated_amount) - Number(b.approved_amount) - Number(b.pending_amount),
  }));

  res.json({
    scope: 'department',
    department: dept,
    metrics,
    categories,
  });
});

/**
 * GET /api/reports/summary/centre/:id
 */
reportsRouter.get('/summary/centre/:id', (req: AuthedRequest, res) => {
  const { id } = req.params;
  const centre = store.data.departments.find(
    (d) => (d.category === 'coe' || d.code.startsWith('COE-')) && (d.id === id || d.code.toUpperCase() === id.toUpperCase())
  );
  if (!centre) {
    return res.status(404).json({ error: 'Centre / Office not found' });
  }

  if (!checkReportScopeAuthorization(req.user!, 'centre', centre.id)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to view this Centre / Office summary' });
  }

  const fyId = (req.query.financial_year_id as string) || (req.query.fy_id as string);
  const metrics = computeDepartmentMetrics([centre.id], fyId);

  res.json({
    scope: 'centre',
    centre,
    metrics,
  });
});

/**
 * GET /api/reports/data/:reportType
 * Returns structured data for the table preview, applying strict organization and FY filters
 */
reportsRouter.get('/data/:reportType', (req: AuthedRequest, res) => {
  const { reportType } = req.params;
  const data = getReportDataset(reportType, req.user!, req.query);
  res.json({
    report_type: reportType,
    title: reportType.replace(/_/g, ' ').toUpperCase(),
    total_records: data.length,
    rows: data,
    data,
  });
});

// ==========================================
// 2. PROFESSIONAL A4 PDF REPORT GENERATOR
// ==========================================

/**
 * Renders data tables with dynamic header heights, intelligent column widths, and strict page-break control.
 */
function renderPdfTable(
  doc: PDFKit.PDFDocument,
  keys: string[],
  rows: any[],
  startY: number,
  pageWidth: number,
  pageHeight: number,
  leftMargin: number,
  rightMargin: number,
  fonts?: RegisteredPdfFonts
): number {
  const tableWidth = pageWidth - leftMargin - rightMargin;

  if (!rows || rows.length === 0) {
    doc.font(fonts?.fontItalic || 'Times-Italic').fontSize(8.5).fillColor('#64748B').text('No records available for the selected organization and academic year.', leftMargin, startY);
    return startY + 20;
  }

  // Custom intelligent column weights ensuring numbers and currency never wrap
  const customWeights: Record<string, number> = {
    sl_no: 26,
    s_no: 26,
    date: 54,
    invoice_date: 54,
    collection_date: 54,
    submission_date: 54,
    timestamp: 68,
    ref_no: 82,
    nfa_ref: 82,
    invoice_no: 80,
    invoice_number: 80,
    event_ref: 80,
    code: 42,
    centre_code: 48,
    department: 46,
    department_code: 46,
    school_code: 46,
    type: 46,
    nfa_type: 46,
    status: 68,
    verification: 68,
    verification_status: 68,
    payment_status: 68,
    completion: 68,
    completion_status: 68,
    current_stage: 75,
    revenue_enabled: 48,
    revenue_generating: 48,
    will_generate_revenue: 48,
    allocated: 72,
    approved: 72,
    pending: 72,
    available: 72,
    amount: 72,
    requested_amount: 72,
    approved_amount: 72,
    invoice_amount: 72,
    paid_amount: 72,
    gst_amount: 60,
    recorded_revenue: 72,
    verified_revenue: 72,
    revenue_generated: 72,
    total_requested: 76,
    total_approved_amount: 76,
    total_submitted: 44,
    total_approved: 44,
    total_pending: 44,
    total_rejected: 44,
    events_completed: 46,
    days_in_review: 44,
    quotations_count: 42,
    utilization: 46,
    departments_count: 44,
    total_departments: 44,
    active_faculty_count: 44,
    total_nfas: 44,
    approved_nfas: 44,
    pending_nfas: 44,
    rejected_nfas: 44,
    nfas_count: 44,
  };

  let allocatedFixed = 0;
  let flexCols = 0;
  keys.forEach((k) => {
    if (customWeights[k]) allocatedFixed += customWeights[k];
    else flexCols++;
  });

  const remainingWidth = Math.max(70 * flexCols, tableWidth - allocatedFixed);
  const flexColWidth = flexCols > 0 ? Math.floor(remainingWidth / flexCols) : 85;

  const colWidths = keys.map((k) => customWeights[k] || flexColWidth);

  // Normalize column widths to exact tableWidth
  const totalCalculated = colWidths.reduce((a, b) => a + b, 0);
  const scale = tableWidth / totalCalculated;
  const finalColWidths = colWidths.map((w) => Math.floor(w * scale));

  // Fix rounding difference on the largest flex column or last column
  const diff = tableWidth - finalColWidths.reduce((a, b) => a + b, 0);
  if (diff !== 0 && finalColWidths.length > 0) {
    finalColWidths[finalColWidths.length - 1] += diff;
  }

  let curY = startY;
  const boldFont = fonts?.fontBold || 'Times-Bold';
  const regFont = fonts?.fontRegular || 'Times-Roman';
  const hasUnicode = Boolean(fonts?.hasUnicode);

  // Measure dynamic header height based on actual wrapped text
  let maxHeaderHeight = 16;
  keys.forEach((k, idx) => {
    const colW = finalColWidths[idx];
    const label = getHeaderLabel(k);
    doc.font(boldFont).fontSize(7.5);
    const h = doc.heightOfString(label, { width: colW - 6 });
    if (h > maxHeaderHeight) maxHeaderHeight = h;
  });
  const headerHeight = Math.max(22, Math.ceil(maxHeaderHeight) + 8);

  function drawTableHeader() {
    // If not enough vertical space for header + at least one data row, page break first
    if (curY + headerHeight + 25 > pageHeight - 40) {
      doc.addPage();
      curY = 36;
    }

    doc.rect(leftMargin, curY, tableWidth, headerHeight).fillColor(CHRIST_BLUE).fill();
    let colX = leftMargin;
    keys.forEach((k, idx) => {
      const colW = finalColWidths[idx];
      const isCurr = isCurrencyKey(k);
      const isCenter = k === 'sl_no' || k === 's_no' || k.includes('count') || k === 'type' || k === 'nfa_type' || k.includes('date');
      const label = getHeaderLabel(k);
      doc.font(boldFont).fontSize(7.5);
      const textH = doc.heightOfString(label, { width: colW - 6, align: isCurr ? 'right' : isCenter ? 'center' : 'left' });
      const textY = curY + Math.max(3, (headerHeight - textH) / 2);

      doc
        .fillColor('#FFFFFF')
        .text(label, colX + 3, textY, {
          width: colW - 6,
          align: isCurr ? 'right' : isCenter ? 'center' : 'left',
        });
      colX += colW;
    });
    curY += headerHeight;
  }

  drawTableHeader();

  // Draw data rows
  doc.fontSize(7.5);
  rows.forEach((row, rIdx) => {
    // Measure dynamic row height
    let maxCellHeight = 16;
    keys.forEach((k, idx) => {
      const colW = finalColWidths[idx];
      const val = row[k];
      let cellText: string;
      if (typeof val === 'number') {
        cellText = isCurrencyKey(k) ? formatPdfCurrency(val, hasUnicode) : val.toLocaleString('en-IN');
      } else if (k === 'status' || k.includes('status') || k === 'current_stage') {
        cellText = formatStatusLabel(val);
      } else {
        cellText = String(val ?? '—');
      }
      doc.font(regFont).fontSize(7.5);
      const h = doc.heightOfString(cellText, { width: colW - 6 });
      if (h > maxCellHeight) maxCellHeight = h;
    });

    const rowHeight = Math.min(65, Math.max(18, maxCellHeight + 6));

    // Page break handling
    if (curY + rowHeight > pageHeight - 45) {
      doc.addPage();
      curY = 36;
      drawTableHeader();
    }

    if (rIdx % 2 === 1) {
      doc.rect(leftMargin, curY, tableWidth, rowHeight).fillColor(ROW_BG_ALT).fill();
    }

    let colX = leftMargin;
    keys.forEach((k, idx) => {
      const colW = finalColWidths[idx];
      const val = row[k];
      const isCurr = isCurrencyKey(k);
      const isCenter = k === 'sl_no' || k === 's_no' || k.includes('count') || k === 'type' || k === 'nfa_type' || k.includes('date');
      let cellText: string;

      if (typeof val === 'number') {
        cellText = isCurr ? formatPdfCurrency(val, hasUnicode) : val.toLocaleString('en-IN');
      } else if (k === 'status' || k.includes('status') || k === 'current_stage') {
        cellText = formatStatusLabel(val);
      } else {
        cellText = String(val ?? '—');
      }

      doc
        .font(regFont)
        .fontSize(7.5)
        .fillColor(TEXT_DARK)
        .text(cellText, colX + 3, curY + 4, {
          width: colW - 6,
          align: isCurr ? 'right' : isCenter ? 'center' : 'left',
          ellipsis: true,
        });
      colX += colW;
    });

    doc.moveTo(leftMargin, curY + rowHeight).lineTo(leftMargin + tableWidth, curY + rowHeight).strokeColor(BORDER_LIGHT).lineWidth(0.5).stroke();
    curY += rowHeight;
  });

  return curY;
}

/**
 * Renders Executive Summary Section 3 (Detailed NFA Proposals) in a clean, portrait-friendly two-tier layout.
 * Eliminates horizontal crowding and mid-word splits across A4 portrait.
 */
function renderExecutiveSummarySection3(
  doc: PDFKit.PDFDocument,
  rows: any[],
  startY: number,
  pageWidth: number,
  pageHeight: number,
  leftMargin: number,
  rightMargin: number,
  fonts?: RegisteredPdfFonts
): number {
  const tableWidth = pageWidth - leftMargin - rightMargin; // 523.28 pt
  let curY = startY;
  const boldFont = fonts?.fontBold || 'Times-Bold';
  const regFont = fonts?.fontRegular || 'Times-Roman';
  const hasUnicode = Boolean(fonts?.hasUnicode);

  // Column definitions for primary row
  const colW = {
    sl_no: 26,
    ref_no: 82,
    date: 52,
    title: tableWidth - (26 + 82 + 52 + 82 + 81), // 200.28 pt
    requested: 82,
    approved: 81,
  };

  function drawSection3Header() {
    if (curY + 45 > pageHeight - 40) {
      doc.addPage();
      curY = 36;
    }
    doc.rect(leftMargin, curY, tableWidth, 22).fillColor(CHRIST_BLUE).fill();
    let x = leftMargin;

    doc.font(boldFont).fontSize(7.5).fillColor('#FFFFFF');
    doc.text('Sl.', x + 2, curY + 6, { width: colW.sl_no - 4, align: 'center' });
    x += colW.sl_no;
    doc.text('Reference No.', x + 3, curY + 6, { width: colW.ref_no - 6, align: 'left' });
    x += colW.ref_no;
    doc.text('Date', x + 3, curY + 6, { width: colW.date - 6, align: 'center' });
    x += colW.date;
    doc.text('Proposal / Event Title', x + 4, curY + 6, { width: colW.title - 8, align: 'left' });
    x += colW.title;
    doc.text('Requested Amt', x + 2, curY + 6, { width: colW.requested - 4, align: 'right' });
    x += colW.requested;
    doc.text('Approved Amt', x + 2, curY + 6, { width: colW.approved - 4, align: 'right' });

    curY += 22;
  }

  drawSection3Header();

  rows.forEach((r, idx) => {
    // Measure title height
    doc.font(regFont).fontSize(7.5);
    const titleH = doc.heightOfString(String(r.title || '—'), { width: colW.title - 8 });
    const primaryH = Math.max(16, titleH + 6);
    const subH = 14;
    const totalRowH = primaryH + subH;

    if (curY + totalRowH > pageHeight - 45) {
      doc.addPage();
      curY = 36;
      drawSection3Header();
    }

    // Row alternating background
    if (idx % 2 === 1) {
      doc.rect(leftMargin, curY, tableWidth, primaryH).fillColor(ROW_BG_ALT).fill();
    }

    // Primary row text
    let x = leftMargin;
    doc.font(regFont).fontSize(7.5).fillColor(TEXT_DARK);

    doc.text(String(r.sl_no), x + 2, curY + 4, { width: colW.sl_no - 4, align: 'center' });
    x += colW.sl_no;

    doc.font(boldFont).fontSize(7.5).fillColor(CHRIST_BLUE);
    doc.text(String(r.ref_no || '—'), x + 3, curY + 4, { width: colW.ref_no - 6, align: 'left' });
    x += colW.ref_no;

    doc.font(regFont).fontSize(7.5).fillColor(TEXT_DARK);
    doc.text(String(r.date || '—'), x + 3, curY + 4, { width: colW.date - 6, align: 'center' });
    x += colW.date;

    doc.text(String(r.title || '—'), x + 4, curY + 4, { width: colW.title - 8, align: 'left' });
    x += colW.title;

    doc.text(formatPdfCurrency(Number(r.requested_amount) || 0, hasUnicode), x + 2, curY + 4, { width: colW.requested - 4, align: 'right' });
    x += colW.requested;

    doc.font(boldFont).fillColor(r.approved_amount > 0 ? '#16A34A' : TEXT_DARK);
    doc.text(formatPdfCurrency(Number(r.approved_amount) || 0, hasUnicode), x + 2, curY + 4, { width: colW.approved - 4, align: 'right' });

    curY += primaryH;

    // Sub-bar for proposal metadata
    doc.rect(leftMargin, curY, tableWidth, subH).fillColor('#F1F5F9').fill();
    doc.font(regFont).fontSize(6.8).fillColor('#475569');
    const metaLeft = `Proposer: ${r.proposer || 'Faculty'}  |  Dept: ${r.department || '—'}  |  Type: ${r.type || 'EVENT'}  |  Status: ${formatStatusLabel(r.status)}`;
    const metaRight = `Event: ${formatStatusLabel(r.completion_status)}  |  Revenue: ${r.will_generate_revenue || 'NO'}`;

    doc.text(metaLeft, leftMargin + 6, curY + 3, { width: tableWidth * 0.65, align: 'left', ellipsis: true });
    doc.text(metaRight, leftMargin + tableWidth * 0.65, curY + 3, { width: tableWidth * 0.35 - 6, align: 'right', ellipsis: true });

    curY += subH;
    doc.moveTo(leftMargin, curY).lineTo(leftMargin + tableWidth, curY).strokeColor(BORDER_LIGHT).lineWidth(0.5).stroke();
  });

  return curY;
}

/**
 * Draws the official CHRIST University header with crest logo and institutional metadata
 */
function drawOfficialHeader(
  doc: PDFKit.PDFDocument,
  title: string,
  user: any,
  leftMargin: number,
  contentWidth: number,
  fyLabel: string = '2026-27',
  fonts?: RegisteredPdfFonts
) {
  const topY = 36;
  if (fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, leftMargin, topY, { fit: [55, 55] });
    } catch {}
  }

  const boldFont = fonts?.fontBold || 'Times-Bold';
  const regFont = fonts?.fontRegular || 'Times-Roman';

  doc
    .font(boldFont)
    .fontSize(15)
    .fillColor(CHRIST_BLUE)
    .text('CHRIST (Deemed to be University)', leftMargin + 65, topY + 2);

  doc
    .font(regFont)
    .fontSize(9.5)
    .fillColor(TEXT_DARK)
    .text('Bengaluru – Kengeri Campus · Institutional NFA & Budget Management System', leftMargin + 65, topY + 20)
    .font(boldFont)
    .fontSize(11)
    .fillColor(CHRIST_BLUE)
    .text(`OFFICIAL INSTITUTIONAL REPORT: ${title.toUpperCase()}`, leftMargin + 65, topY + 34);

  doc
    .font(regFont)
    .fontSize(8)
    .fillColor('#64748B')
    .text(`Academic Year: ${fyLabel} | Generated: ${new Date().toLocaleString('en-IN')} | Authorized User: ${user.name} (${user.role.toUpperCase()})`, leftMargin, topY + 64);

  doc.moveTo(leftMargin, topY + 76).lineTo(leftMargin + contentWidth, topY + 76).strokeColor(CHRIST_BLUE).lineWidth(1.5).stroke();

  return topY + 88;
}

/**
 * Renders footers across all buffered pages with ZERO accidental page breaks
 */
function renderPdfFooters(doc: PDFKit.PDFDocument, leftMargin: number, contentWidth: number, pageHeight: number, fonts?: RegisteredPdfFonts) {
  const regFont = fonts?.fontRegular || 'Times-Roman';
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i++) {
    doc.switchToPage(i);
    // CRITICAL: set margins.bottom to 0 so footer text never triggers an auto-page-break
    doc.page.margins.bottom = 0;
    doc
      .font(regFont)
      .fontSize(7.5)
      .fillColor('#94A3B8')
      .text(
        `CHRIST (Deemed to be University) — Institutional Confidential Document | Page ${i + 1} of ${pageRange.count}`,
        leftMargin,
        pageHeight - 22,
        { align: 'center', width: contentWidth, lineBreak: false }
      );
  }
}

/**
 * POST or GET /api/reports/summary/export/pdf
 * Generates official A4 Executive Summary PDF (Executive KPI Box + Section 2 Split Tables + Section 3 Two-Tier Table)
 */
reportsRouter.all('/summary/export/pdf', (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const filters = { ...(req.query || {}), ...(req.body || {}) };
  const summary = getExecutiveSummaryData(user, filters);

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margins: { top: 36, bottom: 20, left: 36, right: 36 },
    bufferPages: true,
  });

  const fonts = registerUnicodeFonts(doc);

  const filename = `CU_Executive_Summary_${summary.org_code}_${Date.now()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const leftMargin = 36;
  const rightMargin = 36;
  const contentWidth = pageWidth - leftMargin - rightMargin;

  let curY = drawOfficialHeader(
    doc,
    `EXECUTIVE SUMMARY — ${summary.org_name.toUpperCase()} (${summary.org_code})`,
    user,
    leftMargin,
    contentWidth,
    summary.financial_year,
    fonts
  );

  // Section 1: Executive KPI Overview Box
  doc.font(fonts.fontBold).fontSize(11).fillColor(CHRIST_BLUE).text('SECTION 1: FINANCIAL CEILING & COMMITMENTS SUMMARY', leftMargin, curY);
  curY += 16;

  doc.rect(leftMargin, curY, contentWidth, 48).fillColor('#F1F5F9').strokeColor(BORDER_LIGHT).lineWidth(1).fillAndStroke();
  const kpiCol = Math.floor(contentWidth / 4);
  const m = summary.metrics;
  const kpis = [
    { l: 'Allocated Budget', v: formatPdfCurrency(m.allocated, fonts.hasUnicode), c: CHRIST_BLUE },
    { l: 'Approved Expenditure', v: formatPdfCurrency(m.approved, fonts.hasUnicode), c: '#16A34A' },
    { l: 'Active Reservations', v: formatPdfCurrency(m.pending, fonts.hasUnicode), c: '#CA8A04' },
    { l: 'Available Balance', v: formatPdfCurrency(m.available, fonts.hasUnicode), c: '#0284C7' },
  ];
  kpis.forEach((k, idx) => {
    doc.font(fonts.fontBold).fontSize(7.5).fillColor('#64748B').text(k.l.toUpperCase(), leftMargin + idx * kpiCol + 8, curY + 8);
    doc.font(fonts.fontBold).fontSize(13).fillColor(k.c).text(k.v, leftMargin + idx * kpiCol + 8, curY + 24);
  });
  curY += 60;

  // Secondary metrics line
  doc.font(fonts.fontRegular).fontSize(8.5).fillColor(TEXT_DARK).text(
    `Total NFAs: ${m.total_nfas} (Approved: ${m.approved_nfas} · In-Flight: ${m.pending_nfas} · Rejected: ${m.rejected_nfas}) | Events Completed: ${m.events_completed_count}/${m.event_nfas_count} | Revenue Generated: ${formatPdfCurrency(m.total_revenue, fonts.hasUnicode)} (Verified: ${formatPdfCurrency(m.verified_revenue, fonts.hasUnicode)}) | Invoices Paid: ${formatPdfCurrency(m.invoices_paid, fonts.hasUnicode)} (Pending: ${formatPdfCurrency(m.invoices_pending, fonts.hasUnicode)})`,
    leftMargin,
    curY
  );
  curY += 20;

  // Section 2: Faculty-wise NFA Activity Tables (Split into 2A and 2B for clean portrait readability)
  doc.font(fonts.fontBold).fontSize(11).fillColor(CHRIST_BLUE).text(`SECTION 2: FACULTY NFA ACTIVITY & PERFORMANCE (${summary.faculty_activity.length} Faculty Members)`, leftMargin, curY);
  curY += 16;

  if (summary.faculty_activity.length > 0) {
    // Table 2A: Submissions & Approval Status
    doc.font(fonts.fontBold).fontSize(9.5).fillColor(TEXT_DARK).text('Table 2A: Faculty Proposals & Approval Status', leftMargin, curY);
    curY += 13;
    const facSubKeys = ['sl_no', 'faculty_name', 'department', 'total_submitted', 'total_approved', 'total_pending', 'total_rejected'];
    curY = renderPdfTable(doc, facSubKeys, summary.faculty_activity, curY, pageWidth, pageHeight, leftMargin, rightMargin, fonts);
    curY += 16;

    // Table 2B: Financial Commitments & Event Performance
    if (curY + 60 > pageHeight - 45) {
      doc.addPage();
      curY = 36;
    }
    doc.font(fonts.fontBold).fontSize(9.5).fillColor(TEXT_DARK).text('Table 2B: Faculty Financial Commitments & Event Completion', leftMargin, curY);
    curY += 13;
    const facFinKeys = ['sl_no', 'faculty_name', 'department', 'total_requested', 'total_approved_amount', 'events_completed'];
    curY = renderPdfTable(doc, facFinKeys, summary.faculty_activity, curY, pageWidth, pageHeight, leftMargin, rightMargin, fonts);
  } else {
    doc.font(fonts.fontRegular).fontSize(9).fillColor('#64748B').text('No active faculty submissions found for this organization in the selected academic year.', leftMargin, curY);
    curY += 24;
  }

  // Section 3: Detailed NFA Proposals (Two-Tier Clean Portrait Layout)
  if (curY + 60 > pageHeight - 45) {
    doc.addPage();
    curY = 36;
  } else {
    curY += 20;
  }

  doc.font(fonts.fontBold).fontSize(11).fillColor(CHRIST_BLUE).text(`SECTION 3: DETAILED NFA PROPOSALS (${summary.detailed_nfas.length} Records)`, leftMargin, curY);
  curY += 16;

  if (summary.detailed_nfas.length > 0) {
    curY = renderExecutiveSummarySection3(doc, summary.detailed_nfas, curY, pageWidth, pageHeight, leftMargin, rightMargin, fonts);
  } else {
    doc.font(fonts.fontRegular).fontSize(9).fillColor('#64748B').text('No submitted NFA proposals found matching criteria.', leftMargin, curY);
  }

  // Render footers safely without blank pages
  renderPdfFooters(doc, leftMargin, contentWidth, pageHeight, fonts);
  doc.end();
});

/**
 * POST or GET /api/reports/export/:reportType/pdf
 * Official CHRIST University Report PDF Generation (14 Reports)
 */
reportsRouter.all('/export/:reportType/pdf', (req: AuthedRequest, res: Response) => {
  const { reportType } = req.params;
  const user = req.user!;
  const filters = { ...(req.query || {}), ...(req.body || {}) };
  const data = getReportDataset(reportType, user, filters);
  const resolution = resolveAuthorizedScope(user, filters);

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margins: { top: 36, bottom: 20, left: 36, right: 36 },
    bufferPages: true,
  });

  const fonts = registerUnicodeFonts(doc);

  const filename = `CU_Report_${reportType}_${Date.now()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const leftMargin = 36;
  const rightMargin = 36;
  const contentWidth = pageWidth - leftMargin - rightMargin;

  let curY = drawOfficialHeader(
    doc,
    reportType.replace(/_/g, ' '),
    user,
    leftMargin,
    contentWidth,
    resolution.financialYear.label,
    fonts
  );

  if (reportType === 'school_budget') {
    // Multi-section school report
    const targetSchool = filters.school || filters.targetId || filters.id || resolution.selectedSchool?.id || 'SOET';
    const bundle = getSchoolReportBundle(targetSchool, user, resolution.financialYear.id);

    doc.font(fonts.fontBold).fontSize(11).fillColor(CHRIST_BLUE).text(`SECTION 1: ${bundle.overview.school_name.toUpperCase()} OVERVIEW & METRICS`, leftMargin, curY);
    curY += 16;

    // KPI box
    doc.rect(leftMargin, curY, contentWidth, 44).fillColor('#F1F5F9').strokeColor(BORDER_LIGHT).lineWidth(1).fillAndStroke();
    const kpiCol = Math.floor(contentWidth / 4);
    const kpis = [
      { l: 'Allocated Budget', v: formatPdfCurrency(bundle.overview.allocated_budget, fonts.hasUnicode), c: CHRIST_BLUE },
      { l: 'Approved Expenses', v: formatPdfCurrency(bundle.overview.approved_expenditure, fonts.hasUnicode), c: '#16A34A' },
      { l: 'Active Reservations', v: formatPdfCurrency(bundle.overview.pending_reservations, fonts.hasUnicode), c: '#CA8A04' },
      { l: 'Remaining Balance', v: formatPdfCurrency(bundle.overview.available_balance, fonts.hasUnicode), c: '#0284C7' },
    ];
    kpis.forEach((k, idx) => {
      doc.font(fonts.fontBold).fontSize(7.5).fillColor('#64748B').text(k.l.toUpperCase(), leftMargin + idx * kpiCol + 8, curY + 8);
      doc.font(fonts.fontBold).fontSize(13).fillColor(k.c).text(k.v, leftMargin + idx * kpiCol + 8, curY + 22);
    });
    curY += 56;

    doc.font(fonts.fontBold).fontSize(11).fillColor(CHRIST_BLUE).text('SECTION 2: DEPARTMENT-WISE FINANCIAL & APPROVAL STATUS', leftMargin, curY);
    curY += 16;

    const deptKeys = ['sl_no', 'department_code', 'total_nfas', 'approved_nfas', 'pending_nfas', 'allocated', 'approved', 'pending', 'available', 'utilization'];
    curY = renderPdfTable(doc, deptKeys, bundle.departments, curY, pageWidth, pageHeight, leftMargin, rightMargin, fonts);
  } else {
    // Standard 14 report table
    if (data.length === 0) {
      doc.font(fonts.fontRegular).fontSize(10).fillColor(TEXT_DARK).text('No records found matching the requested reporting criteria.', leftMargin, curY);
    } else {
      const keys = Object.keys(data[0]);
      curY = renderPdfTable(doc, keys, data, curY, pageWidth, pageHeight, leftMargin, rightMargin, fonts);
    }
  }

  // Footer on all pages with zero blank pages
  renderPdfFooters(doc, leftMargin, contentWidth, pageHeight, fonts);
  doc.end();
});

// ==========================================
// 3. PROFESSIONAL EXCEL REPORT GENERATOR
// ==========================================

function styleWorksheet(ws: ExcelJS.Worksheet, keys: string[], rows: any[]) {
  // Setup auto-fit columns with sensible bounds
  ws.columns = keys.map((k) => {
    let maxLen = k.length + 4;
    rows.forEach((r) => {
      const v = r[k];
      const str = typeof v === 'number' ? v.toLocaleString('en-IN') : String(v || '');
      if (str.length > maxLen) maxLen = str.length;
    });
    return {
      header: k.replace(/_/g, ' ').toUpperCase(),
      key: k,
      width: Math.min(Math.max(maxLen + 3, 12), 42),
    };
  });

  // Freeze top row
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Autofilters
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: keys.length } };
  }

  // Style Header Row
  const headerRow = ws.getRow(1);
  headerRow.height = 24;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF003D8F' }, // Official CHRIST Blue
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // Add Data Rows
  rows.forEach((r) => {
    ws.addRow(r);
  });

  // Style Data Rows & Cell Alignment
  ws.eachRow((r, rowNumber) => {
    if (rowNumber > 1) {
      r.height = 20;
      if (rowNumber % 2 === 0) {
        r.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8FAFC' },
        };
      }
      keys.forEach((k, colIdx) => {
        const cell = r.getCell(colIdx + 1);
        if (isCurrencyKey(k) && typeof cell.value === 'number') {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFmt = '₹#,##0.00';
        } else if (typeof cell.value === 'number') {
          cell.alignment = { vertical: 'middle', horizontal: k === 'sl_no' || k === 's_no' ? 'center' : 'right' };
          cell.numFmt = '#,##0';
        } else if (k === 'sl_no' || k.includes('date') || k === 'status') {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        }
      });
    }
  });
}

/**
 * POST or GET /api/reports/summary/export/excel
 * Generates official multi-sheet Executive Summary Excel Workbook
 */
reportsRouter.all('/summary/export/excel', async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const filters = { ...(req.query || {}), ...(req.body || {}) };
  const summary = getExecutiveSummaryData(user, filters);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CHRIST (Deemed to be University) NFA System';
  wb.created = new Date();

  // Sheet 1: Executive Overview
  const wsOverview = wb.addWorksheet('Executive Overview');
  const overviewRows = [
    { metric: 'Organization', value: `${summary.org_name} (${summary.org_code})` },
    { metric: 'Scope', value: summary.scope.toUpperCase() },
    { metric: 'Academic Year', value: summary.financial_year },
    { metric: 'Allocated Budget', value: summary.metrics.allocated },
    { metric: 'Approved Expenditure', value: summary.metrics.approved },
    { metric: 'Active Reservations (Pending)', value: summary.metrics.pending },
    { metric: 'Available Balance', value: summary.metrics.available },
    { metric: 'Total Submitted NFAs', value: summary.metrics.total_nfas },
    { metric: 'Approved NFAs', value: summary.metrics.approved_nfas },
    { metric: 'Pending Review NFAs', value: summary.metrics.pending_nfas },
    { metric: 'Rejected NFAs', value: summary.metrics.rejected_nfas },
    { metric: 'Event NFAs Count', value: summary.metrics.event_nfas_count },
    { metric: 'Events Completed', value: summary.metrics.events_completed_count },
    { metric: 'Purchase NFAs Count', value: summary.metrics.purchase_nfas_count },
    { metric: 'Total Recorded Revenue', value: summary.metrics.total_revenue },
    { metric: 'Verified Revenue', value: summary.metrics.verified_revenue },
    { metric: 'Invoices Paid', value: summary.metrics.invoices_paid },
    { metric: 'Invoices Pending Payment', value: summary.metrics.invoices_pending },
  ];
  styleWorksheet(wsOverview, ['metric', 'value'], overviewRows);

  // Sheet 2: Faculty-wise Activity
  const wsFaculty = wb.addWorksheet('Faculty-wise Activity');
  if (summary.faculty_activity.length > 0) {
    styleWorksheet(wsFaculty, Object.keys(summary.faculty_activity[0]), summary.faculty_activity);
  } else {
    wsFaculty.addRow(['No active faculty submissions found for this organization']);
  }

  // Sheet 3: Detailed NFAs
  const wsNfas = wb.addWorksheet('Detailed NFAs');
  if (summary.detailed_nfas.length > 0) {
    styleWorksheet(wsNfas, Object.keys(summary.detailed_nfas[0]), summary.detailed_nfas);
  } else {
    wsNfas.addRow(['No submitted NFA proposals found matching criteria']);
  }

  // Sheet 4: Categories Breakdown (if available)
  if (summary.categories && summary.categories.length > 0) {
    const wsCats = wb.addWorksheet('Category Budgets');
    styleWorksheet(wsCats, Object.keys(summary.categories[0]), summary.categories);
  }

  const filename = `CU_Executive_Summary_${summary.org_code}_${Date.now()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
});

/**
 * POST or GET /api/reports/export/:reportType/excel
 * Excel Workbook Generation using ExcelJS (14 Reports)
 */
reportsRouter.all('/export/:reportType/excel', async (req: AuthedRequest, res: Response) => {
  const { reportType } = req.params;
  const user = req.user!;
  const filters = { ...(req.query || {}), ...(req.body || {}) };
  const data = getReportDataset(reportType, user, filters);
  const resolution = resolveAuthorizedScope(user, filters);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CHRIST (Deemed to be University) NFA System';
  wb.created = new Date();

  if (reportType === 'school_budget') {
    const targetSchool = filters.school || filters.targetId || filters.id || resolution.selectedSchool?.id || 'SOET';
    const bundle = getSchoolReportBundle(targetSchool, user, resolution.financialYear.id);

    // Sheet 1: School Summary
    const wsSummary = wb.addWorksheet('School Summary');
    styleWorksheet(wsSummary, Object.keys(bundle.overview), [bundle.overview]);

    // Sheet 2: Department Details
    const wsDepts = wb.addWorksheet('Department Details');
    styleWorksheet(wsDepts, Object.keys(bundle.departments[0] || {}), bundle.departments);

    // Sheet 3: Faculty & NFA Activity
    const wsFaculty = wb.addWorksheet('Faculty & NFA Activity');
    styleWorksheet(wsFaculty, Object.keys(bundle.faculty_nfas[0] || { sl_no: 1, records: 'None' }), bundle.faculty_nfas);

    // Sheet 4: Event Activity
    const wsEvents = wb.addWorksheet('Event Activity');
    styleWorksheet(wsEvents, Object.keys(bundle.events[0] || { sl_no: 1, records: 'None' }), bundle.events);

    // Sheet 5: Budget Details
    const wsBudgets = wb.addWorksheet('Budget Details');
    styleWorksheet(wsBudgets, Object.keys(bundle.budgets[0] || { sl_no: 1, records: 'None' }), bundle.budgets);

    // Sheet 6: Revenue & Earnings
    const wsRevenues = wb.addWorksheet('Revenue & Earnings');
    styleWorksheet(wsRevenues, Object.keys(bundle.revenues[0] || { sl_no: 1, records: 'None' }), bundle.revenues);

    // Sheet 7: Purchase Invoices
    const wsInvoices = wb.addWorksheet('Purchase Invoices');
    styleWorksheet(wsInvoices, Object.keys(bundle.invoices[0] || { sl_no: 1, records: 'None' }), bundle.invoices);
  } else {
    // Single sheet standard report
    const ws = wb.addWorksheet(reportType.replace(/_/g, ' ').slice(0, 30));
    if (data.length > 0) {
      styleWorksheet(ws, Object.keys(data[0]), data);
    } else {
      ws.addRow(['No records available for the selected criteria']);
    }
  }

  const filename = `CU_Report_${reportType}_${Date.now()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
});
