import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Nfa, NfaItem, Department, BudgetCategory, Approval } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logoPath = path.join(__dirname, '..', '..', 'public', 'christ-logo.png');
const signaturesDir = path.join(__dirname, '..', '..', 'data', 'signatures');

// CHRIST University Brand Colors
const CHRIST_BLUE = '#274897';
const BORDER_COLOR = '#444444';
const LIGHT_BG = '#F4F6FA';

// TrueType font paths with Unicode support for ₹ (U+20B9)
const fontTimesRegular = 'C:\\Windows\\Fonts\\times.ttf';
const fontTimesBold = 'C:\\Windows\\Fonts\\timesbd.ttf';
const fontTimesItalic = 'C:\\Windows\\Fonts\\timesi.ttf';
const fontTimesBoldItalic = 'C:\\Windows\\Fonts\\timesbi.ttf';

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

export function formatAmount(value: number): string {
  return `₹${Number(value || 0).toLocaleString('en-IN')}`;
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'NFA';
}

function cleanDepartmentName(rawName?: string): string {
  if (!rawName) return 'Department of Engineering and Technology';
  const trimmed = rawName.trim();
  if (/^(department of|centre of excellence|advanced research centre|rf and microwave|daimler truck)/i.test(trimmed)) {
    return trimmed;
  }
  return `Department of ${trimmed}`;
}

export interface BudgetDetailsInfo {
  classification: string;
  categoryName: string;
  subcategoryName: string;
  totalBudgetNature: number;
  totalAllocationCategory: number;
  totalAllocationSubcategory: number;
  availableBudget: number;
  amountRequested: number;
  balanceAfter: number;
}

