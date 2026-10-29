import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Nfa, NfaItem, Department, BudgetCategory } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logoPath = path.join(__dirname, '..', '..', 'public', 'christ-logo.png');
const timesRegular = 'C:\\Windows\\Fonts\\times.ttf';
const timesBold = 'C:\\Windows\\Fonts\\timesbd.ttf';

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

function formatAmount(value: number) {
  return `Rs.${Number(value || 0).toLocaleString('en-IN')}`;
}

function safeFileName(value: string) {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'NFA';
}

/** Renders one NFA as a PDF following the supplied NOTE FOR APPROVAL template. */
export function renderNfaPdf(
  res: Response,
  nfa: Nfa,
  items: NfaItem[],
  dept: Department,
  category: BudgetCategory,
  projectName?: string
) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 43, right: 42, bottom: 35, left: 90 },
    bufferPages: true,
  });
  const contentFont = fs.existsSync(timesRegular) ? 'Times New Roman' : 'Times-Roman';
  const boldFont = fs.existsSync(timesBold) ? 'Times New Roman Bold' : 'Times-Bold';
  if (fs.existsSync(timesRegular)) doc.registerFont(contentFont, timesRegular);
  if (fs.existsSync(timesBold)) doc.registerFont(boldFont, timesBold);
  res.setHeader('Content-Type', 'application/pdf');
  const reference = nfa.ref_no.replace(/\//g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(projectName || nfa.title || reference)}_${reference}.pdf"`);
  doc.pipe(res);

  const addHeader = () => {
    if (fs.existsSync(logoPath)) doc.image(logoPath, 385, 28, { width: 165 });
    doc.fontSize(14).font(boldFont).text('School of Engineering and Technology', 90, 77, { width: 415, align: 'center', lineGap: 0 });
    doc.fontSize(14).font(boldFont).text('Kengeri Campus, Mysore Road', 90, 98, { width: 415, align: 'center', lineGap: 0 });
    doc.fontSize(14).font(boldFont).text('Bangalore - 560 074, India', 90, 119, { width: 415, align: 'center', lineGap: 0 });
    doc.y = 145;
  };
  addHeader();

  const titleBoxX = 42;
  const titleBoxY = 145;
  const titleBoxWidth = 511;
  const titleBoxHeight = 36;
  doc.lineWidth(3).strokeColor('#6B1735').rect(titleBoxX, titleBoxY, titleBoxWidth, titleBoxHeight).stroke();
  doc.lineWidth(1).strokeColor('#6B1735').rect(titleBoxX + 5, titleBoxY + 5, titleBoxWidth - 10, titleBoxHeight - 10).stroke();
  doc.fontSize(13).font(boldFont).fillColor('#000000').text(nfa.title, titleBoxX + 10, titleBoxY + 10, { width: titleBoxWidth - 20, align: 'center', lineGap: 0 });
  doc.fontSize(14).font(boldFont).text('NOTE FOR APPROVAL', 90, 195, { width: 415, align: 'center', lineGap: 0, underline: true });

  doc.fontSize(10).font(contentFont).text(`Ref: ${nfa.ref_no}`, 90, 237, { width: 205 });
  doc.text(`DATE: ${formatDate(nfa.date)}`, 300, 237, { width: 205, align: 'right' });

  let bodyY = 277;
  doc.font(contentFont).fontSize(10);
  const numberedPurpose = `1) ${nfa.purpose}`;
  const numberedDescription = `2) ${nfa.description}`;
  doc.text(numberedPurpose, 90, bodyY, { width: 415, align: 'justify', lineGap: 0 });
  bodyY += Math.max(30, doc.heightOfString(numberedPurpose, { width: 415 }) + 9);
  doc.text(numberedDescription, 90, bodyY, { width: 415, align: 'justify', lineGap: 0 });
  bodyY += Math.max(30, doc.heightOfString(numberedDescription, { width: 415 }) + 9);
  if (nfa.justification) {
    doc.font(boldFont).text('Justification: ', 90, bodyY, { continued: true }).font(contentFont).text(nfa.justification, { width: 415, align: 'justify' });
    bodyY += Math.max(24, doc.heightOfString(`Justification: ${nfa.justification}`, { width: 415 }) + 8);
  }
  if (nfa.sdgs) {
    doc.font(boldFont).text('Aligned SDGs: ', 90, bodyY, { continued: true }).font(contentFont).text(nfa.sdgs, { width: 415 });
    bodyY += Math.max(24, doc.heightOfString(`Aligned SDGs: ${nfa.sdgs}`, { width: 415 }) + 8);
  }

  const requestText = `Requesting you to allocate the budget under ${category.name} in the Departmental ${category.name.includes('CAPEX') ? 'Capital' : 'Revenue'} Expenditure Budget. The expenditure details are as follows.`;
  doc.font(contentFont).text(requestText, 90, bodyY, { width: 415, align: 'justify' });
  bodyY += doc.heightOfString(requestText, { width: 415 }) + 12;

  const tableTop = bodyY;
  const tableColumns = [
    { label: 'Sl No', x: 90, width: 50 },
    { label: 'Item', x: 140, width: 190 },
    { label: 'Unit / Quantity', x: 330, width: 105 },
    { label: 'Cost', x: 435, width: 110 },
  ];
  const tableRows = items.map((item) => ({
    values: [`${item.sl_no}`, item.particulars, item.quantity || '', formatAmount(item.amount)],
  }));
  let rowY = tableTop;
  if (items.length <= 3) {
    const headerHeight = 25;
    const rowHeights = tableRows.map((row) => Math.max(26, doc.heightOfString(row.values[1], { width: 180 }) + 10));
    const totalHeight = headerHeight + rowHeights.reduce((sum, height) => sum + height, 0) + 26;
    doc.lineWidth(1).strokeColor('#000000').rect(90, tableTop, 455, totalHeight).stroke();
    tableColumns.forEach((column, index) => {
      doc.font(boldFont).fontSize(9).text(column.label, column.x + 5, tableTop + 7, { width: column.width - 10, align: index === 3 ? 'right' : 'left' });
      if (index > 0) doc.moveTo(column.x, tableTop).lineTo(column.x, tableTop + totalHeight).stroke();
    });
    doc.moveTo(90, tableTop + headerHeight).lineTo(545, tableTop + headerHeight).stroke();
    rowY = tableTop + headerHeight;
    tableRows.forEach((row, rowIndex) => {
      const rowHeight = rowHeights[rowIndex];
      row.values.forEach((value, index) => {
        const column = tableColumns[index];
        doc.font(contentFont).fontSize(9).text(value, column.x + 5, rowY + 7, { width: column.width - 10, align: index === 3 ? 'right' : 'left' });
      });
      rowY += rowHeight;
      doc.moveTo(90, rowY).lineTo(545, rowY).stroke();
    });
    doc.font(boldFont).fontSize(10).text('Total', 140, rowY + 7, { width: 295 });
    doc.text(formatAmount(nfa.total_amount), 435, rowY + 7, { width: 105, align: 'right' });
  } else {
    doc.font(contentFont).fontSize(9).text('The complete expenditure table is provided in Annexure-I.', 90, tableTop, { width: 415 });
    rowY = tableTop + 28;
  }

  const signatureX = [50, 215, 380];
  const submittedLabelY = rowY + 42;
  const submittedY = submittedLabelY + 43;
  doc.font(contentFont).text('Submitted for kind approval.', 90, submittedLabelY);
  doc.font(boldFont);
  doc.text(nfa.submitted_by_name || dept.faculty_name || '_______________________', signatureX[0], submittedY, { width: 245 });
  doc.text(nfa.hod_name || dept.hod_name || '_______________________', 300, submittedY, { width: 245 });
  doc.font(contentFont);
  const signerTitleY = submittedY + 14;
  doc.text(`${nfa.submitted_by_designation || 'Faculty'}, Dept. of ${dept.code}`, signatureX[0], signerTitleY, { width: 245 });
  doc.text(`HOD / Coordinator, Dept. of ${dept.code}`, 300, signerTitleY, { width: 245 });
  const officersY = signerTitleY + 45;
  const officerNames = [dept.associate_dean_name, dept.director_name, dept.finance_officer_name];
  const officerTitles = ['Associate Dean, SoET', 'Director, SoET', 'Finance Officer, Kengeri Campus'];
  officerNames.forEach((name, index) => {
    if (!name) return;
    doc.font(boldFont).text(name, signatureX[index], officersY, { width: 165 });
    doc.font(contentFont).text(officerTitles[index], signatureX[index], officersY + 14, { width: 165 });
  });
  if (items.length > 3) {
    doc.addPage();
    addHeader();
    doc.fontSize(13).font(boldFont).text('ANNEXURE-I', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(11).font(boldFont).text('Requirements:', { align: 'left' });
    if (nfa.requirements) {
      doc.moveDown(0.4);
      doc.fontSize(10).font(contentFont).text(nfa.requirements, { align: 'left', lineGap: 0 });
    }
    doc.moveDown(1);

    const annexureTableTop = doc.y;
    const columns = [
      { label: 'Sl. No', x: 50, width: 38 },
      { label: 'Particulars', x: 88, width: 265 },
      { label: 'Quantity', x: 353, width: 72 },
      { label: 'Estimated Amount', x: 425, width: 120 },
    ];
    doc.fontSize(9).font(boldFont);
    columns.forEach((column, index) => {
      doc.text(column.label, column.x, annexureTableTop, { width: column.width });
      if (index > 0) doc.moveTo(column.x, annexureTableTop).lineTo(column.x, annexureTableTop + 24).stroke();
    });
    doc.moveTo(50, annexureTableTop).lineTo(545, annexureTableTop).stroke();
    doc.moveTo(50, annexureTableTop + 24).lineTo(545, annexureTableTop + 24).stroke();
    doc.y = annexureTableTop + 30;

    doc.font(contentFont).fontSize(9);
    items.forEach((it) => {
      const rowY = doc.y;
      const rowHeight = Math.max(
        doc.heightOfString(it.particulars, { width: 255 }),
        doc.heightOfString(it.quantity || '', { width: 65 }),
        14
      ) + 8;
      doc.text(`${it.sl_no}.`, 50, rowY, { width: 38 });
      doc.text(it.particulars, 88, rowY, { width: 255 });
      doc.text(it.quantity || '', 353, rowY, { width: 65 });
      doc.text(formatAmount(it.amount), 425, rowY, { width: 120, align: 'right' });
      doc.y = rowY + rowHeight;
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    });

    doc.moveTo(50, annexureTableTop).lineTo(50, doc.y).stroke();
    doc.moveTo(88, annexureTableTop).lineTo(88, doc.y).stroke();
    doc.moveTo(353, annexureTableTop).lineTo(353, doc.y).stroke();
    doc.moveTo(425, annexureTableTop).lineTo(425, doc.y).stroke();
    doc.moveTo(545, annexureTableTop).lineTo(545, doc.y).stroke();
    doc.moveDown(0.35);
    doc.font(boldFont).text(`Total Amount : ${formatAmount(nfa.total_amount)}`, { align: 'right' });
    doc.moveDown(0.8);
    doc.font(contentFont).fontSize(9).text(`Department: ${dept.name}`);
    doc.text(`Category: ${category.name}`);
    doc.text(`Status: ${nfa.status.replace(/_/g, ' ').toUpperCase()}`);
  }

  doc.end();
}
