import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { store } from '../store.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import type { PurchaseInvoice, InvoiceVerificationStatus, InvoicePaymentStatus } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const attachmentsDir = path.join(__dirname, '..', '..', 'data', 'attachments');

if (!fs.existsSync(attachmentsDir)) {
  fs.mkdirSync(attachmentsDir, { recursive: true });
}

const invoiceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, attachmentsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `inv_${uuid()}${ext}`;
    cb(null, uniqueName);
  },
});

const allowedMimes = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
];
const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png'];

const uploadInvoiceAttachment = multer({
  storage: invoiceStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid document format. Allowed: PDF, JPG, JPEG, PNG (Max 10MB).'));
    }
  },
});

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth);

/**
 * GET /api/invoices/dashboard-summary
 * Compact summary for Faculty Home Dashboard:
 * Total Invoices, Pending Verification, Awaiting Payment, Paid Invoices.
 * Also returns `has_approved_purchases` indicating if the widget should be displayed.
 */
invoicesRouter.get('/dashboard-summary', async (req: AuthedRequest, res) => {
  const user = req.user!;
  const fyId = (req.query.fy as string) || store.data.financial_years.find((f) => f.is_active)?.id;

  // Filter approved Purchase NFAs
  const eligibleNfas = store.data.nfas.filter((n) => {
    if (n.is_deleted) return false;
    const isPurchase = n.nfa_type === 'purchase' || Boolean(n.purchase_details);
    if (!isPurchase) return false;
    if (n.status !== 'approved') return false;
    if (fyId && n.financial_year_id !== fyId) return false;

    // Faculty only views their own
    if (user.role === 'faculty') {
      return n.created_by === user.id;
    }
    // HOD / Dean restricted to department
    if (['hod', 'dean', 'associate_dean'].includes(user.role)) {
      return n.department_id === user.department_id;
    }
    // Finance / Director / Super Admin sees all
    return true;
  });

  const hasApprovedPurchases = eligibleNfas.length > 0;
  const eligibleNfaIds = new Set(eligibleNfas.map((n) => n.id));

  const allInvoices = store.data.purchase_invoices || [];
  const scopedInvoices = allInvoices.filter((inv) => eligibleNfaIds.has(inv.nfa_id));

  const totalInvoices = scopedInvoices.length;
  const pendingVerification = scopedInvoices.filter(
    (i) => i.verification_status === 'pending_verification'
  ).length;
  const awaitingPayment = scopedInvoices.filter(
    (i) => i.verification_status === 'verified' && i.payment_status !== 'paid'
  ).length;
  const paid = scopedInvoices.filter((i) => i.payment_status === 'paid').length;

  res.json({
    has_approved_purchases: hasApprovedPurchases,
    approved_purchases_count: eligibleNfas.length,
    total_invoices: totalInvoices,
    pending_verification: pendingVerification,
    awaiting_payment: awaitingPayment,
    paid: paid,
  });
});

/**
 * GET /api/invoices
 * Returns eligible Purchase NFAs with aggregated invoice numbers, remaining uninvoiced, and child invoices.
 */
