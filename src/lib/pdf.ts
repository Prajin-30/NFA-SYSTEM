import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Nfa, NfaItem, Department, BudgetCategory, Approval } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logoPath = path.join(__dirname, '..', '..', 'public', 'christ-logo.png');

// TrueType font paths for Book Antiqua
const fontRegularPath = 'C:\\Windows\\Fonts\\BKANT.TTF';
const fontBoldPath = 'C:\\Windows\\Fonts\\ANTQUAB.TTF';
const fontItalicPath = 'C:\\Windows\\Fonts\\ANTQUAI.TTF';
const fontBoldItalicPath = 'C:\\Windows\\Fonts\\ANTQUABI.TTF';

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

function formatAmount(value: number): string {
  return `Rs. ${Number(value || 0).toLocaleString('en-IN')}`;
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'NFA';
}

export interface BudgetDetailsInfo {
  classification: string;
  categoryName: string;
  subcategoryName: string;
  availableBudget: number;
  amountRequested: number;
  balanceAfter: number;
}

/**
 * Recreates the official institutional Note For Approval (NFA) PDF
 * faithfully matching the Master Christ University document template.
 * Strictly Read-Only.
 */
export function renderNfaPdf(
  res: Response,
  nfa: Nfa,
  items: NfaItem[],
  dept: Department,
  category: BudgetCategory,
  projectName?: string,
  approvals: Approval[] = [],
  fyLabel?: string,
  budgetTypeName?: string,
  budgetDetails?: BudgetDetailsInfo
) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 36, right: 45, bottom: 36, left: 45 },
    bufferPages: true,
  });

  // Typography configuration: strictly Book Antiqua with fallbacks
  const hasBookAntiqua = fs.existsSync(fontRegularPath) && fs.existsSync(fontBoldPath);
  const fontRegular = hasBookAntiqua ? 'Book Antiqua' : 'Times-Roman';
  const fontBold = hasBookAntiqua ? 'Book Antiqua Bold' : 'Times-Bold';
  const fontItalic = hasBookAntiqua && fs.existsSync(fontItalicPath) ? 'Book Antiqua Italic' : 'Times-Italic';
  const fontBoldItalic = hasBookAntiqua && fs.existsSync(fontBoldItalicPath) ? 'Book Antiqua Bold Italic' : 'Times-BoldItalic';

  if (hasBookAntiqua) {
    doc.registerFont(fontRegular, fontRegularPath);
    doc.registerFont(fontBold, fontBoldPath);
    if (fs.existsSync(fontItalicPath)) doc.registerFont(fontItalic, fontItalicPath);
    if (fs.existsSync(fontBoldItalicPath)) doc.registerFont(fontBoldItalic, fontBoldItalicPath);
  }

  res.setHeader('Content-Type', 'application/pdf');
  const reference = (nfa.ref_no || 'NFA').replace(/\//g, '_');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeFileName(nfa.title || projectName || reference)}_${reference}.pdf"`
  );
  doc.pipe(res);

  const pageWidth = 595.28;
  const leftMargin = 45;
  const rightMargin = 45;
  const contentWidth = pageWidth - leftMargin - rightMargin; // 505.28 pt

  // =========================================================================
  // PAGE 1 — MASTER NOTE FOR APPROVAL
  // =========================================================================

  // 1. Institutional Header & Top-Right Logo
  const logoWidth = 110;
  const logoX = pageWidth - rightMargin - logoWidth;
  const logoY = 32;

  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, logoX, logoY, { width: logoWidth });
  }

  // Header text matching master reference scan
  const headerTextWidth = contentWidth - logoWidth - 10;
  doc.font(fontBold).fontSize(13.5).fillColor('#000000');
  doc.text('School of Engineering and Technology', leftMargin, 36, { width: headerTextWidth, align: 'center' });
  doc.font(fontRegular).fontSize(11).fillColor('#000000');
  doc.text('Bangalore Kengeri Campus, Mysore Road,', leftMargin, 53, { width: headerTextWidth, align: 'center' });
  doc.text('Bangalore - 560 074, India', leftMargin, 68, { width: headerTextWidth, align: 'center' });

  // 2. Proposal Title Box (Double-bordered rectangular frame)
  const titleBoxY = 96;
  const proposalTitle = (nfa.title || 'Annual Academic Audit 2025-2026').trim();
  doc.font(fontBold).fontSize(13);
  const titleTextHeight = doc.heightOfString(proposalTitle, { width: contentWidth - 30 });
  const titleBoxHeight = Math.max(34, titleTextHeight + 14);

  // Outer border (thickness ~1.2pt)
  doc.lineWidth(1.2).strokeColor('#000000').rect(leftMargin, titleBoxY, contentWidth, titleBoxHeight).stroke();
  // Inner border (thickness ~0.6pt, inset 2.5pt)
  doc.lineWidth(0.6).strokeColor('#000000').rect(leftMargin + 2.5, titleBoxY + 2.5, contentWidth - 5, titleBoxHeight - 5).stroke();

  // Title text centered inside the frame
  doc.fillColor('#000000').font(fontBold).fontSize(13);
  doc.text(proposalTitle, leftMargin + 15, titleBoxY + Math.max(7, (titleBoxHeight - titleTextHeight) / 2), {
    width: contentWidth - 30,
    align: 'center',
  });

  // 3. Document Master Heading
  doc.y = titleBoxY + titleBoxHeight + 14;
  doc.font(fontBold).fontSize(14).fillColor('#000000');
  doc.text('NOTE FOR APPROVAL', leftMargin, doc.y, { width: contentWidth, align: 'center', underline: true });
  doc.moveDown(0.9);

  // 4. Ref No & Date Line
  const metaY = doc.y;
  doc.font(fontBold).fontSize(12).fillColor('#000000');
  doc.text('Ref: ', leftMargin, metaY, { continued: true });
  doc.font(fontRegular).fontSize(12).text(nfa.ref_no || 'NFA/CU/SoET/26-27/01');

  doc.font(fontBold).fontSize(12);
  doc.text('DATE:', leftMargin + 320, metaY, { continued: true });
  doc.font(fontRegular).fontSize(12).text(formatDate(nfa.date || nfa.created_at));

  doc.y = metaY + 22;

  // 5. Bulleted Proposal Narrative
  const renderBullet = (text: string) => {
    if (!text || !text.trim()) return;
    const bulletX = leftMargin + 10;
    const textX = leftMargin + 24;
    const textW = contentWidth - 24;
    const currentY = doc.y;

    doc.font(fontRegular).fontSize(12).fillColor('#000000');
    doc.text('•', bulletX, currentY);
    doc.text(text.trim(), textX, currentY, { width: textW, align: 'left', lineGap: 3 });
    doc.y += 8;
  };

  // Bullet 1: Proposing Entity & Proposal Purpose
  if (nfa.purpose && nfa.purpose.trim()) {
    // If purpose already contains schedule, split cleanly or render full
    const purposeLines = nfa.purpose.split(/\n+/).filter((l) => l.trim().length > 0);
    purposeLines.forEach((line) => {
      renderBullet(line.replace(/^[•\-\*]\s*/, ''));
    });
  } else {
    renderBullet(
      `The Department of ${dept.name || 'Engineering and Technology'}, Bangalore Kengeri Campus, proposes to conduct the program to evaluate academic compliance and quality benchmarks.`
    );
  }

  // Bullet 2 & 3: Operational Logistics & Arrangements (from description)
  if (nfa.description && nfa.description.trim() && nfa.description.trim() !== nfa.purpose?.trim()) {
    const descLines = nfa.description.split(/\n+/).filter((l) => l.trim().length > 0);
    descLines.forEach((line) => {
      renderBullet(line.replace(/^[•\-\*]\s*/, ''));
    });
  }

  // Bullet 4: Justification & Permissions Sought
  if (nfa.justification && nfa.justification.trim()) {
    const justLines = nfa.justification.split(/\n+/).filter((l) => l.trim().length > 0);
    justLines.forEach((line) => {
      renderBullet(line.replace(/^[•\-\*]\s*/, ''));
    });
  }

  // Bullet 5: Annexure-I Reference & Total Amount
  renderBullet(
    `The estimated expenditure details are attached as Annexure-I. (Rs. ${Number(nfa.total_amount || 0).toLocaleString('en-IN')})`
  );

  // 6. Approval & Signature Area on Page 1
  // Calculate dynamic approvals from real records
  const hodApproval = approvals.find((a) => a.approver_role === 'hod' && a.decision === 'approved');
  const deanApproval = approvals.find((a) => ['dean', 'associate_dean'].includes(a.approver_role) && a.decision === 'approved');
  const directorApproval = approvals.find((a) => a.approver_role === 'director' && a.decision === 'approved');
  const financeApproval = approvals.find((a) => a.approver_role === 'finance' && a.decision === 'approved');

  // Space before approval block
  doc.y = Math.max(doc.y + 10, doc.page.height - 245);

  doc.font(fontRegular).fontSize(12).fillColor('#000000');
  doc.text('Submitted for kind approval,', leftMargin, doc.y);
  doc.moveDown(0.5);
  doc.text('Submitted by,', leftMargin, doc.y);
  doc.y += 18;

  // Level 1: Proposer & Departmental Approval (Side-by-side)
  const submitY = doc.y;
  const colHalfWidth = (contentWidth - 20) / 2;

  // Proposer (Left)
  doc.font(fontBold).fontSize(11.5).fillColor('#000000');
  doc.text(nfa.submitted_by_name || 'Dr Arul V', leftMargin, submitY, { width: colHalfWidth });
  doc.font(fontRegular).fontSize(10.5).fillColor('#000000');
  doc.text(`${nfa.submitted_by_designation || 'Faculty Member'}, Dept. of ${dept.code || dept.name}`, leftMargin, doc.y + 2, { width: colHalfWidth });
  doc.text(`Submission Date: ${formatDate(nfa.created_at || nfa.date)}`, leftMargin, doc.y + 2, { width: colHalfWidth });

  // Departmental Approval (HOD) (Right)
  const hodX = leftMargin + colHalfWidth + 20;
  if (hodApproval) {
    doc.font(fontBold).fontSize(11.5).fillColor('#000000');
    doc.text(hodApproval.approver_name || dept.hod_name || 'Head of Department', hodX, submitY, { width: colHalfWidth });
    doc.font(fontRegular).fontSize(10.5).fillColor('#000000');
    doc.text(`HOD, Dept. of ${dept.code || dept.name}`, hodX, doc.y + 2, { width: colHalfWidth });
    doc.text(`Approved Date: ${formatDate(hodApproval.created_at)}`, hodX, doc.y + 2, { width: colHalfWidth });
    doc.font(fontBold).fontSize(10).fillColor('#000000');
    doc.text('Approved', hodX, doc.y + 2, { width: colHalfWidth });
  } else {
    doc.font(fontBold).fontSize(11.5).fillColor('#000000');
    doc.text('Head of Department', hodX, submitY, { width: colHalfWidth });
    doc.font(fontRegular).fontSize(10.5).fillColor('#000000');
    doc.text(`Dept. of ${dept.code || dept.name}`, hodX, doc.y + 2, { width: colHalfWidth });
    doc.text('Pending Approval', hodX, doc.y + 2, { width: colHalfWidth });
  }

  // Level 2: Management Approval Row (Dean, Director, Finance Officer)
  const mgmtY = submitY + 68;
  const colThirdWidth = (contentWidth - 24) / 3;

  // Authority 1: Dean / Associate Dean (Left)
  const deanX = leftMargin;
  if (deanApproval) {
    doc.font(fontBold).fontSize(11).fillColor('#000000');
    doc.text(deanApproval.approver_name || dept.dean_name || 'Dr Raghunandan Kumar R', deanX, mgmtY, { width: colThirdWidth });
    doc.font(fontRegular).fontSize(10).fillColor('#000000');
    doc.text('Dean, SoET & SoA', deanX, doc.y + 2, { width: colThirdWidth });
    doc.text('Bangalore Kengeri Campus', deanX, doc.y + 2, { width: colThirdWidth });
    doc.text(`Approved: ${formatDate(deanApproval.created_at)}`, deanX, doc.y + 2, { width: colThirdWidth });
    doc.font(fontBold).fontSize(9.5).text('Approved', deanX, doc.y + 2, { width: colThirdWidth });
  } else {
    doc.font(fontBold).fontSize(11).fillColor('#000000');
    doc.text('Dean / Associate Dean', deanX, mgmtY, { width: colThirdWidth });
    doc.font(fontRegular).fontSize(10).fillColor('#000000');
    doc.text('School of Engineering & Tech', deanX, doc.y + 2, { width: colThirdWidth });
    doc.text('Bangalore Kengeri Campus', deanX, doc.y + 2, { width: colThirdWidth });
    doc.text('Pending Approval', deanX, doc.y + 2, { width: colThirdWidth });
  }

  // Authority 2: Director (Center)
  const dirX = leftMargin + colThirdWidth + 12;
  if (directorApproval) {
    doc.font(fontBold).fontSize(11).fillColor('#000000');
    doc.text(directorApproval.approver_name || dept.director_name || 'Dr Fr Jiby Jose E', dirX, mgmtY, { width: colThirdWidth });
    doc.font(fontRegular).fontSize(10).fillColor('#000000');
    doc.text('Director,', dirX, doc.y + 2, { width: colThirdWidth });
    doc.text('Bangalore Kengeri Campus', dirX, doc.y + 2, { width: colThirdWidth });
    doc.text(`Approved: ${formatDate(directorApproval.created_at)}`, dirX, doc.y + 2, { width: colThirdWidth });
    doc.font(fontBold).fontSize(9.5).text('Approved', dirX, doc.y + 2, { width: colThirdWidth });
  } else {
    doc.font(fontBold).fontSize(11).fillColor('#000000');
    doc.text('Director', dirX, mgmtY, { width: colThirdWidth });
    doc.font(fontRegular).fontSize(10).fillColor('#000000');
    doc.text('Bangalore Kengeri Campus', dirX, doc.y + 2, { width: colThirdWidth });
    doc.text('Pending Approval', dirX, doc.y + 3, { width: colThirdWidth });
  }

  // Authority 3: Finance Officer (Right)
  const finX = leftMargin + (colThirdWidth + 12) * 2;
  if (financeApproval) {
    doc.font(fontBold).fontSize(11).fillColor('#000000');
    doc.text(financeApproval.approver_name || dept.finance_officer_name || 'Fr Shijin P J', finX, mgmtY, { width: colThirdWidth });
    doc.font(fontRegular).fontSize(10).fillColor('#000000');
    doc.text('Finance Officer,', finX, doc.y + 2, { width: colThirdWidth });
    doc.text('Bangalore Kengeri Campus', finX, doc.y + 2, { width: colThirdWidth });
    doc.text(`Approved: ${formatDate(financeApproval.created_at)}`, finX, doc.y + 2, { width: colThirdWidth });
    doc.font(fontBold).fontSize(9.5).text('Approved', finX, doc.y + 2, { width: colThirdWidth });
  } else {
    doc.font(fontBold).fontSize(11).fillColor('#000000');
    doc.text('Finance Officer', finX, mgmtY, { width: colThirdWidth });
    doc.font(fontRegular).fontSize(10).fillColor('#000000');
    doc.text('Bangalore Kengeri Campus', finX, doc.y + 2, { width: colThirdWidth });
    doc.text('Pending Approval', finX, doc.y + 3, { width: colThirdWidth });
  }

  // =========================================================================
  // PAGE 2 — ANNEXURE-I (Requirements & Budget Table)
  // =========================================================================
  doc.addPage();

  // Top-Right Logo on Annexure Page
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, logoX, logoY, { width: logoWidth });
  }

  // Annexure Heading
  doc.y = 80;
  doc.font(fontBold).fontSize(14).fillColor('#000000');
  doc.text('ANNEXURE-I', leftMargin, doc.y, { width: contentWidth, align: 'center' });
  doc.y += 18;

  doc.font(fontBold).fontSize(12).fillColor('#000000');
  doc.text('Requirements:', leftMargin, doc.y);
  doc.y += 12;

  // Table Column Definitions
  // Total contentWidth = 505.28 pt
  const tableColumns = [
    { key: 'sl', label: 'Sl. No', x: leftMargin, width: 45, align: 'center' as const },
    { key: 'particulars', label: 'Particulars', x: leftMargin + 45, width: 230, align: 'left' as const },
    { key: 'quantity', label: 'Quantity', x: leftMargin + 275, width: 60, align: 'center' as const },
    { key: 'rate', label: 'Rate Per Quantity (Rs.)', x: leftMargin + 335, width: 85, align: 'right' as const },
    { key: 'amount', label: 'Estimated Amount (Rs.)', x: leftMargin + 420, width: 85, align: 'right' as const },
  ];

  const headerFontSize = 10.5;
  doc.font(fontBold).fontSize(headerFontSize);
  const maxHeaderHeight = Math.max(
    ...tableColumns.map((c) => doc.heightOfString(c.label, { width: c.width - 6 }))
  );
  const headerHeight = Math.max(34, Math.ceil(maxHeaderHeight + 10));

  const renderTableHeader = (currentY: number) => {
    doc.lineWidth(0.8).strokeColor('#000000');
    tableColumns.forEach((c) => {
      doc.rect(c.x, currentY, c.width, headerHeight).stroke();
      doc.font(fontBold).fontSize(headerFontSize).fillColor('#000000');
      const textH = doc.heightOfString(c.label, { width: c.width - 6 });
      const textY = currentY + Math.max(3, (headerHeight - textH) / 2);
      doc.text(c.label, c.x + 3, textY, { width: c.width - 6, align: c.align });
    });
    return currentY + headerHeight;
  };

  let currentTableY = renderTableHeader(doc.y);

  // Render Items
  items.forEach((item, index) => {
    doc.font(fontRegular).fontSize(11);
    const particularHeight = doc.heightOfString(item.particulars || '', { width: 220 });
    const rowHeight = Math.max(24, particularHeight + 10);

    // Page overflow handling: keep table on same page or continue cleanly
    if (currentTableY + rowHeight > doc.page.height - 40) {
      doc.addPage();
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, logoX, logoY, { width: logoWidth });
      }
      doc.y = 80;
      doc.font(fontBold).fontSize(12).text('ANNEXURE-I (Continued)', leftMargin, doc.y, { width: contentWidth, align: 'center' });
      doc.y += 16;
      currentTableY = renderTableHeader(doc.y);
    }

    doc.lineWidth(0.6).strokeColor('#000000');

    // Draw borders for each cell
    tableColumns.forEach((c) => {
      doc.rect(c.x, currentTableY, c.width, rowHeight).stroke();
    });

    // Populate data
    doc.font(fontRegular).fontSize(11).fillColor('#000000');
    // Sl No
    doc.text(String(item.sl_no || index + 1), tableColumns[0].x + 2, currentTableY + 7, {
      width: tableColumns[0].width - 4,
      align: 'center',
    });
    // Particulars
    doc.text(item.particulars || '', tableColumns[1].x + 5, currentTableY + 7, {
      width: tableColumns[1].width - 10,
      align: 'left',
      lineGap: 1.5,
    });
    // Quantity
    doc.text(item.quantity ? String(item.quantity) : '—', tableColumns[2].x + 2, currentTableY + 7, {
      width: tableColumns[2].width - 4,
      align: 'center',
    });
    // Rate
    doc.text(item.rate ? Number(item.rate).toLocaleString('en-IN') : '—', tableColumns[3].x + 3, currentTableY + 7, {
      width: tableColumns[3].width - 6,
      align: 'right',
    });
    // Amount
    doc.text(Number(item.amount || 0).toLocaleString('en-IN'), tableColumns[4].x + 3, currentTableY + 7, {
      width: tableColumns[4].width - 6,
      align: 'right',
    });

    currentTableY += rowHeight;
  });

  // Total Amount Row
  const totalRowHeight = 24;
  if (currentTableY + totalRowHeight > doc.page.height - 40) {
    doc.addPage();
    currentTableY = 60;
  }

  const mergedLabelWidth = tableColumns[0].width + tableColumns[1].width + tableColumns[2].width + tableColumns[3].width; // 420 pt
  const amountCol = tableColumns[4];

  doc.lineWidth(0.8).strokeColor('#000000');
  // Box for Total Amount Label
  doc.rect(leftMargin, currentTableY, mergedLabelWidth, totalRowHeight).stroke();
  doc.font(fontBold).fontSize(11.5).fillColor('#000000');
  doc.text('Total Amount', leftMargin + 10, currentTableY + 6, { width: mergedLabelWidth - 20, align: 'right' });

  // Box for Total Amount Value
  doc.rect(amountCol.x, currentTableY, amountCol.width, totalRowHeight).stroke();
  doc.text(`Rs. ${Number(nfa.total_amount || 0).toLocaleString('en-IN')}`, amountCol.x + 3, currentTableY + 6, {
    width: amountCol.width - 6,
    align: 'right',
  });

  doc.y = currentTableY + totalRowHeight + 24;

  // =========================================================================
  // BUDGET SOURCE & AVAILABILITY DETAILS SECTION
  // =========================================================================
  // Institutional section following Annexure-I table
  const budgetSectionNeededHeight = 150;
  if (doc.y + budgetSectionNeededHeight > doc.page.height - 40) {
    doc.addPage();
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, logoX, logoY, { width: logoWidth });
    }
    doc.y = 80;
  }

  doc.font(fontBold).fontSize(14).fillColor('#000000');
  doc.text('BUDGET SOURCE & AVAILABILITY DETAILS', leftMargin, doc.y);
  doc.y += 12;

  // Prepare dynamic values
  const bDetails = budgetDetails || {
    classification: budgetTypeName || (category.name.includes('CAPEX') ? 'Capital Expenditure (CAPEX)' : 'Revenue Expenditure (Operating / Departmental)'),
    categoryName: category.name || 'General Category',
    subcategoryName: nfa.budget_subcategory_name || 'General Allocation',
    availableBudget: 0,
    amountRequested: nfa.total_amount || 0,
    balanceAfter: 0,
  };

  const budgetItems = [
    { label: 'Budget Nature / Classification:', value: bDetails.classification },
    { label: 'Budget Main Category:', value: bDetails.categoryName },
    { label: 'Budget Subcategory:', value: bDetails.subcategoryName },
    { label: 'Available Budget:', value: formatAmount(bDetails.availableBudget) },
    { label: 'Amount Requested:', value: formatAmount(bDetails.amountRequested) },
    { label: 'Balance After Allocation:', value: formatAmount(bDetails.balanceAfter) },
  ];

  const labelColWidth = 190;
  const valueColWidth = contentWidth - labelColWidth - 10;

  budgetItems.forEach((bItem) => {
    const rowY = doc.y;
    doc.font(fontBold).fontSize(12).fillColor('#000000');
    doc.text(bItem.label, leftMargin, rowY, { width: labelColWidth });

    doc.font(fontRegular).fontSize(12).fillColor('#000000');
    doc.text(bItem.value, leftMargin + labelColWidth + 10, rowY, { width: valueColWidth });

    doc.y = Math.max(doc.y, rowY + 18);
  });

  // =========================================================================
  // FOOTER (Applied to all buffered pages)
  // =========================================================================
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const footerY = doc.page.height - 22;
    doc.font(fontRegular).fontSize(8.5).fillColor('#666666');
    doc.text(`Ref: ${nfa.ref_no || 'NFA'}`, leftMargin, footerY, { width: contentWidth / 2, align: 'left', lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, leftMargin + contentWidth / 2, footerY, { width: contentWidth / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = oldBottom;
  }

  doc.end();
}