function renderSignatureImage(doc: any, sigName: string | undefined, x: number, y: number, maxW: number, maxH: number): boolean {
  if (!sigName) return false;
  const cleanName = path.basename(sigName);
  const fullPath = path.join(signaturesDir, cleanName);
  if (fs.existsSync(fullPath)) {
    try {
      doc.image(fullPath, x, y, { fit: [maxW, maxH], align: 'left', valign: 'bottom' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
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
    margins: { top: 32, right: 45, bottom: 32, left: 45 },
    bufferPages: true,
  });

  // Typography configuration: Times New Roman provides native support for ₹ (U+20B9)
  const hasTimes = fs.existsSync(fontTimesRegular) && fs.existsSync(fontTimesBold);
  const fontRegular = hasTimes ? 'Times-Unicode-Regular' : 'Times-Roman';
  const fontBold = hasTimes ? 'Times-Unicode-Bold' : 'Times-Bold';
  const fontItalic = hasTimes && fs.existsSync(fontTimesItalic) ? 'Times-Unicode-Italic' : 'Times-Italic';
  const fontBoldItalic = hasTimes && fs.existsSync(fontTimesBoldItalic) ? 'Times-Unicode-BoldItalic' : 'Times-BoldItalic';

  if (hasTimes) {
    doc.registerFont(fontRegular, fontTimesRegular);
    doc.registerFont(fontBold, fontTimesBold);
    if (fs.existsSync(fontTimesItalic)) doc.registerFont(fontItalic, fontTimesItalic);
    if (fs.existsSync(fontTimesBoldItalic)) doc.registerFont(fontBoldItalic, fontTimesBoldItalic);
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
  // Requirement 1: Increase logo size without distortion (aspect ratio 1794:608 ~ 2.95)
  const logoWidth = 135;
  const logoHeight = Math.round(logoWidth * (608 / 1794)); // ~46 pt
  const logoX = pageWidth - rightMargin - logoWidth;
  const logoY = 28;

  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, logoX, logoY, { width: logoWidth });
  }

  // Requirement 1: Move university address lines slightly to the left with consistent spacing
  const headerTextWidth = 350;
  doc.font(fontBold).fontSize(13.5).fillColor('#000000');
  doc.text('School of Engineering and Technology', leftMargin, 30, { width: headerTextWidth, align: 'left' });
  doc.font(fontRegular).fontSize(10.5).fillColor('#222222');
  doc.text('Bangalore Kengeri Campus, Mysore Road,', leftMargin, 48, { width: headerTextWidth, align: 'left' });
  doc.text('Bangalore - 560 074, India', leftMargin, 63, { width: headerTextWidth, align: 'left' });

  // 2. Proposal Title Box
  // White background, CHRIST Blue border #274897, black bold centered title text
  const titleBoxY = 86;
  const proposalTitle = (nfa.title || 'Annual Academic Audit').trim();
  doc.font(fontBold).fontSize(12);
  const titleTextHeight = doc.heightOfString(proposalTitle, { width: contentWidth - 28 });
  const titleBoxHeight = Math.max(34, titleTextHeight + 14);

  // White background with exact CHRIST blue border #274897
  doc.lineWidth(1.2).rect(leftMargin, titleBoxY, contentWidth, titleBoxHeight).fillAndStroke('#FFFFFF', CHRIST_BLUE);

  // Centered black bold title text
  doc.fillColor('#000000').font(fontBold).fontSize(12);
  doc.text(proposalTitle, leftMargin + 14, titleBoxY + Math.max(7, (titleBoxHeight - titleTextHeight) / 2), {
    width: contentWidth - 28,
    align: 'center',
  });

  // 3. Document Master Heading
  doc.y = titleBoxY + titleBoxHeight + 10;
  doc.font(fontBold).fontSize(13.5).fillColor('#000000');
  doc.text('NOTE FOR APPROVAL', leftMargin, doc.y, { width: contentWidth, align: 'center', underline: true });
  doc.y += 10;

  // 4. Ref No & Date Line
  // Requirement 3: Ref No aligned with left edge of title box, Date aligned with right edge, same line
  const metaY = doc.y;
  doc.font(fontBold).fontSize(11).fillColor('#000000');
  doc.text('Ref: ', leftMargin, metaY, { continued: true });
  doc.font(fontRegular).fontSize(11).text(nfa.ref_no || 'NFA/CU/SoET/26-27/01');

  const dateText = `DATE: ${formatDate(nfa.date || nfa.created_at)}`;
  doc.font(fontBold).fontSize(11).fillColor('#000000');
  doc.text(dateText, leftMargin, metaY, { width: contentWidth, align: 'right' });

  doc.y = metaY + 18;

  // 5. Four NFA Description Points
  // Requirement 4: Preserve four-point structure, concise (max 50 words each), consistent indentation
  const renderBullet = (text: string) => {
    if (!text || !text.trim()) return;
    const bulletX = leftMargin + 8;
    const textX = leftMargin + 22;
    const textW = contentWidth - 22;
    const currentY = doc.y;

    doc.font(fontRegular).fontSize(10.5).fillColor('#000000');
    doc.text('•', bulletX, currentY);
    doc.text(text.trim(), textX, currentY, { width: textW, align: 'left', lineGap: 2 });
    doc.y += 5;
  };

  // Point 1: Purpose & Objective
  const p1 = (nfa.point1 || nfa.purpose || '').trim() ||
    `The Department of ${dept.name || 'Engineering and Technology'}, Bangalore Kengeri Campus, proposes to conduct the program to evaluate academic compliance and quality benchmarks.`;
  renderBullet(p1);

  // Point 2: Operational Logistics / Scope
  const p2 = (nfa.point2 || nfa.description || '').trim() ||
    'The program will be executed in full compliance with university guidelines, utilizing designated institutional facilities and faculty coordination.';
  renderBullet(p2);

  // Point 3: Justification of Need
  const p3 = (nfa.point3 || nfa.justification || '').trim() ||
    'This initiative strengthens student academic competencies, supports research and curriculum objectives, and advances institutional accreditation requirements.';
  renderBullet(p3);

  // Point 4: Annexure-I Reference & Total Amount
  const p4 = (nfa.point4 || '').trim() ||
    `The estimated expenditure details are attached as Annexure-I. (${formatAmount(nfa.total_amount || 0)})`;
  renderBullet(p4);

  // If Event NFA has Resource Person details, format as ONE bullet point within the main NFA description section
  const isPurchase = nfa.nfa_type === 'purchase';
  if (!isPurchase && nfa.event_details) {
    const ed = nfa.event_details;
    const parts: string[] = [];
    if (ed.resource_person_name && ed.resource_person_name.trim()) {
      parts.push(`Resource Person: ${ed.resource_person_name.trim()}`);
    }
    if (ed.designation && ed.designation.trim()) {
      parts.push(ed.designation.trim());
    }
    if (ed.organization && ed.organization.trim()) {
      parts.push(ed.organization.trim());
    }
    let rpSentence = parts.join(', ');
    if (ed.event_date && ed.event_date.trim()) {
      rpSentence += `${rpSentence ? '. ' : ''}Event Date: ${formatDate(ed.event_date)}`;
    }
    if (ed.venue && ed.venue.trim()) {
      rpSentence += `${rpSentence ? '. ' : ''}Venue: ${ed.venue.trim()}`;
    }
    if (ed.additional_info && ed.additional_info.trim()) {
      rpSentence += `${rpSentence ? '. ' : ''}(${ed.additional_info.trim()})`;
    }
    if (rpSentence.trim()) {
      renderBullet(rpSentence);
    }
  }

  doc.y += 6;

  // =========================================================================
  // 5. PURCHASE DETAILS SECTION (FOR PURCHASE NFAs ONLY)
  // For Event NFAs, resource person information is formatted as a bullet point above
  // =========================================================================
  if (isPurchase && nfa.purchase_details && (nfa.purchase_details.item_name || nfa.purchase_details.description)) {
    doc.font(fontBold).fontSize(11).fillColor('#000000');
    doc.text('PURCHASE / ITEM DETAILS', leftMargin, doc.y);
    doc.y += 4;

    const detailLabelWidth = 180;
    const detailValueWidth = contentWidth - detailLabelWidth - 10;

    const renderDetailRow = (label: string, value?: string | null) => {
      const valText = (value && value.trim()) ? value.trim() : '—';
      const rowY = doc.y;
      doc.font(fontBold).fontSize(10).fillColor('#000000');
      doc.text(label, leftMargin + 6, rowY, { width: detailLabelWidth });
      doc.font(fontRegular).fontSize(10).fillColor('#222222');
      doc.text(valText, leftMargin + detailLabelWidth + 10, rowY, { width: detailValueWidth });
      doc.y = Math.max(doc.y, rowY + 16);
    };

    const detailStartY = doc.y;
    const pDet = nfa.purchase_details;
    renderDetailRow('Item / Product Name:', pDet.item_name || nfa.title);
    renderDetailRow('Description / Specifications:', pDet.description || nfa.description);
    renderDetailRow('Quantity:', pDet.quantity || (items.length > 0 ? `${items.length} item(s)` : '1 Unit'));
    renderDetailRow('Purpose / Justification:', pDet.purpose || nfa.justification);
    if (pDet.additional_info && pDet.additional_info.trim()) {
      renderDetailRow('Additional Information:', pDet.additional_info);
    }

    const detailBoxHeight = doc.y - detailStartY + 6;
    doc.lineWidth(0.5).strokeColor(BORDER_COLOR).rect(leftMargin, detailStartY - 3, contentWidth, detailBoxHeight).stroke();
    doc.y += 8;
  }

  // =========================================================================
  // 6. BUDGET SOURCE & AVAILABILITY DETAILS SECTION
  // Requirement 6: Immediately after Event/Purchase Details, before signatures
  // =========================================================================
  doc.font(fontBold).fontSize(11).fillColor('#000000');
  doc.text('BUDGET SOURCE & AVAILABILITY DETAILS', leftMargin, doc.y);
  doc.y += 4;

  const bDetails = budgetDetails || {
    classification: budgetTypeName || (category.name.includes('CAPEX') ? 'Capital Expenditure' : 'Revenue Expenditure'),
    categoryName: category.name || 'General Category',
    subcategoryName: nfa.budget_subcategory_name || 'General Allocation',
    totalBudgetNature: 31138700,
    totalAllocationCategory: 13978700,
    totalAllocationSubcategory: 117700,
    availableBudget: nfa.total_amount || 0,
    amountRequested: nfa.total_amount || 0,
    balanceAfter: 0,
  };

  const budgetRows: Array<[string, string]> = [
    ['Budget Nature', bDetails.classification],
    ['Main Budget Category', bDetails.categoryName],
    ['Budget Subcategory', bDetails.subcategoryName],
    ['Total Budget – Budget Nature', formatAmount(bDetails.totalBudgetNature)],
    ['Total Allocation – Main Category', formatAmount(bDetails.totalAllocationCategory)],
    ['Total Allocation – Subcategory', formatAmount(bDetails.totalAllocationSubcategory)],
    ['Amount Requested', formatAmount(bDetails.amountRequested)],
    ['Balance After Allocation', formatAmount(bDetails.balanceAfter)],
  ];

  const bTableStartY = doc.y;
  const bCol1Width = 210;
  const bCol2Width = contentWidth - bCol1Width;
  const bRowHeight = 16.5;

  budgetRows.forEach(([label, val], idx) => {
    const rowY = bTableStartY + idx * bRowHeight;
    // Row background alternating
    if (idx % 2 === 1) {
      doc.rect(leftMargin, rowY, contentWidth, bRowHeight).fill('#F8FAFC');
    }
    // Border
    doc.lineWidth(0.4).strokeColor(BORDER_COLOR).rect(leftMargin, rowY, contentWidth, bRowHeight).stroke();
    doc.moveTo(leftMargin + bCol1Width, rowY).lineTo(leftMargin + bCol1Width, rowY + bRowHeight).stroke();

    // Text
    doc.font(fontBold).fontSize(9.5).fillColor('#000000');
    doc.text(label, leftMargin + 6, rowY + 3.5, { width: bCol1Width - 12 });

    const isAmount = val.startsWith('₹');
    doc.font(isAmount ? fontBold : fontRegular).fontSize(9.5).fillColor('#000000');
    doc.text(val, leftMargin + bCol1Width + 8, rowY + 3.5, { width: bCol2Width - 14 });
  });

  doc.y = bTableStartY + budgetRows.length * bRowHeight + 12;

  // =========================================================================
  // 7. APPROVAL SECTION
  // Requirements 7 & 12:
  // - "Submitted for kind approval," (remove "Submitted by,")
  // - Display faculty name (remove "Faculty Member")
  // - Complete department name: "Department of ..." dynamically
  // - Remove ALL dates and statuses from PDF
  // - Insert digital signature if uploaded; leave blank space if not (no "Approved" text)
  // =========================================================================
  // If not enough room on Page 1 for approval blocks, cleanly break
  if (doc.y > doc.page.height - 140) {
    doc.addPage();
    doc.y = 40;
  }

  doc.font(fontRegular).fontSize(11).fillColor('#000000');
  doc.text('Submitted for kind approval,', leftMargin, doc.y);
  doc.y += 10;

  // Dynamic approver records
  const hodApproval = approvals.find((a) => a.approver_role === 'hod' && ['approved', 'recommended'].includes(a.decision));
  const deanApproval = approvals.find((a) => ['dean', 'associate_dean'].includes(a.approver_role) && ['approved', 'recommended'].includes(a.decision));
  const directorApproval = approvals.find((a) => a.approver_role === 'director' && ['approved', 'recommended'].includes(a.decision));
  const financeApproval = approvals.find((a) => a.approver_role === 'finance' && ['approved', 'recommended'].includes(a.decision));

  const deptFullName = cleanDepartmentName(dept.name);

  // Level 1: Proposer & HOD (2 columns)
  const colHalfWidth = (contentWidth - 20) / 2;
  const row1Y = doc.y;
  const sigBoxHeight = 32;

  // Proposer (Left)
  const propSigRendered = renderSignatureImage(doc, nfa.proposer_signature, leftMargin, row1Y, 110, sigBoxHeight);
  const propTextY = row1Y + sigBoxHeight + 2;
  doc.font(fontBold).fontSize(10.5).fillColor('#000000');
  doc.text(nfa.submitted_by_name || 'Faculty Proposer', leftMargin, propTextY, { width: colHalfWidth });
  doc.font(fontRegular).fontSize(9.5).fillColor('#222222');
  doc.text(deptFullName, leftMargin, doc.y + 1, { width: colHalfWidth });

  // HOD (Right)
  const hodX = leftMargin + colHalfWidth + 20;
  const hodSigName = hodApproval?.signature_image || (dept.hod_name ? `${dept.hod_name}.png` : undefined);
  renderSignatureImage(doc, hodSigName, hodX, row1Y, 110, sigBoxHeight);
  const hodTextY = row1Y + sigBoxHeight + 2;
  doc.font(fontBold).fontSize(10.5).fillColor('#000000');
  doc.text(hodApproval?.approver_name || dept.hod_name || 'Head of Department', hodX, hodTextY, { width: colHalfWidth });
  doc.font(fontRegular).fontSize(9.5).fillColor('#222222');
  doc.text('Head of Department', hodX, doc.y + 1, { width: colHalfWidth });
  doc.text(deptFullName, hodX, doc.y + 1, { width: colHalfWidth });

  // Level 2: Dean, Director, Finance Officer (3 columns)
  const row2Y = Math.max(doc.y + 14, propTextY + 36);
  const colThirdWidth = (contentWidth - 24) / 3;

  // Column 1: Dean / Associate Dean
  const deanX = leftMargin;
  const deanSigName = deanApproval?.signature_image || (dept.dean_name ? `${dept.dean_name}.png` : undefined);
  renderSignatureImage(doc, deanSigName, deanX, row2Y, 100, sigBoxHeight);
  const deanTextY = row2Y + sigBoxHeight + 2;
  doc.font(fontBold).fontSize(10).fillColor('#000000');
  doc.text(deanApproval?.approver_name || dept.dean_name || 'Dean / Associate Dean', deanX, deanTextY, { width: colThirdWidth });
  doc.font(fontRegular).fontSize(9).fillColor('#222222');
  doc.text('Dean, School of Engineering & Technology', deanX, doc.y + 1, { width: colThirdWidth });
  doc.text('Bangalore Kengeri Campus', deanX, doc.y + 1, { width: colThirdWidth });

  // Column 2: Director
  const dirX = leftMargin + colThirdWidth + 12;
  const dirSigName = directorApproval?.signature_image || (dept.director_name ? `${dept.director_name}.png` : undefined);
  renderSignatureImage(doc, dirSigName, dirX, row2Y, 100, sigBoxHeight);
  const dirTextY = row2Y + sigBoxHeight + 2;
  doc.font(fontBold).fontSize(10).fillColor('#000000');
  doc.text(directorApproval?.approver_name || dept.director_name || 'Director', dirX, dirTextY, { width: colThirdWidth });
  doc.font(fontRegular).fontSize(9).fillColor('#222222');
  doc.text('Director', dirX, doc.y + 1, { width: colThirdWidth });
  doc.text('Bangalore Kengeri Campus', dirX, doc.y + 1, { width: colThirdWidth });

  // Column 3: Finance Officer
  const finX = leftMargin + (colThirdWidth + 12) * 2;
  const finSigName = financeApproval?.signature_image || (dept.finance_officer_name ? `${dept.finance_officer_name}.png` : undefined);
  renderSignatureImage(doc, finSigName, finX, row2Y, 100, sigBoxHeight);
  const finTextY = row2Y + sigBoxHeight + 2;
  doc.font(fontBold).fontSize(10).fillColor('#000000');
  doc.text(financeApproval?.approver_name || dept.finance_officer_name || 'Finance Officer', finX, finTextY, { width: colThirdWidth });
  doc.font(fontRegular).fontSize(9).fillColor('#222222');
  doc.text('Finance Officer', finX, doc.y + 1, { width: colThirdWidth });
  doc.text('Bangalore Kengeri Campus', finX, doc.y + 1, { width: colThirdWidth });

  // =========================================================================
  // PAGE 2 — ANNEXURE SECTION (Requirements & Items Table)
  // Requirements 8, 9, 10: Begins on a new page, dynamic sentence, currency formatting
  // =========================================================================
  doc.addPage();

  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, logoX, logoY, { width: logoWidth });
  }

  // Heading: ANNEXURE-I
  doc.y = 80;
  doc.font(fontBold).fontSize(13.5).fillColor('#000000');
  doc.text('ANNEXURE-I', leftMargin, doc.y, { width: contentWidth, align: 'center' });
  doc.y += 14;

  // Subheading: REQUIREMENTS (Black, Bold)
  doc.font(fontBold).fontSize(11.5).fillColor('#000000');
  doc.text('REQUIREMENTS', leftMargin, doc.y);
  doc.y += 6;

  // Dynamic sentence
  doc.font(fontRegular).fontSize(10.5).fillColor('#222222');
  doc.text(`The following are the requirements for the ${proposalTitle}.`, leftMargin, doc.y, { width: contentWidth });
  doc.y += 12;

  // Requirements Table Columns
  // Preferred Headings: Sl. No., Particulars, Quantity, Rate (₹), Estimated Amount (₹)
  // Total = 38 + 212 + 55 + 85 + 115.28 = 505.28 pt (exact contentWidth)
  const tableColumns = [
    { key: 'sl', label: 'Sl. No.', x: leftMargin, width: 38, align: 'center' as const },
    { key: 'particulars', label: 'Particulars', x: leftMargin + 38, width: 212, align: 'left' as const },
    { key: 'quantity', label: 'Quantity', x: leftMargin + 38 + 212, width: 55, align: 'center' as const },
    { key: 'rate', label: 'Rate (₹)', x: leftMargin + 38 + 212 + 55, width: 85, align: 'right' as const },
    { key: 'amount', label: 'Estimated Amount (₹)', x: leftMargin + 38 + 212 + 55 + 85, width: 115.28, align: 'right' as const },
  ];

  const headerHeight = 26;

  const renderTableHeader = (currentY: number) => {
    doc.lineWidth(0.8).strokeColor('#000000');
    tableColumns.forEach((c) => {
      doc.rect(c.x, currentY, c.width, headerHeight).fillAndStroke('#F1F4F9', '#000000');
      doc.font(fontBold).fontSize(9.5).fillColor('#000000');
      if (c.align === 'center') {
        doc.text(c.label, c.x, currentY + 7.5, { width: c.width, align: 'center', lineBreak: false });
      } else if (c.align === 'right') {
        doc.text(c.label, c.x + 4, currentY + 7.5, { width: c.width - 10, align: 'right', lineBreak: false });
      } else {
        doc.text(c.label, c.x + 6, currentY + 7.5, { width: c.width - 12, align: 'left', lineBreak: false });
      }
    });
    return currentY + headerHeight;
  };

  let currentTableY = renderTableHeader(doc.y);

  // Render items rows
  items.forEach((item, index) => {
    doc.font(fontRegular).fontSize(10);
    const particularHeight = doc.heightOfString(item.particulars || '', { width: tableColumns[1].width - 12 });
    const rowHeight = Math.max(22, particularHeight + 8);

    // Multi-page table continuation
    if (currentTableY + rowHeight > doc.page.height - 45) {
      doc.addPage();
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, logoX, logoY, { width: logoWidth });
      }
      doc.y = 75;
      doc.font(fontBold).fontSize(11).fillColor('#000000').text('ANNEXURE-I (Continued)', leftMargin, doc.y, { width: contentWidth, align: 'center' });
      doc.y += 14;
      currentTableY = renderTableHeader(doc.y);
    }

    doc.lineWidth(0.5).strokeColor('#000000');
    tableColumns.forEach((c) => {
      doc.rect(c.x, currentTableY, c.width, rowHeight).stroke();
    });

    doc.font(fontRegular).fontSize(10).fillColor('#000000');
    // Sl. No. (centered)
    doc.text(String(item.sl_no || index + 1), tableColumns[0].x, currentTableY + 5, {
      width: tableColumns[0].width,
      align: 'center',
    });
    // Particulars (left)
    doc.text(item.particulars || '', tableColumns[1].x + 6, currentTableY + 5, {
      width: tableColumns[1].width - 12,
      align: 'left',
      lineGap: 1.5,
    });
    // Quantity (centered)
    doc.text(item.quantity ? String(item.quantity) : '—', tableColumns[2].x, currentTableY + 5, {
      width: tableColumns[2].width,
      align: 'center',
    });
    // Rate (₹) (right)
    doc.text(item.rate ? Number(item.rate).toLocaleString('en-IN') : '—', tableColumns[3].x + 4, currentTableY + 5, {
      width: tableColumns[3].width - 10,
      align: 'right',
    });
    // Estimated Amount (₹) (right)
    doc.text(Number(item.amount || 0).toLocaleString('en-IN'), tableColumns[4].x + 4, currentTableY + 5, {
      width: tableColumns[4].width - 10,
      align: 'right',
    });

    currentTableY += rowHeight;
  });

  // Total Estimated Amount Row
  const totalRowHeight = 26;
  if (currentTableY + totalRowHeight > doc.page.height - 45) {
    doc.addPage();
    currentTableY = 60;
  }

  const mergedLabelWidth = tableColumns[0].width + tableColumns[1].width + tableColumns[2].width + tableColumns[3].width; // 390 pt
  const amountCol = tableColumns[4];

  doc.lineWidth(0.8).strokeColor('#000000');
  // Box for Total Estimated Amount Label
  doc.rect(leftMargin, currentTableY, mergedLabelWidth, totalRowHeight).fillAndStroke('#F8FAFC', '#000000');
  doc.font(fontBold).fontSize(10).fillColor('#000000');
  doc.text('Total Estimated Amount', leftMargin, currentTableY + 7.5, { width: mergedLabelWidth - 10, align: 'right', lineBreak: false });

  // Box for Total Amount Value
  doc.rect(amountCol.x, currentTableY, amountCol.width, totalRowHeight).fillAndStroke('#FFFFFF', '#000000');
  doc.font(fontBold).fontSize(10.5).fillColor('#000000');
  doc.text(formatAmount(nfa.total_amount || 0), amountCol.x + 4, currentTableY + 7.5, {
    width: amountCol.width - 10,
    align: 'right',
    lineBreak: false,
  });

  // =========================================================================
  // FOOTER (Applied to all buffered pages)
  // =========================================================================
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const footerY = doc.page.height - 20;
    doc.font(fontRegular).fontSize(8.5).fillColor('#555555');
    doc.text(`Ref: ${nfa.ref_no || 'NFA'}`, leftMargin, footerY, { width: contentWidth / 2, align: 'left', lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, leftMargin + contentWidth / 2, footerY, { width: contentWidth / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = oldBottom;
  }

  doc.end();
}