invoicesRouter.get('/', async (req: AuthedRequest, res) => {
  const user = req.user!;
  const fyId = (req.query.fy as string) || store.data.financial_years.find((f) => f.is_active)?.id;
  const deptFilter = req.query.dept as string;

  // 1. Find eligible Purchase NFAs (must be finally approved)
  const eligibleNfas = store.data.nfas.filter((n) => {
    if (n.is_deleted) return false;
    const isPurchase = n.nfa_type === 'purchase' || Boolean(n.purchase_details);
    if (!isPurchase) return false;
    if (n.status !== 'approved') return false;
    if (fyId && n.financial_year_id !== fyId) return false;

    if (user.role === 'faculty') {
      return n.created_by === user.id;
    }
    if (['hod', 'dean', 'associate_dean'].includes(user.role)) {
      return n.department_id === user.department_id;
    }
    if (deptFilter && deptFilter !== 'all') {
      return n.department_id === deptFilter;
    }
    return true;
  });

  const allInvoices = store.data.purchase_invoices || [];

  const results = eligibleNfas.map((nfa) => {
    const invoices = allInvoices.filter((inv) => inv.nfa_id === nfa.id);
    const approvedAmount = Number(nfa.total_amount) || 0;
    const totalInvoiced = invoices.reduce((s, i) => s + (Number(i.invoice_amount) || 0), 0);
    const totalPaid = invoices.reduce((s, i) => s + (Number(i.paid_amount) || 0), 0);
    const remainingUninvoiced = Math.max(0, approvedAmount - totalInvoiced);
    const invoicesCount = invoices.length;

    let invoiceStatus = 'uninvoiced';
    if (invoicesCount === 0) {
      invoiceStatus = 'uninvoiced';
    } else if (totalPaid >= approvedAmount && approvedAmount > 0) {
      invoiceStatus = 'fully_paid';
    } else if (totalPaid > 0) {
      invoiceStatus = 'partially_paid';
    } else if (totalInvoiced >= approvedAmount) {
      invoiceStatus = 'fully_invoiced';
    } else {
      invoiceStatus = 'partially_invoiced';
    }

    const dept = store.data.departments.find((d) => d.id === nfa.department_id);

    return {
      nfa_id: nfa.id,
      ref_no: nfa.ref_no,
      title: nfa.title,
      vendor_name:
        nfa.purchase_details?.item_name ||
        nfa.quotations?.[0]?.vendor_name ||
        'Vendor Not Specified',
      department_id: nfa.department_id,
      department_name: dept?.name || '',
      date: nfa.date,
      approved_amount: approvedAmount,
      total_invoiced: totalInvoiced,
      total_paid: totalPaid,
      remaining_uninvoiced: remainingUninvoiced,
      invoices_count: invoicesCount,
      invoice_status: invoiceStatus,
      invoices: invoices,
      created_by: nfa.created_by,
      submitted_by_name: nfa.submitted_by_name || '',
    };
  });

  res.json(results);
});

/**
 * POST /api/invoices/upload-file
 * Upload invoice PDF or image.
 */
invoicesRouter.post('/upload-file', (req: AuthedRequest, res) => {
  uploadInvoiceAttachment.single('file')(req as any, res as any, (err: any) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Invoice upload failed' });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No invoice file uploaded' });
    }

    res.json({
      file_id: uuid(),
      original_filename: file.originalname,
      file_path: file.filename,
      file_size: file.size,
      mime_type: file.mimetype,
      uploaded_at: new Date().toISOString(),
    });
  });
});

/**
 * POST /api/invoices/:nfaId
 * Submit a new invoice under an approved Purchase NFA.
 */
