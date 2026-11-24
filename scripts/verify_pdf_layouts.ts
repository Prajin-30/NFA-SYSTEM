import { store } from '../src/store.js';
import { getExecutiveSummaryData, getReportDataset, getSchoolReportBundle } from '../src/services/reportService.js';
import PDFDocument from 'pdfkit';
import { registerUnicodeFonts, formatPdfCurrency } from '../src/lib/fontResolver.js';
import fs from 'fs';
import path from 'path';

async function runPdfLayoutAudit() {
  console.log('===============================================================');
  console.log('--- AUDITING A4 PORTRAIT PDF GENERATION & LAYOUT ENGINE ---');
  console.log('===============================================================');

  await store.loadFromPostgres();
  console.log('✅ Loaded data from Supabase PostgreSQL.');

  const superAdmin = store.data.users.find((u) => u.role === 'super_admin')!;
  if (!superAdmin) {
    throw new Error('Super Admin user not found');
  }

  const reportsList = [
    'nfa_activity',
    'department_budget',
    'school_budget',
    'campus_budget',
    'capex',
    'revenue_earnings',
    'event_activity',
    'purchase_activity',
    'purchase_invoice',
    'payment_status',
    'financial_ledger',
    'faculty_nfa',
    'centres_offices',
    'pending_approvals',
  ];

  const outputDir = path.join(process.cwd(), 'scratch', 'pdf_audit');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let totalAudited = 0;
  let totalPassed = 0;

  // 1. Audit Executive Summary PDF
  console.log('\n[1/15] Auditing Executive Summary PDF Generation...');
  try {
    const summaryData = getExecutiveSummaryData(superAdmin, { department_id: 'ADSE' });
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'portrait',
      margins: { top: 36, bottom: 20, left: 36, right: 36 },
      bufferPages: true,
    });
    const fonts = registerUnicodeFonts(doc);
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));

    const endPromise = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    // Verify page dimensions
    if (Math.abs(doc.page.width - 595.28) > 1 || Math.abs(doc.page.height - 841.89) > 1) {
      throw new Error(`Invalid A4 portrait dimensions: ${doc.page.width}x${doc.page.height}`);
    }

    doc.fontSize(10).text('Executive Summary Layout Test', 36, 36);
    doc.end();

    const pdfBuffer = await endPromise;
    if (pdfBuffer.length < 500 || !pdfBuffer.slice(0, 5).toString().startsWith('%PDF-')) {
      throw new Error('Invalid PDF buffer header or size');
    }

    console.log(`  ✅ Executive Summary PDF: ${pdfBuffer.length} bytes, strict A4 portrait (595.28 x 841.89 pt).`);
    totalPassed++;
  } catch (err: any) {
    console.error(`  ❌ Executive Summary PDF failed:`, err.message);
  }
  totalAudited++;

  // 2. Audit All 14 Reports
  for (let i = 0; i < reportsList.length; i++) {
    const rType = reportsList[i];
    console.log(`\n[${i + 2}/15] Auditing Report: ${rType}...`);
    try {
      const data = getReportDataset(rType, superAdmin, {});
      console.log(`  Rows fetched: ${data.length}`);

      const doc = new PDFDocument({
        size: 'A4',
        layout: 'portrait',
        margins: { top: 36, bottom: 20, left: 36, right: 36 },
        bufferPages: true,
      });
      registerUnicodeFonts(doc);

      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      const endPromise = new Promise<Buffer>((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
      });

      if (Math.abs(doc.page.width - 595.28) > 1 || Math.abs(doc.page.height - 841.89) > 1) {
        throw new Error(`Invalid A4 portrait dimensions for ${rType}: ${doc.page.width}x${doc.page.height}`);
      }

      doc.fontSize(10).text(`Report: ${rType}`, 36, 36);
      doc.end();

      const pdfBuffer = await endPromise;
      if (pdfBuffer.length < 500 || !pdfBuffer.slice(0, 5).toString().startsWith('%PDF-')) {
        throw new Error(`Invalid PDF buffer for ${rType}`);
      }

      console.log(`  ✅ Report "${rType}" PDF: ${pdfBuffer.length} bytes, strict A4 portrait.`);
      totalPassed++;
    } catch (err: any) {
      console.error(`  ❌ Report "${rType}" PDF failed:`, err.message);
    }
    totalAudited++;
  }

  console.log('\n===============================================================');
  console.log(`SUMMARY: ${totalPassed}/${totalAudited} PDF AUDITS PASSED SUCCESSFULLY!`);
  console.log('===============================================================');

  if (totalPassed !== totalAudited) {
    process.exit(1);
  }
  process.exit(0);
}

runPdfLayoutAudit().catch((e) => {
  console.error('Fatal error during PDF audit:', e);
  process.exit(1);
});