invoicesRouter.post('/:nfaId', async (req: AuthedRequest, res) => {
  const user = req.user!;
  const nfaId = req.params.nfaId;

  const nfa = store.data.nfas.find((n) => n.id === nfaId && !n.is_deleted);
  if (!nfa) {
    return res.status(404).json({ error: 'Purchase NFA record not found' });
  }

  // 1. Eligibility Checks
  const isPurchase = nfa.nfa_type === 'purchase' || Boolean(nfa.purchase_details);
  if (!isPurchase) {
    return res.status(400).json({
      error: 'Invoice monitoring is only available for Purchase NFAs. Event NFAs are ineligible.',
    });
  }

  if (nfa.status !== 'approved') {
    return res.status(400).json({
      error: `Invoices can only be uploaded for finally approved Purchase NFAs. Current status: ${nfa.status}`,
    });
  }

  // 2. Permission Check
  if (user.role === 'faculty' && nfa.created_by !== user.id) {
    return res.status(403).json({
      error: 'You are only authorized to upload invoices for your own approved Purchase NFAs.',
    });
  }

  // 3. Payload Validation
  const {
    invoice_number,
    invoice_date,
    vendor_name,
    invoice_amount,
    gst_amount,
    file_path,
    original_filename,
    file_id,
    file_size,
    mime_type,
    remarks,
  } = req.body;

  if (!invoice_number || typeof invoice_number !== 'string' || !invoice_number.trim()) {
    return res.status(400).json({ error: 'Invoice number is required.' });
  }
  if (!invoice_date || typeof invoice_date !== 'string') {
    return res.status(400).json({ error: 'Invoice date is required.' });
  }
  if (!vendor_name || typeof vendor_name !== 'string' || !vendor_name.trim()) {
    return res.status(400).json({ error: 'Vendor name is required.' });
  }

  const parsedAmount = Number(invoice_amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Valid positive invoice amount is required.' });
  }

  if (!file_path || typeof file_path !== 'string') {
    return res.status(400).json({ error: 'Invoice document upload is mandatory.' });
  }

  const cleanInvNo = invoice_number.trim();
  const cleanVendor = vendor_name.trim();

  // 4. Duplicate Invoice Check
  const existingInvoices = (store.data.purchase_invoices || []).filter(
    (inv) => inv.nfa_id === nfa.id
  );

  const isDuplicate = existingInvoices.some(
    (inv) =>
      inv.invoice_number.trim().toLowerCase() === cleanInvNo.toLowerCase() &&
      inv.vendor_name.trim().toLowerCase() === cleanVendor.toLowerCase()
  );

  if (isDuplicate) {
    return res.status(400).json({
      error: `An invoice with number "${cleanInvNo}" for vendor "${cleanVendor}" already exists for this NFA.`,
    });
  }

  // 5. Approved Ceiling Safeguard
  const currentTotalInvoiced = existingInvoices.reduce(
    (sum, inv) => sum + (Number(inv.invoice_amount) || 0),
    0
  );
  const approvedCeiling = Number(nfa.total_amount) || 0;

  if (currentTotalInvoiced + parsedAmount > approvedCeiling + 0.01) {
    const remaining = Math.max(0, approvedCeiling - currentTotalInvoiced);
    return res.status(400).json({
      error: `Invoice amount (₹${parsedAmount.toLocaleString(
        'en-IN'
      )}) exceeds the remaining approved NFA balance of ₹${remaining.toLocaleString(
        'en-IN'
      )}. Approved NFA ceiling: ₹${approvedCeiling.toLocaleString('en-IN')}.`,
    });
  }

  // 6. Create Invoice Record
  const newInvoice: PurchaseInvoice = {
    id: uuid(),
    nfa_id: nfa.id,
    invoice_number: cleanInvNo,
    invoice_date: invoice_date,
    vendor_name: cleanVendor,
    invoice_amount: parsedAmount,
    gst_amount: Number(gst_amount) || 0,
    file_id: file_id || uuid(),
    original_filename: original_filename || path.basename(file_path),
    file_path: file_path,
    file_size: file_size,
    mime_type: mime_type || 'application/pdf',
    uploaded_by: user.id,
    uploaded_by_name: user.name,
    uploaded_at: new Date().toISOString(),
    verification_status: 'pending_verification',
    payment_status: 'unpaid',
    paid_amount: 0,
    payment_remarks: remarks || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await store.transact((db) => {
    db.purchase_invoices = db.purchase_invoices || [];
    db.purchase_invoices.push(newInvoice);

    // Audit trail (does NOT deduct department budget)
    db.audit_logs.push({
      id: uuid(),
      entity_type: 'purchase_invoice',
      entity_id: newInvoice.id,
      department_id: nfa.department_id,
      old_amount: null,
      new_amount: parsedAmount,
      difference: null,
      changed_by: user.id,
      role: user.role,
      reason: `Invoice ${cleanInvNo} (₹${parsedAmount.toLocaleString('en-IN')}) uploaded for approved NFA ${nfa.ref_no}`,
      source: 'portal',
      approval_status: 'submitted',
      created_at: new Date().toISOString(),
    });
  });

  res.status(201).json(newInvoice);
});

/**
 * PUT /api/invoices/:id
 * Correct a returned invoice (Faculty owner).
 */
invoicesRouter.put('/:id', async (req: AuthedRequest, res) => {
  const user = req.user!;
  const invoiceId = req.params.id;

  const invoice = (store.data.purchase_invoices || []).find((i) => i.id === invoiceId);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice record not found' });
  }

  const nfa = store.data.nfas.find((n) => n.id === invoice.nfa_id);
  if (!nfa) {
    return res.status(404).json({ error: 'Associated NFA not found' });
  }

  if (user.role === 'faculty' && invoice.uploaded_by !== user.id) {
    return res.status(403).json({ error: 'You may only edit invoices submitted by you.' });
  }

  if (invoice.verification_status !== 'returned' && user.role === 'faculty') {
    return res.status(400).json({
      error: 'Only invoices returned by Finance for correction can be modified.',
    });
  }

  const {
    invoice_number,
    invoice_date,
    vendor_name,
    invoice_amount,
    gst_amount,
    file_path,
    original_filename,
    remarks,
  } = req.body;

  const parsedAmount = invoice_amount !== undefined ? Number(invoice_amount) : invoice.invoice_amount;
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Valid positive invoice amount required.' });
  }

  // Ceiling check excluding this invoice
  const otherInvoices = (store.data.purchase_invoices || []).filter(
    (i) => i.nfa_id === nfa.id && i.id !== invoice.id
  );
  const otherTotal = otherInvoices.reduce((s, i) => s + (Number(i.invoice_amount) || 0), 0);
  if (otherTotal + parsedAmount > nfa.total_amount + 0.01) {
    return res.status(400).json({
      error: `Updated amount exceeds the remaining approved balance on NFA ${nfa.ref_no}.`,
    });
  }

  await store.transact((db) => {
    const inv = (db.purchase_invoices || []).find((i) => i.id === invoiceId);
    if (!inv) return;

    if (invoice_number) inv.invoice_number = String(invoice_number).trim();
    if (invoice_date) inv.invoice_date = invoice_date;
    if (vendor_name) inv.vendor_name = String(vendor_name).trim();
    inv.invoice_amount = parsedAmount;
    if (gst_amount !== undefined) inv.gst_amount = Number(gst_amount) || 0;
    if (file_path) inv.file_path = file_path;
    if (original_filename) inv.original_filename = original_filename;
    if (remarks) inv.payment_remarks = remarks;

    // Resubmitted invoice goes back to pending verification
    inv.verification_status = 'pending_verification';
    inv.return_reason = undefined;
    inv.updated_at = new Date().toISOString();

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'purchase_invoice',
      entity_id: inv.id,
      department_id: nfa.department_id,
      old_amount: null,
      new_amount: parsedAmount,
      difference: null,
      changed_by: user.id,
      role: user.role,
      reason: `Invoice ${inv.invoice_number} corrected and resubmitted for Finance verification.`,
      source: 'portal',
      approval_status: 'resubmitted',
      created_at: new Date().toISOString(),
    });
  });

  res.json({ message: 'Invoice updated and resubmitted successfully' });
});

/**
 * POST /api/invoices/:id/verify
 * Finance Office / Finance Head / Super Admin verifies or returns invoice.
 */
invoicesRouter.post('/:id/verify', async (req: AuthedRequest, res) => {
  const user = req.user!;
  const invoiceId = req.params.id;

  if (!['finance', 'finance_head', 'super_admin'].includes(user.role)) {
    return res.status(403).json({
      error: 'Only Finance Office, Finance Head, or Super Admin may verify invoices.',
    });
  }

  const { decision, remarks } = req.body;
  if (!['verified', 'returned'].includes(decision)) {
    return res.status(400).json({ error: 'Valid decision ("verified" or "returned") required.' });
  }

  if (decision === 'returned' && (!remarks || !remarks.trim())) {
    return res.status(400).json({ error: 'Reason for return is mandatory when returning an invoice.' });
  }

  const invoice = (store.data.purchase_invoices || []).find((i) => i.id === invoiceId);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found.' });
  }

  const nfa = store.data.nfas.find((n) => n.id === invoice.nfa_id);

  await store.transact((db) => {
    const inv = (db.purchase_invoices || []).find((i) => i.id === invoiceId);
    if (!inv) return;

    if (decision === 'verified') {
      inv.verification_status = 'verified';
      inv.verified_by = user.id;
      inv.verified_by_name = user.name;
      inv.verified_at = new Date().toISOString();
      inv.return_reason = undefined;
    } else {
      inv.verification_status = 'returned';
      inv.verified_by = user.id;
      inv.verified_by_name = user.name;
      inv.verified_at = new Date().toISOString();
      inv.return_reason = remarks.trim();
    }
    inv.updated_at = new Date().toISOString();

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'purchase_invoice',
      entity_id: inv.id,
      department_id: nfa?.department_id || '',
      old_amount: null,
      new_amount: inv.invoice_amount,
      difference: null,
      changed_by: user.id,
      role: user.role,
      reason:
        decision === 'verified'
          ? `Invoice ${inv.invoice_number} verified by ${user.name} (${user.role}). Ready for payment queue.`
          : `Invoice ${inv.invoice_number} returned for correction: "${remarks.trim()}"`,
      source: 'portal',
      approval_status: decision,
      created_at: new Date().toISOString(),
    });
  });

  res.json({ message: `Invoice successfully ${decision}.` });
});

/**
 * POST /api/invoices/:id/payment
 * Finance Office / Finance Head records payment details (UTR, paid amount, payment date).
 */
invoicesRouter.post('/:id/payment', async (req: AuthedRequest, res) => {
  const user = req.user!;
  const invoiceId = req.params.id;

  if (!['finance', 'finance_head', 'super_admin'].includes(user.role)) {
    return res.status(403).json({
      error: 'Only Finance Office, Finance Head, or Super Admin may record payments.',
    });
  }

  const { payment_status, paid_amount, payment_date, payment_ref_utr, payment_remarks } = req.body;

  if (!['unpaid', 'in_process', 'paid'].includes(payment_status)) {
    return res.status(400).json({ error: 'Valid payment status required.' });
  }

  const invoice = (store.data.purchase_invoices || []).find((i) => i.id === invoiceId);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found.' });
  }

  if (payment_status === 'paid' && invoice.verification_status !== 'verified') {
    return res.status(400).json({
      error: 'Invoice must be verified by Finance before being marked as Paid.',
    });
  }

  const nfa = store.data.nfas.find((n) => n.id === invoice.nfa_id);

  await store.transact((db) => {
    const inv = (db.purchase_invoices || []).find((i) => i.id === invoiceId);
    if (!inv) return;

    inv.payment_status = payment_status;
    if (paid_amount !== undefined) inv.paid_amount = Number(paid_amount) || inv.invoice_amount;
    else if (payment_status === 'paid') inv.paid_amount = inv.invoice_amount;

    if (payment_date) inv.payment_date = payment_date;
    else if (payment_status === 'paid') inv.payment_date = new Date().toISOString().split('T')[0];

    if (payment_ref_utr) inv.payment_ref_utr = String(payment_ref_utr).trim();
    if (payment_remarks) inv.payment_remarks = String(payment_remarks).trim();
    inv.updated_at = new Date().toISOString();

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'purchase_invoice',
      entity_id: inv.id,
      department_id: nfa?.department_id || '',
      old_amount: null,
      new_amount: inv.paid_amount || null,
      difference: null,
      changed_by: user.id,
      role: user.role,
      reason: `Invoice ${inv.invoice_number} payment status set to ${payment_status} (UTR: ${
        inv.payment_ref_utr || 'N/A'
      }) by ${user.name} (${user.role}).`,
      source: 'portal',
      approval_status: payment_status,
      created_at: new Date().toISOString(),
    });
  });

  res.json({ message: 'Payment status updated successfully.' });
});
