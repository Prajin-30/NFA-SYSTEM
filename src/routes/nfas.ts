import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { store } from '../store.js';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth.js';
import {
  findBudgetLine,
  validateBudget,
  applyNewApproval,
  reviseApprovedAmount,
  finalizePendingRevision,
  reserveNfaBudget,
  releaseNfaReservation,
  BudgetError,
} from '../lib/budgetEngine.js';
import { renderNfaPdf } from '../lib/pdf.js';
import { dispatchWorkflowNotification } from '../services/notifications.js';
import {
  encryptAccountNumber,
  decryptAccountNumber,
  validateIfsc,
} from '../lib/encryption.js';
import type { NfaStatus, Role, ResourcePersonBankDetail, ResourcePersonBankDetailDTO } from '../types.js';

// Server-side Idempotency Cache to prevent duplicate NFA creation
interface IdempotencyRecord {
  id: string;
  ref_no: string;
  payload: any;
  timestamp: number;
}
const idempotencyCache = new Map<string, IdempotencyRecord>();
const inFlightIdempotency = new Map<string, Promise<{ status: number; payload: any }>>();

function cleanIdempotencyCache() {
  const tenMinsAgo = Date.now() - 10 * 60 * 1000;
  for (const [key, val] of idempotencyCache.entries()) {
    if (val.timestamp < tenMinsAgo) {
      idempotencyCache.delete(key);
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const signaturesDir = path.join(__dirname, '..', '..', 'data', 'signatures');
const attachmentsDir = path.join(__dirname, '..', '..', 'data', 'nfa-attachments');

if (!fs.existsSync(attachmentsDir)) {
  fs.mkdirSync(attachmentsDir, { recursive: true });
}

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, attachmentsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${uuid()}${ext}`;
    cb(null, uniqueName);
  },
});

const allowedMimes = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];
const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png', '.xlsx', '.xls'];

const uploadAttachment = multer({
  storage: attachmentStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid document format. Allowed: PDF, JPG, JPEG, PNG, XLSX (Max 10MB).'));
    }
  },
});

function computeFileHash(filePath: string): string {
  try {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch {
    return '';
  }
}

export const nfasRouter = Router();
nfasRouter.use(requireAuth);

/** POST /api/nfas/upload-attachment — Upload quotation or comparative statement file */
nfasRouter.post('/upload-attachment', (req: AuthedRequest, res) => {
  uploadAttachment.single('file')(req as any, res as any, (err: any) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'File upload failed' });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fullPath = path.join(attachmentsDir, file.filename);
    const hash = computeFileHash(fullPath);

    res.json({
      file_id: uuid(),
      original_filename: file.originalname,
      file_path: file.filename,
      file_size: file.size,
      file_hash: hash,
      mime_type: file.mimetype,
      uploaded_at: new Date().toISOString(),
    });
  });
});

/** GET /api/nfas/attachment-preview/:filename — Preview uploaded file */
nfasRouter.get('/attachment-preview/:filename', (req: AuthedRequest, res) => {
  const safeBase = path.basename(req.params.filename);
  const fullPath = path.join(attachmentsDir, safeBase);

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'Attachment file not found' });
  }

  const ext = path.extname(safeBase).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const mime = mimeTypes[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${safeBase}"`);
  fs.createReadStream(fullPath).pipe(res);
});

/** GET /api/nfas/:id/attachments/:type/:index? — Secure download / stream for NFA attachments */
nfasRouter.get('/:id/attachments/:type/:index?', (req: AuthedRequest, res) => {
  const nfa = store.data.nfas.find((n) => n.id === req.params.id);
  if (!nfa) return res.status(404).json({ error: 'NFA not found' });

  // Role-based / ownership access verification
  const u = req.user!;
  // Strict Draft Privacy: Unsubmitted draft attachments are strictly private to creator (even super_admin)
  if (nfa.status === 'draft' && nfa.created_by !== u.id) {
    return res.status(403).json({ error: 'Forbidden: Draft attachments are private to the creator until submitted for approval' });
  }
  const isPrivileged = ['super_admin', 'dean', 'associate_dean', 'finance', 'director'].includes(u.role);
  const isCreator = nfa.created_by === u.id;
  const isSameDept = nfa.department_id === u.department_id;

  if (u.role === 'faculty' && !isCreator) {
    return res.status(403).json({ error: 'You are only authorized to access attachments of your own NFAs' });
  }
  if ((u.role === 'hod' || u.role === 'it_admin') && !isSameDept) {
    return res.status(403).json({ error: 'You are only authorized to access attachments from your own department' });
  }
  if (!isPrivileged && !isCreator && !isSameDept) {
    return res.status(403).json({ error: 'Not authorized to access this attachment' });
  }

  const { type, index } = req.params;
  let targetAttachment: { file_path: string; original_filename: string; mime_type?: string } | undefined;

  if (type === 'quotation') {
    const idx = parseInt(index || '0', 10);
    const quotes = nfa.quotations || [];
    targetAttachment = quotes[idx];
  } else if (type === 'comparative-statement' || type === 'comparative_statement') {
    targetAttachment = nfa.comparative_statement;
  }

  if (!targetAttachment || !targetAttachment.file_path) {
    return res.status(404).json({ error: 'Attachment record not found' });
  }

  const safeBase = path.basename(targetAttachment.file_path);
  const fullPath = path.join(attachmentsDir, safeBase);

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'Attachment file not found on disk' });
  }

  const ext = path.extname(safeBase).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const mime = targetAttachment.mime_type || mimeTypes[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(targetAttachment.original_filename || safeBase)}"`);
  fs.createReadStream(fullPath).pipe(res);
});

/** GET /api/nfas/:id/bank-details — Fetch masked bank details for Event NFA */
nfasRouter.get('/:id/bank-details', async (req: AuthedRequest, res) => {
  const nfa = store.data.nfas.find((n) => n.id === req.params.id && !n.is_deleted);
  if (!nfa) return res.status(404).json({ error: 'NFA not found' });

  const isCreator = req.user!.id === nfa.created_by;
  const isFinanceOrAdmin = ['finance', 'finance_head', 'super_admin'].includes(req.user!.role);

  // Strict RBAC: Creator gets masked details; Finance & Super Admin get reveal authorization; all others forbidden
  if (!isCreator && !isFinanceOrAdmin) {
    return res.status(403).json({ error: 'Forbidden: Access to confidential bank details is strictly restricted to Finance and Super Admin.' });
  }

  const details = (store.data.resource_person_bank_details || []).filter((d) => d.nfa_id === nfa.id);
  const responseData: ResourcePersonBankDetailDTO[] = details.map((d) => ({
    id: d.id,
    nfa_id: d.nfa_id,
    resource_person_name: d.resource_person_name,
    designation: d.designation,
    organization: d.organization,
    email: d.email,
    mobile: d.mobile,
    honorarium_amount: d.honorarium_amount,
    account_holder_name: d.account_holder_name,
    bank_name: d.bank_name,
    masked_account_number: d.masked_account_number,
    ifsc_code: d.ifsc_code,
    branch_name: d.branch_name,
    remarks: d.remarks,
    tracking_status: d.tracking_status || 'details_submitted',
    approved_honorarium: d.approved_honorarium,
    deductions: d.deductions,
    net_payable_amount: d.net_payable_amount,
    payment_date: d.payment_date,
    payment_ref_utr: d.payment_ref_utr,
    payment_remarks: d.payment_remarks,
    created_at: d.created_at,
    can_reveal: isFinanceOrAdmin,
  }));

  res.json(responseData);
});

/** POST /api/nfas/:id/bank-details/:bankDetailId/payment-tracking — Update payment tracking for Resource Person (Finance only) */
nfasRouter.post('/:id/bank-details/:bankDetailId/payment-tracking', async (req: AuthedRequest, res) => {
  const nfa = store.data.nfas.find((n) => n.id === req.params.id && !n.is_deleted);
  if (!nfa) return res.status(404).json({ error: 'NFA not found' });

  const isFinanceOrAdmin = ['finance', 'finance_head', 'super_admin'].includes(req.user!.role);
  if (!isFinanceOrAdmin) {
    return res.status(403).json({
      error: 'Forbidden: Only Finance Office, Finance Officer (Head), and Super Admin may update payment tracking.',
    });
  }

  const detail = (store.data.resource_person_bank_details || []).find(
    (d) => d.id === req.params.bankDetailId && d.nfa_id === nfa.id
  );
  if (!detail) return res.status(404).json({ error: 'Bank details not found for this NFA' });

  const {
    tracking_status,
    approved_honorarium,
    deductions,
    net_payable_amount,
    payment_date,
    payment_ref_utr,
    payment_remarks,
  } = req.body;

  const validStatuses = [
    'details_pending',
    'details_submitted',
    'finance_verification',
    'ready_for_payment',
    'payment_processing',
    'paid',
    'returned_for_correction',
    'payment_failed',
  ];

  if (tracking_status && !validStatuses.includes(tracking_status)) {
    return res.status(400).json({ error: 'Invalid tracking status value.' });
  }

  await store.transact((db) => {
    const d = (db.resource_person_bank_details || []).find((x) => x.id === detail.id);
    if (!d) return;

    if (tracking_status) d.tracking_status = tracking_status;
    if (approved_honorarium !== undefined) d.approved_honorarium = Number(approved_honorarium) || 0;
    if (deductions !== undefined) d.deductions = Number(deductions) || 0;
    if (net_payable_amount !== undefined) d.net_payable_amount = Number(net_payable_amount) || 0;
    else if (d.approved_honorarium !== undefined) {
      d.net_payable_amount = Math.max(0, (d.approved_honorarium || 0) - (d.deductions || 0));
    }
    if (payment_date !== undefined) d.payment_date = payment_date;
    if (payment_ref_utr !== undefined) d.payment_ref_utr = String(payment_ref_utr).trim();
    if (payment_remarks !== undefined) d.payment_remarks = String(payment_remarks).trim();
    d.updated_at = new Date().toISOString();

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'bank_detail',
      entity_id: d.id,
      department_id: nfa.department_id,
      old_amount: null,
      new_amount: d.net_payable_amount || null,
      difference: null,
      changed_by: req.user!.id,
      role: req.user!.role,
      reason: `Honorarium payment tracking updated for "${d.resource_person_name}" to "${d.tracking_status}" (Net: ₹${d.net_payable_amount || 0}, UTR: ${d.payment_ref_utr || 'N/A'}) by ${req.user!.name} (${req.user!.role}).`,
      source: 'portal',
      approval_status: d.tracking_status || 'updated',
      created_at: new Date().toISOString(),
    });
  });

  res.json({ message: 'Honorarium payment tracking updated successfully.' });
});

/** POST /api/nfas/:id/bank-details/:bankDetailId/reveal — Decrypt and view plaintext account number with audit log */
nfasRouter.post('/:id/bank-details/:bankDetailId/reveal', async (req: AuthedRequest, res) => {
  const nfa = store.data.nfas.find((n) => n.id === req.params.id && !n.is_deleted);
  if (!nfa) return res.status(404).json({ error: 'NFA not found' });

  const isFinanceOrAdmin = ['finance', 'finance_head', 'super_admin'].includes(req.user!.role);
  if (!isFinanceOrAdmin) {
    return res.status(403).json({
      error: 'Forbidden: Only Finance Office, Finance Officer (Head), and Super Admin are authorized to decrypt confidential bank details.',
    });
  }

  const detail = (store.data.resource_person_bank_details || []).find(
    (d) => d.id === req.params.bankDetailId && d.nfa_id === nfa.id
  );
  if (!detail) return res.status(404).json({ error: 'Bank details not found for this NFA' });

  // Security Audit Logging: Log access action WITHOUT storing plaintext account number
  await store.transact((db) => {
    db.audit_logs.push({
      id: uuid(),
      entity_type: 'bank_detail',
      entity_id: detail.id,
      department_id: nfa.department_id,
      old_amount: null,
      new_amount: null,
      difference: null,
      changed_by: req.user!.id,
      role: req.user!.role,
      reason: `Confidential bank details revealed for Resource Person "${detail.resource_person_name}" on NFA ${nfa.ref_no} by ${req.user!.name} (${req.user!.role}).`,
      source: 'portal',
      approval_status: 'revealed',
      created_at: new Date().toISOString(),
    });
  });

  try {
    const plainAccountNumber = decryptAccountNumber(detail.encrypted_account_number, detail.iv, detail.auth_tag);
    res.json({
      id: detail.id,
      resource_person_name: detail.resource_person_name,
      account_holder_name: detail.account_holder_name,
      bank_name: detail.bank_name,
      account_number: plainAccountNumber,
      ifsc_code: detail.ifsc_code,
      branch_name: detail.branch_name,
      remarks: detail.remarks,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to decrypt bank account number: ' + err.message });
  }
});

function withItems(nfaId: string) {
  return store.data.nfa_items.filter((i) => i.nfa_id === nfaId).sort((a, b) => a.sl_no - b.sl_no);
}

function withApprovals(nfaId: string) {
  return store.data.approvals
    .filter((a) => a.nfa_id === nfaId)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((a) => {
      const u = store.data.users.find((user) => user.id === a.approver_id);
      return {
        ...a,
        approver_name: a.approver_name || u?.name || a.approver_role,
      };
    });
}

export function isCseOrAdseDepartment(deptId?: string | null): boolean {
  if (!deptId) return false;
  const dept = store.data.departments.find((d) => d.id === deptId);
  if (!dept) return false;
  const code = (dept.code || '').trim().toUpperCase();
  const name = (dept.name || '').trim().toLowerCase();
  if (code === 'CSE' || code === 'ADSE') return true;
  if (deptId === 'b5643609-22d9-4b21-9ce0-2f6eb5b9d04e' || deptId === '330ada81-5246-4c92-9ca2-688eae0f28d4') return true;
  if (name.includes('computer science') || name.includes('data science') || name.includes('artificial intelligence')) {
    return true;
  }
  return false;
}

function countWords(str: string): number {
  if (!str) return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
}

/** GET /api/nfas/inbox — NFAs requiring immediate action from logged in user */
nfasRouter.get('/inbox', (req: AuthedRequest, res) => {
  const { role, id, department_id } = req.user!;
  let list = store.data.nfas.filter((n) => !n.is_deleted);

  if (role === 'faculty') {
    list = list.filter((n) => n.created_by === id && (n.status === 'draft' || n.status === 'revision_required'));
  } else if (role === 'hod') {
    // HOD only reviews department NFAs that are pending HOD review (skips Centre/Office NFAs)
    list = list.filter(
      (n) =>
        n.department_id === department_id &&
        n.organization_type !== 'centre_or_office' &&
        (n.status === 'pending_hod_review' || n.status === 'submitted' || n.status === 'under_review')
    );
  } else if (role === 'deans_office') {
    list = list.filter((n) => n.status === 'pending_deans_office_verification');
  } else if (role === 'associate_dean') {
    list = list.filter((n) => n.status === 'pending_associate_dean_approval');
  } else if (role === 'dean') {
    list = list.filter((n) => n.status === 'pending_dean_approval' || n.status === 'dean_review');
  } else if (role === 'finance') {
    list = list.filter(
      (n) => n.status === 'pending_finance_office_approval' || n.status === 'accounts_review' || n.status === 'budget_validation'
    );
  } else if (role === 'director') {
    list = list.filter((n) => n.status === 'pending_director_approval' || n.status === 'pending_higher_approval');
  } else if (role === 'finance_head') {
    list = list.filter((n) => n.status === 'pending_finance_head_approval');
  } else if (role === 'super_admin') {
    list = list.filter((n) =>
      [
        'submitted',
        'pending_hod_review',
        'pending_deans_office_verification',
        'pending_associate_dean_approval',
        'dean_review',
        'pending_dean_approval',
        'accounts_review',
        'pending_finance_office_approval',
        'pending_director_approval',
        'pending_finance_head_approval',
        'pending_higher_approval',
      ].includes(n.status)
    );
  } else {
    list = [];
  }
  res.json(list.map((n) => ({ ...n, items: withItems(n.id), approvals: withApprovals(n.id) })));
});

/** GET /api/nfas — role-scoped list with strict draft privacy */
nfasRouter.get('/', (req: AuthedRequest, res) => {
  let list = store.data.nfas.filter((n) => !n.is_deleted);
  const { role, id, department_id } = req.user!;
  if (role === 'faculty') {
    list = list.filter((n) => n.created_by === id);
  } else if (role === 'hod' || role === 'it_admin') {
    list = list.filter((n) => n.department_id === department_id);
  }
  // deans_office, dean, associate_dean, director, finance, finance_head, super_admin see all departments

  // Strict Draft Privacy: Unsubmitted draft NFAs are strictly private to their creator.
  // Super Admin, HOD, Dean, Finance, Director, and other users must NOT see another user's draft.
  // There is NO exception for Super Admin (all_drafts=true removed).
  list = list.filter((n) => {
    if (n.status === 'draft') {
      return n.created_by === id;
    }
    return true;
  });

  if (req.query.status) list = list.filter((n) => n.status === req.query.status);
  if (req.query.department) list = list.filter((n) => n.department_id === req.query.department);
  const seen = new Set<string>();
  const uniqueList = list.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
  res.json(uniqueList.map((n) => ({ ...n, items: withItems(n.id), approvals: withApprovals(n.id) })));
});

function generateUniqueNfaRefNo(db: any, departmentId: string, financialYearId: string): string {
  const dept = db.departments.find((d: any) => d.id === departmentId);
  const fy = db.financial_years.find((f: any) => f.id === financialYearId);
  const deptCode = dept ? dept.code : 'GEN';
  const fyLabel = fy ? fy.label : String(new Date().getFullYear());
  const prefix = `NFA/${deptCode}/${fyLabel}/`;

  let maxSeq = 0;
  for (const n of db.nfas) {
    if (n.ref_no && n.ref_no.startsWith(prefix)) {
      const suffix = n.ref_no.slice(prefix.length);
      const num = parseInt(suffix, 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }

  const deptCount = db.nfas.filter((n: any) => n.department_id === departmentId).length;
  let nextSeq = Math.max(maxSeq + 1, deptCount + 1);
  let candidate = `${prefix}${String(nextSeq).padStart(4, '0')}`;
  while (db.nfas.some((n: any) => n.ref_no && n.ref_no.toLowerCase() === candidate.toLowerCase())) {
    nextSeq++;
    candidate = `${prefix}${String(nextSeq).padStart(4, '0')}`;
  }
  return candidate;
}

/** GET /api/nfas/next-ref — generate auto reference number */
nfasRouter.get('/next-ref', (req: AuthedRequest, res) => {
  const deptId = String(req.query.department_id || req.user?.department_id || '');
  const fyId = String(req.query.financial_year_id || store.data.financial_years.find((f) => f.is_active)?.id || '');
  const refNo = generateUniqueNfaRefNo(store.data, deptId, fyId);
  res.json({ ref_no: refNo });
});

/** GET /api/nfas/:id */
nfasRouter.get('/:id', (req: AuthedRequest, res) => {
  const nfa = store.data.nfas.find((n) => n.id === req.params.id);
  if (!nfa) return res.status(404).json({ error: 'NFA not found' });
  if (req.user) {
    const { role, id, department_id } = req.user;
    // Strict Draft Privacy: An unsubmitted Draft NFA is strictly private to its creator (even super_admin)
    if (nfa.status === 'draft' && nfa.created_by !== id) {
      return res.status(403).json({ error: 'Forbidden: Draft NFAs are private to their creator until submitted for approval' });
    }
    if (role === 'faculty' && nfa.created_by !== id) {
      return res.status(403).json({ error: 'You are only authorized to view your own NFAs' });
    }
    if ((role === 'hod' || role === 'it_admin') && nfa.department_id !== department_id) {
      return res.status(403).json({ error: 'You can only view NFAs from your own department' });
    }
  }
  res.json({ ...nfa, items: withItems(nfa.id), approvals: withApprovals(nfa.id) });
});

/** GET /api/nfas/:id/pdf */
nfasRouter.get('/:id/pdf', (req: AuthedRequest, res) => {
  const nfa = store.data.nfas.find((n) => n.id === req.params.id);
  if (!nfa) return res.status(404).json({ error: 'NFA not found' });
  if (req.user) {
    const { role, id, department_id } = req.user;
    // Strict Draft Privacy: Unsubmitted draft NFAs cannot be downloaded by non-creators (even super_admin)
    if (nfa.status === 'draft' && nfa.created_by !== id) {
      return res.status(403).json({ error: 'Forbidden: Draft NFAs are private to their creator until submitted for approval' });
    }
    if (role === 'faculty' && nfa.created_by !== id) {
      return res.status(403).json({ error: 'You are only authorized to download your own NFAs' });
    }
    if ((role === 'hod' || role === 'it_admin') && nfa.department_id !== department_id) {
      return res.status(403).json({ error: 'You can only download NFAs from your own department' });
    }
  }
  const dept = store.data.departments.find((d) => d.id === nfa.department_id) || {
    id: nfa.department_id,
    name: (nfa as any).custom_department_name || 'Department',
    code: (nfa as any).custom_department_code || 'DEPT',
    hod_name: nfa.hod_name || '',
  };
  const cat = store.data.budget_categories.find((c) => c.id === nfa.budget_category_id) || {
    id: nfa.budget_category_id,
    name: 'General Budget',
    budget_type_id: '',
  };
  const project = store.data.projects.find((p) => p.id === nfa.project_id);
  const creator = store.data.users.find((u) => u.id === nfa.created_by);
  const fy = store.data.financial_years.find((f) => f.id === nfa.financial_year_id);
  const budgetType = store.data.budget_types.find((b) => b.id === (nfa.budget_type_id || cat.budget_type_id));
  const subcat = store.data.budget_subcategories?.find((s) => s.id === nfa.budget_subcategory_id);
  const budgetLine = store.data.department_budgets.find(
    (b) => b.department_id === nfa.department_id && b.financial_year_id === nfa.financial_year_id && b.budget_category_id === nfa.budget_category_id
  );

  // 1. Budget Nature Total
  const targetTypeId = nfa.budget_type_id || cat.budget_type_id || budgetType?.id;
  const catsInType = store.data.budget_categories
    .filter((c) => !targetTypeId || c.budget_type_id === targetTypeId)
    .map((c) => c.id);

  let totalBudgetNature = store.data.department_budgets
    .filter((b) => b.department_id === nfa.department_id && b.financial_year_id === nfa.financial_year_id && catsInType.includes(b.budget_category_id))
    .reduce((sum, b) => sum + (b.allocated_amount || 0), 0);

  if (!totalBudgetNature || totalBudgetNature === 0) {
    totalBudgetNature = store.data.department_budgets
      .filter((b) => b.financial_year_id === nfa.financial_year_id && catsInType.includes(b.budget_category_id))
      .reduce((sum, b) => sum + (b.allocated_amount || 0), 0);
  }
  if (!totalBudgetNature || totalBudgetNature === 0) {
    totalBudgetNature = (budgetType?.name || '').includes('CAPEX') ? 5000000 : 31138700;
  }

  // 2. Main Budget Category Total
  const totalAllocationCategory = budgetLine?.allocated_amount || (subcat?.allocated_amount ? subcat.allocated_amount * 2 : 13978700);

  // 3. Subcategory Total
  const totalAllocationSubcategory = subcat?.allocated_amount || (budgetLine?.allocated_amount ? Math.round(budgetLine.allocated_amount * 0.1) : 117700);

  // 4. Available Subcategory Budget (strictly preserving deficits, no zero-clamping)
  let currentAvailable = 0;
  if (subcat && subcat.allocated_amount !== undefined) {
    currentAvailable = subcat.allocated_amount - subcat.approved_amount - subcat.pending_amount;
  } else if (budgetLine && budgetLine.allocated_amount !== undefined) {
    currentAvailable = budgetLine.allocated_amount - budgetLine.approved_amount - budgetLine.pending_amount;
  } else {
    currentAvailable = totalAllocationSubcategory;
  }

  // Determine if NFA total_amount was already deducted in pending or approved
  const isAlreadyDeducted = ['pending_director_approval', 'pending_finance_head_approval', 'pending_higher_approval', 'approved'].includes(nfa.status);
  let availableBudget = 0;
  let balanceAfter = 0;

  if (isAlreadyDeducted) {
    balanceAfter = currentAvailable;
    availableBudget = balanceAfter + nfa.total_amount;
  } else {
    availableBudget = currentAvailable;
    balanceAfter = availableBudget - nfa.total_amount;
  }

  const budgetDetails = {
    classification: budgetType?.name || (cat.name.includes('CAPEX') ? 'Capital Expenditure' : 'Revenue Expenditure'),
    categoryName: cat.name || 'General Category',
    subcategoryName: nfa.budget_subcategory_name || subcat?.name || 'General Allocation',
    totalBudgetNature,
    totalAllocationCategory,
    totalAllocationSubcategory,
    availableBudget,
    amountRequested: nfa.total_amount,
    balanceAfter,
  };

  // Signatures retrieval
  const creatorUser = store.data.users.find((u) => u.id === nfa.created_by);
  const proposerSig = nfa.proposer_signature || creatorUser?.signature_image || (fs.existsSync(path.join(signaturesDir, `${nfa.created_by}.png`)) ? `${nfa.created_by}.png` : undefined);

  const enrichedApprovals = withApprovals(nfa.id).map((a) => {
    if (a.signature_image) return a;
    const approverUser = store.data.users.find((u) => u.id === a.approver_id);
    const sig = approverUser?.signature_image || (fs.existsSync(path.join(signaturesDir, `${a.approver_id}.png`)) ? `${a.approver_id}.png` : undefined);
    return { ...a, signature_image: sig };
  });

  renderNfaPdf(
    res,
    {
      ...nfa,
      submitted_by_name: creator?.name || nfa.submitted_by_name,
      hod_name: dept.hod_name || nfa.hod_name,
      budget_subcategory_name: nfa.budget_subcategory_name || subcat?.name,
      proposer_signature: proposerSig,
    },
    withItems(nfa.id),
    dept,
    cat,
    project?.name,
    enrichedApprovals,
    fy?.label,
    budgetType?.name,
    budgetDetails
  );
});

/** DELETE /api/nfas/:id — permanently remove a draft NFA when authorized. */
nfasRouter.delete('/:id', async (req: AuthedRequest, res) => {
  const attachmentsToDelete: string[] = [];
  let deletedNfaForNotify: any = null;

  const result = await store.transact((db) => {
    const nfa = db.nfas.find((item) => item.id === req.params.id && !item.is_deleted);
    if (!nfa) return { error: 404 as const, msg: 'NFA not found' };

    // Strict Deletion Permission:
    // Only the faculty creator can delete their Draft or Returned for Correction NFA.
    if (nfa.created_by !== req.user!.id) {
      return { error: 403 as const, msg: 'Forbidden: Only the creator may delete their NFA' };
    }

    // Only Drafts and Returned for Correction NFAs can be deleted
    if (!['draft', 'revision_required'].includes(nfa.status)) {
      return {
        error: 400 as const,
        msg: 'Forbidden: Only draft NFAs and Returned for Correction NFAs can be deleted. In-progress, approved, or rejected NFAs cannot be deleted.',
      };
    }

    // Release any pending reservation if present atomically
    if (nfa.status === 'revision_required') {
      try {
        releaseNfaReservation(db, nfa, {
          changed_by: req.user!.id,
          role: req.user!.role,
          reason: `NFA ${nfa.ref_no} soft-deleted by creator while in Returned for Correction status`,
        });
      } catch (err: any) {
        console.warn(`[WARN] Reservation release on delete skipped: ${err.message}`);
      }
    }

    // Soft delete: mark is_deleted = true and record deletion timestamp
    // Preserves NFA reference, audit history, and approval trail
    nfa.is_deleted = true;
    nfa.deleted_at = new Date().toISOString();
    nfa.updated_at = new Date().toISOString();

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'nfa',
      entity_id: nfa.id,
      department_id: nfa.department_id,
      old_amount: nfa.total_amount,
      new_amount: 0,
      difference: -nfa.total_amount,
      changed_by: req.user!.id,
      role: req.user!.role,
      reason: `NFA ${nfa.ref_no} soft-deleted by creator (${req.user!.name}).`,
      source: 'portal',
      approval_status: 'deleted',
      created_at: new Date().toISOString(),
    });

    deletedNfaForNotify = { ...nfa };
    return { deleted: true, id: nfa.id, soft_deleted: true };
  });

  if ('error' in result) {
    return res.status(result.error).json({ error: result.msg || (result.error === 404 ? 'NFA not found' : 'Not authorized to delete this NFA') });
  }

  // Dispatch mock email deletion confirmation to Faculty
  if (deletedNfaForNotify) {
    try {
      await dispatchWorkflowNotification(store.data, {
        nfa: deletedNfaForNotify,
        actor: req.user!,
        event: 'nfa_deleted',
        comments: 'NFA proposal was safely deleted by creator.',
      });
    } catch (e: any) {
      console.warn(`[WARN] Failed to dispatch deletion mock notification: ${e.message}`);
    }
  }

  res.json(result);
});

/**
 * POST /api/nfas — Faculty, HOD, and administrators can create an NFA.
 * Note: project_id is completely OPTIONAL.
 * Department can be chosen or custom entered.
 * Ref No is automatically generated if not provided.
 */
nfasRouter.post('/', requireRole('faculty', 'hod', 'dean', 'super_admin'), async (req: AuthedRequest, res) => {
  const b = req.body || {};
  
  // Idempotency check: if client sent an idempotency key and we already processed it, return cached response
  const idempotencyKey = (req.headers['idempotency-key'] as string || b.idempotency_key || '').trim();
  if (idempotencyKey) {
    if (idempotencyCache.has(idempotencyKey)) {
      const cached = idempotencyCache.get(idempotencyKey)!;
      console.log(`[IDEMPOTENCY] Returning cached NFA ${cached.ref_no} (${cached.id}) for key ${idempotencyKey}`);
      return res.status(200).json(cached.payload);
    }
    if (inFlightIdempotency.has(idempotencyKey)) {
      console.log(`[IDEMPOTENCY] Awaiting in-flight submission for key ${idempotencyKey}`);
      const inFlight = await inFlightIdempotency.get(idempotencyKey)!;
      return res.status(200).json(inFlight.payload);
    }
  }

  let resolveInFlight: ((val: { status: number; payload: any }) => void) | undefined;
  let rejectInFlight: ((err: any) => void) | undefined;
  if (idempotencyKey) {
    const p = new Promise<{ status: number; payload: any }>((resolve, reject) => {
      resolveInFlight = resolve;
      rejectInFlight = reject;
    });
    inFlightIdempotency.set(idempotencyKey, p);
  }
  
  // Organization Type: 'department' (Option A) vs 'centre_or_office' (Option B)
  const orgType: 'department' | 'centre_or_office' = b.organization_type === 'centre_or_office' ? 'centre_or_office' : 'department';
  let targetDepartmentId = b.department_id;
  let targetCentreId: string | null = null;

  if (orgType === 'department') {
    // Option A: Faculty belongs to an assigned department. Automatically identify & enforce.
    if (['faculty', 'hod'].includes(req.user!.role)) {
      if (!req.user!.department_id) {
        return res.status(400).json({ error: 'No valid department assignment exists for your profile. Please contact Super Admin.' });
      }
      targetDepartmentId = req.user!.department_id;
    } else {
      // Super admin / Dean
      if (!targetDepartmentId) {
        targetDepartmentId = req.user?.department_id || store.data.departments[0]?.id;
      }
    }

    const deptObj = store.data.departments.find((d) => d.id === targetDepartmentId);
    if (!deptObj) {
      return res.status(400).json({ error: 'Assigned department does not exist' });
    }
    targetCentreId = null;
  } else {
    // Option B: Centres or Offices
    targetDepartmentId = b.centre_id || b.department_id;
    if (!targetDepartmentId) {
      return res.status(400).json({ error: 'Please select an authorized Centre or Office' });
    }
    const centreObj = store.data.departments.find((d) => d.id === targetDepartmentId);
    if (!centreObj) {
      return res.status(400).json({ error: 'Selected Centre or Office does not exist' });
    }
    if (centreObj.category !== 'coe' && !centreObj.code.startsWith('COE-')) {
      return res.status(400).json({ error: `'${centreObj.name}' is an Academic Department, not a Centre or Office` });
    }

    // Backend validation: non-super_admin faculty can only select units they are authorized to access
    if (req.user!.role !== 'super_admin') {
      const authorizedCentres = req.user!.authorized_centre_ids || [];
      if (!authorizedCentres.includes(targetDepartmentId)) {
        return res.status(403).json({ error: 'Forbidden: You are not authorized to create an NFA for this Centre or Office' });
      }
    }
    targetCentreId = targetDepartmentId;
  }

  // Handle custom department if applicant specified (super_admin only)
  if ((b.department_id === '__custom__' || !targetDepartmentId) && b.custom_department_name) {
    const trimmed = b.custom_department_name.trim();
    let existing = store.data.departments.find((d) => d.name.toLowerCase() === trimmed.toLowerCase());
    if (!existing) {
      const code = (b.custom_department_code || trimmed.slice(0, 4)).toUpperCase().replace(/[^A-Z0-9]/g, '');
      existing = {
        id: uuid(),
        name: trimmed,
        code: code || 'DEPT',
        hod_name: b.hod_name || '',
      };
      store.data.departments.push(existing);

      // Seed baseline budget lines for this department for all active/available FYs
      const activeFy = store.data.financial_years.find((f) => f.is_active) || store.data.financial_years[0];
      store.data.budget_categories.forEach((cat) => {
        store.data.department_budgets.push({
          id: uuid(),
          department_id: existing!.id,
          financial_year_id: activeFy.id,
          budget_category_id: cat.id,
          allocated_amount: 1500000, // 15 Lakhs default base budget
          approved_amount: 0,
          pending_amount: 0,
          revised_amount: 0,
        });
      });
    }
    targetDepartmentId = existing.id;
  }

  const required = ['financial_year_id', 'budget_category_id', 'title'];
  for (const f of required) {
    if (!b[f]) return res.status(400).json({ error: `${f} is required` });
  }

  if (b.point1 && countWords(b.point1) > 50) {
    return res.status(400).json({ error: `Point 1 (Purpose) exceeds the 50-word limit (${countWords(b.point1)}/50)` });
  }
  if (b.point2 && countWords(b.point2) > 50) {
    return res.status(400).json({ error: `Point 2 (Logistics) exceeds the 50-word limit (${countWords(b.point2)}/50)` });
  }
  if (b.point3 && countWords(b.point3) > 50) {
    return res.status(400).json({ error: `Point 3 (Justification) exceeds the 50-word limit (${countWords(b.point3)}/50)` });
  }
  if (b.point4 && countWords(b.point4) > 50) {
    return res.status(400).json({ error: `Point 4 (Expenditure Statement) exceeds the 50-word limit (${countWords(b.point4)}/50)` });
  }

  const isPurchase = b.nfa_type === 'purchase';
  const targetNfaType: 'event' | 'purchase' = isPurchase ? 'purchase' : 'event';

  const items = Array.isArray(b.items) ? b.items : [];
  const processedItems = items.map((it: any, i: number) => {
    const qtyNum = Number(it.quantity);
    const rateNum = Number(it.rate);
    let computedAmount = Number(it.amount) || 0;
    if (!isNaN(qtyNum) && qtyNum > 0 && !isNaN(rateNum) && rateNum >= 0) {
      computedAmount = Math.round(qtyNum * rateNum * 100) / 100;
    }
    if (isNaN(computedAmount) || !isFinite(computedAmount) || computedAmount < 0) {
      computedAmount = 0;
    }
    const isPredefined = !isPurchase && Boolean(it.is_predefined);
    return {
      id: uuid(),
      sl_no: i + 1,
      particulars: String(it.particulars || '').trim(),
      quantity: it.quantity !== undefined && it.quantity !== null ? String(it.quantity).trim() : '',
      rate: it.rate !== undefined && it.rate !== null ? String(it.rate).trim() : '',
      amount: computedAmount,
      comments: it.comments || '',
      justification: it.justification || '',
      basis_of_budget: it.basis_of_budget || '',
      previous_year_budget: Number(it.previous_year_budget) || 0,
      previous_year_actual: Number(it.previous_year_actual) || 0,
      is_predefined: isPredefined,
      predefined_key: isPredefined ? (it.predefined_key || undefined) : undefined,
      distance_km: isPredefined ? (it.distance_km || undefined) : undefined,
      carry_back_arrangement: isPredefined ? (it.carry_back_arrangement || undefined) : undefined,
      sampling_required: isPredefined ? Boolean(it.sampling_required) : false,
      item_type: isPurchase ? 'purchase' : (isPredefined ? 'predefined' : 'custom'),
    };
  });
  const total = processedItems.reduce((s: number, it: any) => s + (Number(it.amount) || 0), 0);

  // Rapid submission debounce: detect identical submission within 15 seconds from the same user
  const fifteenSecsAgo = Date.now() - 15 * 1000;
  const recentDuplicate = store.data.nfas.find((n) => {
    if (n.is_deleted || n.created_by !== req.user!.id) return false;
    const createdTime = new Date(n.created_at).getTime();
    if (createdTime < fifteenSecsAgo) return false;
    return (
      String(n.title || '').trim().toLowerCase() === String(b.title || '').trim().toLowerCase() &&
      n.department_id === targetDepartmentId &&
      Math.abs(n.total_amount - total) < 0.01
    );
  });
  if (recentDuplicate) {
    console.log(`[RAPID SUBMISSION BLOCKED] Duplicate NFA creation prevented: ${recentDuplicate.ref_no} (${recentDuplicate.id})`);
    const existingPayload = {
      ...recentDuplicate,
      items: withItems(recentDuplicate.id),
      approvals: withApprovals(recentDuplicate.id)
    };
    if (idempotencyKey) {
      idempotencyCache.set(idempotencyKey, {
        id: recentDuplicate.id,
        ref_no: recentDuplicate.ref_no,
        payload: existingPayload,
        timestamp: Date.now()
      });
      resolveInFlight?.({ status: 200, payload: existingPayload });
      inFlightIdempotency.delete(idempotencyKey);
    }
    return res.status(200).json(existingPayload);
  }

  // Auto reference number calculation with enforced uniqueness
  let refNo = b.ref_no ? String(b.ref_no).trim() : '';
  const refExists = refNo && store.data.nfas.some((n) => n.ref_no.toLowerCase() === refNo.toLowerCase());
  if (!refNo || refExists) {
    refNo = generateUniqueNfaRefNo(store.data, targetDepartmentId, b.financial_year_id);
  }

  const creatorUser = store.data.users.find((u) => u.id === req.user!.id);
  const proposerSig = creatorUser?.signature_image || (fs.existsSync(path.join(signaturesDir, `${req.user!.id}.png`)) ? `${req.user!.id}.png` : undefined);

  // Check if updating an existing unsubmitted draft created by this user
  const existingDraftId = b.draft_id || b.id;
  const existingDraft = existingDraftId
    ? store.data.nfas.find((n) => n.id === existingDraftId && n.status === 'draft' && n.created_by === req.user!.id)
    : null;

  let nfa: any;
  let isNewNfa = false;

  if (existingDraft) {
    nfa = existingDraft;
    nfa.title = b.title;
    nfa.department_id = targetDepartmentId;
    nfa.centre_id = targetCentreId;
    nfa.organization_type = orgType;
    nfa.workflow_type = orgType;
    nfa.financial_year_id = b.financial_year_id;
    nfa.budget_type_id = b.budget_type_id || undefined;
    nfa.budget_category_id = b.budget_category_id;
    nfa.budget_subcategory_id = b.budget_subcategory_id || null;
    nfa.budget_subcategory_name = b.budget_subcategory_name || '';
    nfa.purpose = b.point1 || b.purpose || '';
    nfa.description = b.point2 || b.description || '';
    nfa.justification = b.point3 || b.justification || '';
    nfa.sdgs = b.sdgs || '';
    nfa.requirements = b.requirements || '';
    nfa.total_amount = total;
    nfa.submitted_by_name = b.submitted_by_name || req.user!.name;
    nfa.submitted_by_designation = b.submitted_by_designation || 'Faculty';
    nfa.updated_at = new Date().toISOString();
    nfa.nfa_type = targetNfaType;
    nfa.point1 = b.point1 || b.purpose || '';
    nfa.point2 = b.point2 || b.description || '';
    nfa.point3 = b.point3 || b.justification || '';
    nfa.point4 = b.point4 || '';
    nfa.event_details = isPurchase ? undefined : (b.event_details || {
      resource_person_name: b.event_resource_person_name || '',
      designation: b.event_designation || '',
      organization: b.event_organization || '',
      event_date: b.event_date || '',
      venue: b.event_venue || '',
      additional_info: b.event_additional_info || '',
    });
    nfa.purchase_details = isPurchase ? (b.purchase_details || {
      item_name: b.purchase_item_name || '',
      description: b.purchase_description || '',
      quantity: b.purchase_quantity || '',
      purpose: b.purchase_purpose || '',
      additional_info: b.purchase_additional_info || '',
    }) : undefined;
    nfa.quotations = isPurchase && Array.isArray(b.quotations) ? b.quotations : [];
    nfa.comparative_statement = isPurchase ? (b.comparative_statement || undefined) : undefined;
    nfa.proposer_signature = proposerSig || nfa.proposer_signature;
    nfa.will_generate_revenue = !isPurchase && Boolean(b.will_generate_revenue);
  } else {
    isNewNfa = true;
    nfa = {
      id: uuid(),
      ref_no: refNo,
      project_id: b.project_id || null, // Project is optional!
      department_id: targetDepartmentId,
      centre_id: targetCentreId,
      organization_type: orgType,
      workflow_type: orgType,
      financial_year_id: b.financial_year_id,
      budget_type_id: b.budget_type_id || undefined,
      budget_category_id: b.budget_category_id,
      budget_subcategory_id: b.budget_subcategory_id || null,
      budget_subcategory_name: b.budget_subcategory_name || '',
      title: b.title,
      purpose: b.point1 || b.purpose || '',
      description: b.point2 || b.description || '',
      justification: b.point3 || b.justification || '',
      sdgs: b.sdgs || '',
      requirements: b.requirements || '',
      total_amount: total,
      status: 'draft' as NfaStatus,
      created_by: req.user!.id,
      submitted_by_name: b.submitted_by_name || req.user!.name,
      submitted_by_designation: b.submitted_by_designation || 'Faculty',
      hod_name: '',
      date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Specific requirements
      nfa_type: targetNfaType,
      point1: b.point1 || b.purpose || '',
      point2: b.point2 || b.description || '',
      point3: b.point3 || b.justification || '',
      point4: b.point4 || '',
      event_details: isPurchase ? undefined : (b.event_details || {
        resource_person_name: b.event_resource_person_name || '',
        designation: b.event_designation || '',
        organization: b.event_organization || '',
        event_date: b.event_date || '',
        venue: b.event_venue || '',
        additional_info: b.event_additional_info || '',
      }),
      purchase_details: isPurchase ? (b.purchase_details || {
        item_name: b.purchase_item_name || '',
        description: b.purchase_description || '',
        quantity: b.purchase_quantity || '',
        purpose: b.purchase_purpose || '',
        additional_info: b.purchase_additional_info || '',
      }) : undefined,
      quotations: isPurchase && Array.isArray(b.quotations) ? b.quotations : [],
      comparative_statement: isPurchase ? (b.comparative_statement || undefined) : undefined,
      proposer_signature: proposerSig,
      will_generate_revenue: !isPurchase && Boolean(b.will_generate_revenue),
      event_completion_status: 'not_started' as const,
    };
  }

  const bankDetailEntries: ResourcePersonBankDetail[] = [];
  if (!isPurchase && Array.isArray(b.resource_person_bank_details)) {
    for (const bd of b.resource_person_bank_details) {
      if (!bd || !bd.account_number) continue;
      const acct = String(bd.account_number).trim();
      const conf = bd.confirm_account_number !== undefined ? String(bd.confirm_account_number).trim() : acct;
      if (acct !== conf) {
        return res.status(400).json({
          error: `Bank account number and confirmation do not match for "${bd.resource_person_name || 'Resource Person'}".`,
        });
      }
      if (acct.length < 6) {
        return res.status(400).json({
          error: `Invalid account number for "${bd.resource_person_name || 'Resource Person'}": must be at least 6 digits.`,
        });
      }
      const ifsc = String(bd.ifsc_code || '').trim().toUpperCase();
      if (!validateIfsc(ifsc)) {
        return res.status(400).json({
          error: `Invalid IFSC Code "${ifsc}" for "${bd.resource_person_name || 'Resource Person'}". Must match standard format (e.g. SBIN0001234).`,
        });
      }
      const enc = encryptAccountNumber(acct);
      const honorarium = bd.honorarium_amount !== undefined ? Number(bd.honorarium_amount) || 0 : 0;
      bankDetailEntries.push({
        id: uuid(),
        nfa_id: nfa.id,
        resource_person_name: String(bd.resource_person_name || '').trim(),
        designation: bd.designation ? String(bd.designation).trim() : '',
        organization: bd.organization ? String(bd.organization).trim() : '',
        email: bd.email ? String(bd.email).trim() : '',
        mobile: bd.mobile ? String(bd.mobile).trim() : '',
        honorarium_amount: honorarium,
        account_holder_name: String(bd.account_holder_name || '').trim(),
        bank_name: String(bd.bank_name || '').trim(),
        encrypted_account_number: enc.encrypted_account_number,
        iv: enc.iv,
        auth_tag: enc.auth_tag,
        masked_account_number: enc.masked_account_number,
        ifsc_code: ifsc,
        branch_name: bd.branch_name ? String(bd.branch_name).trim() : '',
        remarks: bd.remarks ? String(bd.remarks).trim() : '',
        tracking_status: 'details_submitted',
        approved_honorarium: honorarium,
        deductions: 0,
        net_payable_amount: honorarium,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }

  await store.transact((db) => {
    if (isNewNfa) {
      db.nfas.push(nfa);
    } else {
      db.nfa_items = db.nfa_items.filter((it) => it.nfa_id !== nfa.id);
      if (db.resource_person_bank_details && bankDetailEntries.length > 0) {
        db.resource_person_bank_details = db.resource_person_bank_details.filter((bd) => bd.nfa_id !== nfa.id);
      }
    }
    processedItems.forEach((it: any) => {
      db.nfa_items.push({
        ...it,
        nfa_id: nfa.id,
      });
    });
    if (bankDetailEntries.length > 0) {
      db.resource_person_bank_details = db.resource_person_bank_details || [];
      bankDetailEntries.forEach((entry) => db.resource_person_bank_details!.push(entry));
    }
  });

  const responsePayload = { ...nfa, items: withItems(nfa.id) };
  if (idempotencyKey) {
    cleanIdempotencyCache();
    idempotencyCache.set(idempotencyKey, {
      id: nfa.id,
      ref_no: nfa.ref_no,
      payload: responsePayload,
      timestamp: Date.now()
    });
    resolveInFlight?.({ status: 201, payload: responsePayload });
    inFlightIdempotency.delete(idempotencyKey);
  }

  res.status(201).json(responsePayload);
});

/**
 * PUT /api/nfas/:id — Edit NFA:
 * - Faculty (proposer) can edit until final approval
 * - HOD can review & edit while in department review
 * - Dean & Associate Dean can review & edit while in dean review
 * - Super admin can edit anytime pre-approval
 * - Post-approval editing is locked (must use /revise)
 */
nfasRouter.put('/:id', async (req: AuthedRequest, res) => {
  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id);
    if (!nfa) return { error: 404 as const };

    if (nfa.status === 'approved') {
      return { error: 400 as const, msg: 'This NFA is already approved. Direct editing is locked; please use the formal budget revision route.' };
    }
    if (nfa.status === 'rejected') {
      return { error: 400 as const, msg: 'This NFA has been rejected. Direct editing is locked.' };
    }

    const isOwner = nfa.created_by === req.user!.id;
    const isHod = req.user!.role === 'hod' && req.user!.department_id === nfa.department_id;
    const isDean = ['dean', 'associate_dean'].includes(req.user!.role);
    const isSuperAdmin = req.user!.role === 'super_admin';

    // Strict Draft Editing: An unsubmitted Draft can ONLY be edited by its creator
    if (nfa.status === 'draft') {
      if (!isOwner) {
        return { error: 403 as const, msg: 'Forbidden: Only the creator may edit a draft NFA' };
      }
    } else {
      const canOwnerEdit = isOwner && !['approved', 'rejected'].includes(nfa.status);
      if (!canOwnerEdit && !isHod && !isDean && !isSuperAdmin) {
        return { error: 403 as const, msg: 'Not authorized to edit this NFA' };
      }
    }

    const b = req.body || {};

    if (b.point1 && countWords(b.point1) > 50) {
      return { error: 400 as const, msg: `Point 1 (Purpose) exceeds the 50-word limit (${countWords(b.point1)}/50)` };
    }
    if (b.point2 && countWords(b.point2) > 50) {
      return { error: 400 as const, msg: `Point 2 (Logistics) exceeds the 50-word limit (${countWords(b.point2)}/50)` };
    }
    if (b.point3 && countWords(b.point3) > 50) {
      return { error: 400 as const, msg: `Point 3 (Justification) exceeds the 50-word limit (${countWords(b.point3)}/50)` };
    }
    if (b.point4 && countWords(b.point4) > 50) {
      return { error: 400 as const, msg: `Point 4 (Expenditure Statement) exceeds the 50-word limit (${countWords(b.point4)}/50)` };
    }

    // Capture old financial coordinates
    const oldDeptId = nfa.department_id;
    const oldFyId = nfa.financial_year_id;
    const oldCatId = nfa.budget_category_id;
    const oldSubcatId = nfa.budget_subcategory_id;
    const oldSubcatName = (nfa as any).budget_subcategory_name;
    const oldAmount = nfa.total_amount;
    const oldStatus = nfa.status;
    const hasActiveReservation = !['draft', 'revision_required'].includes(oldStatus);

    let targetDeptId = oldDeptId;
    let targetOrgType: 'department' | 'centre_or_office' = nfa.organization_type || 'department';
    let targetCentreId = nfa.centre_id || null;

    if (nfa.status === 'draft') {
      if (b.organization_type) {
        targetOrgType = b.organization_type === 'centre_or_office' ? 'centre_or_office' : 'department';
      }
      if (targetOrgType === 'department') {
        if (['faculty', 'hod'].includes(req.user!.role)) {
          if (!req.user!.department_id) {
            return { error: 400 as const, msg: 'No valid department assignment exists for your profile' };
          }
          targetDeptId = req.user!.department_id;
        } else if (b.department_id) {
          targetDeptId = b.department_id;
        }
        targetCentreId = null;
      } else {
        const candidateCentre = b.centre_id || b.department_id || (nfa.organization_type === 'centre_or_office' ? nfa.department_id : null);
        if (!candidateCentre) {
          return { error: 400 as const, msg: 'Centre or Office selection is required' };
        }
        if (req.user!.role !== 'super_admin') {
          const userCentres = req.user!.authorized_centre_ids || [];
          if (!userCentres.includes(candidateCentre)) {
            return { error: 403 as const, msg: 'Forbidden: You are not authorized for this Centre or Office' };
          }
        }
        targetDeptId = candidateCentre;
        targetCentreId = candidateCentre;
      }
    } else {
      if ((b.organization_type && b.organization_type !== (nfa.organization_type || 'department')) ||
          (b.department_id && b.department_id !== nfa.department_id)) {
        return { error: 400 as const, msg: 'Organizational unit cannot be changed after submission.' };
      }
    }

    let targetFyId = oldFyId;
    if (b.financial_year_id && db.financial_years.some((f) => f.id === b.financial_year_id)) {
      targetFyId = b.financial_year_id;
    }

    const targetCatId = b.budget_category_id !== undefined ? b.budget_category_id : oldCatId;
    const targetSubcatId = b.budget_subcategory_id !== undefined ? b.budget_subcategory_id : oldSubcatId;
    const targetSubcatName = b.budget_subcategory_name !== undefined ? b.budget_subcategory_name : oldSubcatName;

    // Compute updated total amount from items if provided
    const targetType = (b.nfa_type !== undefined ? b.nfa_type : nfa.nfa_type) === 'purchase' ? 'purchase' : 'event';
    const isPurchase = targetType === 'purchase';
    let newTotalAmount = oldAmount;

    let updatedItems: any[] | null = null;
    if (Array.isArray(b.items)) {
      updatedItems = [];
      b.items.forEach((it: any, i: number) => {
        const qtyNum = Number(it.quantity);
        const rateNum = Number(it.rate);
        let computedAmount = Number(it.amount) || 0;
        if (!isNaN(qtyNum) && qtyNum > 0 && !isNaN(rateNum) && rateNum >= 0) {
          computedAmount = Math.round(qtyNum * rateNum * 100) / 100;
        }
        if (isNaN(computedAmount) || !isFinite(computedAmount) || computedAmount < 0) {
          computedAmount = 0;
        }
        const isPredefined = !isPurchase && Boolean(it.is_predefined);
        const isSampling = !isPurchase && (Boolean(it.sampling_required) || it.predefined_key === 'sampling');
        if (isSampling) {
          computedAmount = 0; // Sampling has zero financial budget impact
        }
        updatedItems!.push({
          id: it.id || uuid(),
          nfa_id: nfa.id,
          sl_no: i + 1,
          particulars: String(it.particulars || '').trim(),
          quantity: isSampling ? '' : (it.quantity !== undefined && it.quantity !== null ? String(it.quantity).trim() : ''),
          rate: isSampling ? '' : (it.rate !== undefined && it.rate !== null ? String(it.rate).trim() : ''),
          amount: computedAmount,
          comments: it.comments || '',
          justification: it.justification || '',
          basis_of_budget: it.basis_of_budget || '',
          previous_year_budget: Number(it.previous_year_budget) || 0,
          previous_year_actual: Number(it.previous_year_actual) || 0,
          is_predefined: isPredefined,
          predefined_key: isPredefined ? (it.predefined_key || undefined) : undefined,
          distance_km: isPredefined ? (it.distance_km || undefined) : undefined,
          carry_back_arrangement: isPredefined ? (it.carry_back_arrangement || undefined) : undefined,
          sampling_required: isSampling,
          item_type: isPurchase ? 'purchase' : (isPredefined ? 'predefined' : 'custom'),
        });
      });
      newTotalAmount = updatedItems.reduce((s: number, it: any) => s + (Number(it.amount) || 0), 0);
    }

    const financialChanged = (
      targetDeptId !== oldDeptId ||
      targetFyId !== oldFyId ||
      targetCatId !== oldCatId ||
      targetSubcatId !== oldSubcatId ||
      newTotalAmount !== oldAmount
    );

    // If submitted and financial details changed: atomically adjust reservation and return to HOD review
    if (hasActiveReservation && financialChanged) {
      // 1. Release old reservation
      releaseNfaReservation(
        db,
        {
          id: nfa.id,
          department_id: oldDeptId,
          financial_year_id: oldFyId,
          budget_category_id: oldCatId,
          budget_subcategory_id: oldSubcatId,
          budget_subcategory_name: oldSubcatName,
          total_amount: oldAmount,
          ref_no: nfa.ref_no,
        },
        {
          changed_by: req.user!.id,
          role: req.user!.role,
          reason: `NFA updated: adjusting budget reservation from ₹${oldAmount.toLocaleString('en-IN')} to ₹${newTotalAmount.toLocaleString('en-IN')}`,
        }
      );

      // 2. Reserve new amount on target line
      try {
        reserveNfaBudget(
          db,
          {
            id: nfa.id,
            department_id: targetDeptId,
            financial_year_id: targetFyId,
            budget_category_id: targetCatId,
            budget_subcategory_id: targetSubcatId,
            budget_subcategory_name: targetSubcatName,
            total_amount: newTotalAmount,
            ref_no: nfa.ref_no,
          },
          {
            changed_by: req.user!.id,
            role: req.user!.role,
          }
        );
      } catch (err: any) {
        // Rollback: re-reserve old line
        reserveNfaBudget(
          db,
          {
            id: nfa.id,
            department_id: oldDeptId,
            financial_year_id: oldFyId,
            budget_category_id: oldCatId,
            budget_subcategory_id: oldSubcatId,
            budget_subcategory_name: oldSubcatName,
            total_amount: oldAmount,
            ref_no: nfa.ref_no,
          },
          {
            changed_by: req.user!.id,
            role: req.user!.role,
          }
        );
        return { error: 400 as const, msg: `Budget allocation check failed: ${err.message}` };
      }

      // Requirement: Return NFA to HOD review for fresh approvals when financial details change
      nfa.status = 'submitted';
      db.audit_logs.push({
        id: uuid(),
        entity_type: 'nfa',
        entity_id: nfa.id,
        department_id: targetDeptId,
        old_amount: oldAmount,
        new_amount: newTotalAmount,
        difference: newTotalAmount - oldAmount,
        changed_by: req.user!.id,
        role: req.user!.role,
        reason: `Financial details edited (amount/category/department/FY). Reset to HOD review for fresh approvals.`,
        source: 'portal',
        approval_status: 'submitted',
        created_at: new Date().toISOString(),
      });
    } else if (hasActiveReservation && !financialChanged) {
      // Non-financial corrections: preserve the current review stage and record audit log
      db.audit_logs.push({
        id: uuid(),
        entity_type: 'nfa',
        entity_id: nfa.id,
        department_id: nfa.department_id,
        old_amount: oldAmount,
        new_amount: oldAmount,
        difference: 0,
        changed_by: req.user!.id,
        role: req.user!.role,
        reason: `Non-financial details updated by ${req.user!.name} (${req.user!.role}). Preserving current review stage (${nfa.status}).`,
        source: 'portal',
        approval_status: nfa.status,
        created_at: new Date().toISOString(),
      });
    }

    // Commit items
    if (updatedItems) {
      db.nfa_items = db.nfa_items.filter((i) => i.nfa_id !== nfa.id);
      updatedItems.forEach((it) => db.nfa_items.push(it));
      nfa.total_amount = newTotalAmount;
    }

    // Commit fields
    nfa.department_id = targetDeptId;
    nfa.centre_id = targetCentreId;
    nfa.organization_type = targetOrgType;
    nfa.workflow_type = targetOrgType;
    nfa.financial_year_id = targetFyId;
    nfa.budget_category_id = targetCatId;
    nfa.budget_subcategory_id = targetSubcatId || null;
    nfa.budget_subcategory_name = targetSubcatName || '';
    nfa.nfa_type = targetType;

    [
      'title',
      'purpose',
      'description',
      'justification',
      'sdgs',
      'requirements',
      'submitted_by_name',
      'submitted_by_designation',
      'point1',
      'point2',
      'point3',
      'point4',
    ].forEach((f) => {
      if (b[f] !== undefined) (nfa as any)[f] = b[f];
    });

    if (isPurchase) {
      nfa.event_details = undefined;
      nfa.will_generate_revenue = false;
      if (b.purchase_details !== undefined) {
        nfa.purchase_details = b.purchase_details;
      }
      if (b.quotations !== undefined) {
        nfa.quotations = Array.isArray(b.quotations) ? b.quotations : [];
      }
      if (b.comparative_statement !== undefined) {
        nfa.comparative_statement = b.comparative_statement || undefined;
      }
    } else {
      nfa.purchase_details = undefined;
      nfa.quotations = [];
      nfa.comparative_statement = undefined;
      if (b.will_generate_revenue !== undefined) {
        nfa.will_generate_revenue = Boolean(b.will_generate_revenue);
      }
      if (b.event_details !== undefined) {
        nfa.event_details = b.event_details;
      }
      if (Array.isArray(b.resource_person_bank_details)) {
        db.resource_person_bank_details = db.resource_person_bank_details || [];
        const existingDetails = db.resource_person_bank_details.filter((d) => d.nfa_id === nfa.id);
        const updatedList: ResourcePersonBankDetail[] = [];

        for (const bd of b.resource_person_bank_details) {
          if (!bd) continue;
          if (bd.id) {
            const existing = existingDetails.find((d) => d.id === bd.id);
            if (existing) {
              if (bd.account_number) {
                const acct = String(bd.account_number).trim();
                const conf = bd.confirm_account_number !== undefined ? String(bd.confirm_account_number).trim() : acct;
                if (acct !== conf) {
                  return { error: 400, msg: `Bank account number and confirmation do not match for "${bd.resource_person_name || 'Resource Person'}".` };
                }
                if (acct.length < 6) {
                  return { error: 400, msg: `Invalid account number: must be at least 6 digits.` };
                }
                const enc = encryptAccountNumber(acct);
                existing.encrypted_account_number = enc.encrypted_account_number;
                existing.iv = enc.iv;
                existing.auth_tag = enc.auth_tag;
                existing.masked_account_number = enc.masked_account_number;
              }
              if (bd.ifsc_code) {
                const ifsc = String(bd.ifsc_code).trim().toUpperCase();
                if (!validateIfsc(ifsc)) {
                  return { error: 400, msg: `Invalid IFSC Code "${ifsc}".` };
                }
                existing.ifsc_code = ifsc;
              }
              if (bd.resource_person_name !== undefined) existing.resource_person_name = String(bd.resource_person_name).trim();
              if (bd.designation !== undefined) existing.designation = String(bd.designation).trim();
              if (bd.organization !== undefined) existing.organization = String(bd.organization).trim();
              if (bd.email !== undefined) existing.email = String(bd.email).trim();
              if (bd.mobile !== undefined) existing.mobile = String(bd.mobile).trim();
              if (bd.honorarium_amount !== undefined) {
                existing.honorarium_amount = Number(bd.honorarium_amount) || 0;
                if (!existing.approved_honorarium) existing.approved_honorarium = existing.honorarium_amount;
                if (!existing.net_payable_amount) existing.net_payable_amount = existing.honorarium_amount;
              }
              if (bd.account_holder_name !== undefined) existing.account_holder_name = String(bd.account_holder_name).trim();
              if (bd.bank_name !== undefined) existing.bank_name = String(bd.bank_name).trim();
              if (bd.branch_name !== undefined) existing.branch_name = String(bd.branch_name).trim();
              if (bd.remarks !== undefined) existing.remarks = String(bd.remarks).trim();
              existing.updated_at = new Date().toISOString();
              updatedList.push(existing);
              continue;
            }
          }

          if (bd.account_number) {
            const acct = String(bd.account_number).trim();
            const conf = bd.confirm_account_number !== undefined ? String(bd.confirm_account_number).trim() : acct;
            if (acct !== conf) {
              return { error: 400, msg: `Bank account number and confirmation do not match for "${bd.resource_person_name || 'Resource Person'}".` };
            }
            if (acct.length < 6) {
              return { error: 400, msg: `Invalid account number: must be at least 6 digits.` };
            }
            const ifsc = String(bd.ifsc_code || '').trim().toUpperCase();
            if (!validateIfsc(ifsc)) {
              return { error: 400, msg: `Invalid IFSC Code "${ifsc}".` };
            }
            const enc = encryptAccountNumber(acct);
            const honorarium = bd.honorarium_amount !== undefined ? Number(bd.honorarium_amount) || 0 : 0;
            updatedList.push({
              id: uuid(),
              nfa_id: nfa.id,
              resource_person_name: String(bd.resource_person_name || '').trim(),
              designation: bd.designation ? String(bd.designation).trim() : '',
              organization: bd.organization ? String(bd.organization).trim() : '',
              email: bd.email ? String(bd.email).trim() : '',
              mobile: bd.mobile ? String(bd.mobile).trim() : '',
              honorarium_amount: honorarium,
              account_holder_name: String(bd.account_holder_name || '').trim(),
              bank_name: String(bd.bank_name || '').trim(),
              encrypted_account_number: enc.encrypted_account_number,
              iv: enc.iv,
              auth_tag: enc.auth_tag,
              masked_account_number: enc.masked_account_number,
              ifsc_code: ifsc,
              branch_name: bd.branch_name ? String(bd.branch_name).trim() : '',
              remarks: bd.remarks ? String(bd.remarks).trim() : '',
              tracking_status: 'details_submitted',
              approved_honorarium: honorarium,
              deductions: 0,
              net_payable_amount: honorarium,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          }
        }
        db.resource_person_bank_details = db.resource_person_bank_details.filter((d) => d.nfa_id !== nfa.id).concat(updatedList);
      }
    }

    if (b.point1) nfa.purpose = b.point1;
    if (b.point2) nfa.description = b.point2;
    if (b.point3) nfa.justification = b.point3;

    if (nfa.status === 'revision_required' && isOwner) {
      nfa.status = 'draft';
    }
    nfa.updated_at = new Date().toISOString();
    return { nfa };
  });

  if ('error' in result) {
    if (result.error === 404) return res.status(404).json({ error: 'NFA not found' });
    if (result.error === 400) return res.status(400).json({ error: (result as any).msg });
    return res.status(403).json({ error: (result as any).msg || 'Not authorized to edit this NFA at current stage' });
  }
  res.json({ ...result.nfa, items: withItems(result.nfa!.id), approvals: withApprovals(result.nfa!.id) });
});

/** POST /api/nfas/:id/submit — Faculty submits draft or returned NFA */
nfasRouter.post('/:id/submit', async (req: AuthedRequest, res) => {
  let notifyEvent: 'nfa_submitted' | 'nfa_resubmitted' = 'nfa_submitted';

  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id && !n.is_deleted);
    if (!nfa) return { error: 404 as const };
    if (nfa.created_by !== req.user!.id) return { error: 403 as const };
    if (!['draft', 'revision_required'].includes(nfa.status)) {
      // Safe submission deduplication: if already submitted, return current NFA state
      if (['pending_hod_review', 'pending_deans_office_verification', 'submitted', 'in_review'].includes(nfa.status)) {
        return { error: 'already_submitted' as const, nfa };
      }
      return { error: 'bad_status' as const };
    }
    
    const items = db.nfa_items.filter((i) => i.nfa_id === nfa.id);
    if (items.length === 0) return { error: 'no_items' as const };

    // Strict Submission Validation for Purchase NFA
    if (nfa.nfa_type === 'purchase') {
      const validItems = items.filter((it) => it.particulars && it.amount > 0);
      if (validItems.length === 0) {
        return { error: 'validation_error' as const, msg: 'Purchase NFA must contain at least one valid item with description, quantity, rate, and amount.' };
      }

      const quotes = nfa.quotations || [];
      if (quotes.length < 3) {
        return { error: 'validation_error' as const, msg: 'Three vendor quotations (Vendor A, Vendor B, Vendor C) are mandatory before submitting a Purchase NFA.' };
      }

      const quoteFiles: string[] = [];
      const quoteHashes: string[] = [];
      const vLabels = ['Vendor A (Quotation 1)', 'Vendor B (Quotation 2)', 'Vendor C (Quotation 3)'];

      for (let i = 0; i < 3; i++) {
        const q = quotes[i];
        const vLabel = vLabels[i];
        if (!q || !q.vendor_name || !q.vendor_name.trim()) {
          return { error: 'validation_error' as const, msg: `${vLabel}: Vendor Name is required.` };
        }
        if (!q.file_path) {
          return { error: 'validation_error' as const, msg: `${vLabel}: Quotation document upload is missing.` };
        }
        const fullP = path.join(attachmentsDir, path.basename(q.file_path));
        if (!fs.existsSync(fullP)) {
          return { error: 'validation_error' as const, msg: `${vLabel}: Uploaded quotation file could not be found in storage.` };
        }
        quoteFiles.push(path.basename(q.file_path).toLowerCase());
        if (q.file_hash) quoteHashes.push(q.file_hash);
      }

      // Check for duplicate files across quotations
      const uniqueFiles = new Set(quoteFiles);
      if (uniqueFiles.size < quoteFiles.length) {
        return { error: 'validation_error' as const, msg: 'Identical quotation documents detected. Each vendor quotation must be a distinct document.' };
      }
      if (quoteHashes.length === 3) {
        const uniqueHashes = new Set(quoteHashes);
        if (uniqueHashes.size < quoteHashes.length) {
          return { error: 'validation_error' as const, msg: 'Identical quotation document contents detected. Each vendor quotation must be an independent document.' };
        }
      }

      // Comparative Statement validation
      if (!nfa.comparative_statement || !nfa.comparative_statement.file_path) {
        return { error: 'validation_error' as const, msg: 'Comparative Statement document upload is mandatory before submitting a Purchase NFA.' };
      }
      const csPath = path.join(attachmentsDir, path.basename(nfa.comparative_statement.file_path));
      if (!fs.existsSync(csPath)) {
        return { error: 'validation_error' as const, msg: 'Comparative Statement file could not be found in storage.' };
      }
    } else {
      // Event NFA validation
      const validItems = items.filter((it) => it.particulars && it.amount > 0);
      if (validItems.length === 0) {
        return { error: 'validation_error' as const, msg: 'Event NFA must contain at least one valid expense item with quantity, rate, and calculated amount.' };
      }
    }

    const creatorUser = db.users.find((u) => u.id === req.user!.id);
    if (!nfa.proposer_signature) {
      nfa.proposer_signature = creatorUser?.signature_image || (fs.existsSync(path.join(signaturesDir, `${req.user!.id}.png`)) ? `${req.user!.id}.png` : undefined);
    }

    // Reserve budget for this active proposal
    try {
      reserveNfaBudget(db, nfa, { changed_by: req.user!.id, role: req.user!.role });
    } catch (e: any) {
      return { error: 'budget_error' as const, msg: e.message || 'Budget reservation failed' };
    }

    notifyEvent = nfa.status === 'revision_required' ? 'nfa_resubmitted' : 'nfa_submitted';
    const prevStatus = nfa.status;

    // Route to appropriate workflow entry stage:
    // Centres or Offices -> Pending Dean's Office Verification (skips HOD entirely)
    // Department -> Pending HOD Review
    const isCentre = nfa.organization_type === 'centre_or_office';
    nfa.status = isCentre ? 'pending_deans_office_verification' : 'pending_hod_review';
    nfa.updated_at = new Date().toISOString();

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'nfa',
      entity_id: nfa.id,
      department_id: nfa.department_id,
      old_amount: 0,
      new_amount: nfa.total_amount,
      difference: nfa.total_amount,
      changed_by: req.user!.id,
      role: req.user!.role,
      reason: notifyEvent === 'nfa_resubmitted' ? `NFA resubmitted after correction.` : `NFA submitted for review.`,
      source: 'portal',
      approval_status: nfa.status,
      created_at: new Date().toISOString(),
    });

    return { nfa, event: notifyEvent, prevStatus };
  });

  if ('error' in result) {
    if (result.error === 'already_submitted') {
      const existingNfa = result.nfa!;
      console.log(`[SUBMIT DEDUPLICATED] NFA ${req.params.id} already submitted in status ${existingNfa.status}`);
      return res.status(200).json({
        ...existingNfa,
        items: withItems(existingNfa.id),
        approvals: withApprovals(existingNfa.id),
        message: 'NFA has already been submitted for review'
      });
    }
    if (result.error === 'validation_error' || result.error === 'budget_error') {
      return res.status(400).json({ error: (result as any).msg });
    }
    const map: Record<string, [number, string]> = {
      404: [404, 'NFA not found'],
      403: [403, 'Only the creator can submit this NFA'],
      bad_status: [409, 'NFA is not in a submittable state'],
      no_items: [400, 'Add at least one budget item before submitting'],
    };
    const [code, msg] = map[result.error];
    return res.status(code).json({ error: msg });
  }

  // Dispatch mock email notification (never throws or reverses successful submission)
  try {
    await dispatchWorkflowNotification(store.data, {
      nfa: result.nfa!,
      actor: req.user!,
      event: result.event!,
    });
  } catch (err: any) {
    console.warn(`[WARN] Failed to dispatch submission mock notification: ${err.message}`);
  }

  res.json({ ...result.nfa, items: withItems(result.nfa!.id), approvals: withApprovals(result.nfa!.id) });
});

/**
 * POST /api/nfas/:id/review — Multi-tier hierarchical university review:
 * Workflow A — CSE and ADSE Departments (7 stages):
 * 1. Faculty: Submitted -> pending_hod_review
 * 2. HOD: Reviewed -> pending_deans_office_verification
 * 3. Dean's Office: Verified -> pending_associate_dean_approval
 * 4. Associate Dean: Approved -> pending_finance_office_approval
 * 5. Finance Office: Approved -> pending_director_approval
 * 6. Director: Approved -> pending_finance_head_approval
 * 7. Finance Officer (Head): Final Approved -> approved (Debits budget)
 *
 * Workflow B — Other Academic Departments (7 stages):
 * 1. Faculty: Submitted -> pending_hod_review
 * 2. HOD: Reviewed -> pending_deans_office_verification
 * 3. Dean's Office: Verified -> pending_dean_approval
 * 4. Dean: Approved -> pending_finance_office_approval
 * 5. Finance Office: Approved -> pending_director_approval
 * 6. Director: Approved -> pending_finance_head_approval
 * 7. Finance Officer (Head): Final Approved -> approved (Debits budget)
 *
 * Workflow C — Centres or Offices (6 stages):
 * 1. Faculty / Coordinator: Submitted -> pending_deans_office_verification (skips HOD only)
 * 2. Dean's Office: Verified -> pending_dean_approval
 * 3. Dean: Approved -> pending_finance_office_approval
 * 4. Finance Office: Approved -> pending_director_approval
 * 5. Director: Approved -> pending_finance_head_approval
 * 6. Finance Officer (Head): Final Approved -> approved (Debits budget)
 */
nfasRouter.post('/:id/review', async (req: AuthedRequest, res) => {
  const { decision, comments } = req.body || {};
  if (!['approve', 'reject', 'revision_required'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approve', 'reject', or 'revision_required'" });
  }

  if ((decision === 'reject' || decision === 'revision_required') && (!comments || !String(comments).trim())) {
    return res.status(400).json({
      error: decision === 'reject' ? 'Rejection reason is mandatory.' : 'Correction reason is mandatory when returning an NFA to faculty.',
    });
  }

  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id && !n.is_deleted);
    if (!nfa) return { error: 404 as const, msg: 'NFA not found' };

    const role = req.user!.role;

    // Super Admin is an administrative role and must NOT approve financial proposals
    if (role === 'super_admin') {
      return {
        error: 403 as const,
        msg: 'Super Admin is an administrative role and cannot approve financial proposals. Approvals must be performed by the designated institutional authority.',
      };
    }

    const isCentre = nfa.organization_type === 'centre_or_office';
    const isCseOrAdse = !isCentre && isCseOrAdseDepartment(nfa.department_id);
    let level: number;
    let requiredRoles: Role[];
    let nextApprovedStatus: NfaStatus;
    let approvedDecision: 'recommended' | 'verified' | 'approved' = 'recommended';
    let eventName: any;

    if (nfa.status === 'submitted' || nfa.status === 'pending_hod_review' || nfa.status === 'under_review') {
      if (isCentre) {
        return { error: 400 as const, msg: 'Centres or Offices NFAs do not require HOD review.' };
      }
      level = 1;
      requiredRoles = ['hod'];
      nextApprovedStatus = 'pending_deans_office_verification';
      approvedDecision = 'recommended';
      eventName = 'hod_reviewed';
    } else if (nfa.status === 'pending_deans_office_verification') {
      level = 2;
      requiredRoles = ['deans_office'];
      // Workflow A (CSE/ADSE) -> Associate Dean; Workflow B & C -> Dean
      nextApprovedStatus = isCseOrAdse ? 'pending_associate_dean_approval' : 'pending_dean_approval';
      approvedDecision = 'verified';
      eventName = 'deans_office_verified';
    } else if (nfa.status === 'pending_associate_dean_approval') {
      // Academic approval strictly by Associate Dean for Workflow A (CSE/ADSE)
      level = 3;
      requiredRoles = ['associate_dean'];
      nextApprovedStatus = 'pending_finance_office_approval';
      approvedDecision = 'approved';
      eventName = 'associate_dean_approved';
    } else if (nfa.status === 'dean_review' || nfa.status === 'pending_dean_approval') {
      // Academic approval strictly by Dean for Workflow B (Other Departments) & C (Centres)
      level = 3;
      requiredRoles = ['dean'];
      nextApprovedStatus = 'pending_finance_office_approval';
      approvedDecision = 'approved';
      eventName = 'dean_approved';
    } else if (nfa.status === 'accounts_review' || nfa.status === 'pending_finance_office_approval' || nfa.status === 'budget_validation') {
      level = 4;
      requiredRoles = ['finance'];
      nextApprovedStatus = 'pending_director_approval';
      approvedDecision = 'approved';
      eventName = 'finance_office_approved';
    } else if (nfa.status === 'pending_director_approval' || nfa.status === 'pending_higher_approval') {
      level = 5;
      requiredRoles = ['director'];
      nextApprovedStatus = 'pending_finance_head_approval';
      approvedDecision = 'approved';
      eventName = 'director_approved';
    } else if (nfa.status === 'pending_finance_head_approval') {
      level = 6;
      requiredRoles = ['finance_head'];
      nextApprovedStatus = 'approved';
      approvedDecision = 'approved';
      eventName = 'finance_head_approved';
    } else {
      return { error: 409 as const, msg: `NFA in status '${nfa.status}' is not awaiting review` };
    }

    const matchesRole = requiredRoles.includes(role);
    if (!matchesRole) {
      return { error: 403 as const, msg: `This stage requires review by '${requiredRoles.join(' or ')}'` };
    }

    if (role === 'hod' && req.user!.department_id !== nfa.department_id) {
      return { error: 403 as const, msg: 'You can only review NFAs in your own department' };
    }

    const approverUser = db.users.find((u) => u.id === req.user!.id);
    const sigFilename = approverUser?.signature_image || (fs.existsSync(path.join(signaturesDir, `${req.user!.id}.png`)) ? `${req.user!.id}.png` : undefined);
    const prevStatus = nfa.status;

    if (decision === 'reject') {
      releaseNfaReservation(db, nfa, { changed_by: req.user!.id, role, reason: comments || 'Proposal rejected during review' });
      // If there was a pending revision, release its reservation
      if ((nfa as any).pending_revision_amount !== undefined && (nfa as any).pending_revision_amount !== null) {
        const diff = (nfa as any).pending_revision_amount - nfa.total_amount;
        if (diff > 0) {
          let line = db.department_budgets.find((b) => b.department_id === nfa.department_id && b.financial_year_id === nfa.financial_year_id && b.budget_category_id === nfa.budget_category_id);
          if (line) {
            line.pending_amount = Math.max(0, line.pending_amount - diff);
          }
        }
        (nfa as any).pending_revision_amount = undefined;
        (nfa as any).pending_revision_reason = undefined;
        delete (nfa as any).pending_revision_items;
      }

      nfa.status = 'rejected';
      nfa.updated_at = new Date().toISOString();

      db.approvals.push({
        id: uuid(),
        nfa_id: nfa.id,
        approver_role: role,
        approver_id: req.user!.id,
        approver_name: req.user!.name,
        decision: 'rejected',
        comments: comments || '',
        level,
        previous_status: prevStatus,
        new_status: 'rejected',
        signature_image: undefined,
        created_at: new Date().toISOString(),
      });

      return { nfa, validation: null, event: 'nfa_rejected' as const, prevStatus };
    }

    if (decision === 'revision_required') {
      releaseNfaReservation(db, nfa, { changed_by: req.user!.id, role, reason: comments || 'Revision requested by reviewer' });
      if ((nfa as any).pending_revision_amount !== undefined && (nfa as any).pending_revision_amount !== null) {
        const diff = (nfa as any).pending_revision_amount - nfa.total_amount;
        if (diff > 0) {
          let line = db.department_budgets.find((b) => b.department_id === nfa.department_id && b.financial_year_id === nfa.financial_year_id && b.budget_category_id === nfa.budget_category_id);
          if (line) {
            line.pending_amount = Math.max(0, line.pending_amount - diff);
          }
        }
        (nfa as any).pending_revision_amount = undefined;
        (nfa as any).pending_revision_reason = undefined;
        delete (nfa as any).pending_revision_items;
      }

      nfa.status = 'revision_required';
      nfa.updated_at = new Date().toISOString();

      db.approvals.push({
        id: uuid(),
        nfa_id: nfa.id,
        approver_role: role,
        approver_id: req.user!.id,
        approver_name: req.user!.name,
        decision: 'revision_required',
        comments: comments || '',
        level,
        previous_status: prevStatus,
        new_status: 'revision_required',
        signature_image: undefined,
        created_at: new Date().toISOString(),
      });

      return { nfa, validation: null, event: 'revision_required' as const, prevStatus };
    }

    // decision === 'approve'
    db.approvals.push({
      id: uuid(),
      nfa_id: nfa.id,
      approver_role: role,
      approver_id: req.user!.id,
      approver_name: req.user!.name,
      decision: approvedDecision,
      comments: comments || '',
      level,
      previous_status: prevStatus,
      new_status: nextApprovedStatus,
      signature_image: sigFilename,
      created_at: new Date().toISOString(),
    });

    if (level === 1) {
      nfa.status = nextApprovedStatus;
      nfa.hod_name = req.user!.name;
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null, event: eventName, prevStatus };
    }

    if (level >= 2 && level <= 5) {
      nfa.status = nextApprovedStatus;
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null, event: eventName, prevStatus };
    }

    // level === 6: Finance Officer (Head) gives FINAL APPROVAL!
    // Converts reservation into approved expenditure atomically
    if ((nfa.status as string) === 'approved') {
      return { error: 409 as const, msg: 'NFA is already approved. Cannot apply duplicate approval deduction.' };
    }

    let line;
    try {
      line = findBudgetLine(db, nfa.department_id, nfa.financial_year_id, nfa.budget_category_id);
    } catch (e) {
      return { error: 400 as const, msg: (e as BudgetError).message };
    }

    if ((nfa as any).pending_revision_amount !== undefined && (nfa as any).pending_revision_amount !== null) {
      const revAmount = (nfa as any).pending_revision_amount;
      const diff = revAmount - nfa.total_amount;
      finalizePendingRevision(db, line.id, diff, {
        nfa_id: nfa.id,
        project_id: nfa.project_id || '',
        changed_by: req.user!.id,
        role,
        department_id: nfa.department_id,
        reason: (nfa as any).pending_revision_reason || 'Approved revision by Finance Officer (Head)',
      });
      nfa.total_amount = revAmount;
      if ((nfa as any).pending_revision_items) {
        db.nfa_items = db.nfa_items.filter((i) => i.nfa_id !== nfa.id);
        ((nfa as any).pending_revision_items as any[]).forEach((it: any, i: number) => {
          db.nfa_items.push({ id: uuid(), nfa_id: nfa.id, sl_no: i + 1, particulars: it.particulars, quantity: it.quantity || '', amount: Number(it.amount) || 0 });
        });
        delete (nfa as any).pending_revision_items;
      }
      (nfa as any).pending_revision_amount = undefined;
      (nfa as any).pending_revision_reason = undefined;
    } else {
      applyNewApproval(db, line.id, nfa.total_amount, {
        nfa_id: nfa.id,
        project_id: nfa.project_id || '',
        changed_by: req.user!.id,
        role,
        department_id: nfa.department_id,
      });
    }

    nfa.status = 'approved';
    nfa.updated_at = new Date().toISOString();
    return { nfa, validation: null, event: eventName, prevStatus };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });

  // Dispatch mock email notification for this approval stage
  try {
    await dispatchWorkflowNotification(store.data, {
      nfa: result.nfa!,
      actor: req.user!,
      event: result.event!,
      comments: comments || '',
    });
  } catch (err: any) {
    console.warn(`[WARN] Failed to dispatch workflow mock notification: ${err.message}`);
  }

  res.json({
    ...result.nfa,
    items: withItems(result.nfa!.id),
    approvals: withApprovals(result.nfa!.id),
    validation: (result as any).validation,
  });
});

/**
 * POST /api/nfas/:id/complete-event — Mark an approved event as completed
 */
nfasRouter.post('/:id/complete-event', async (req: AuthedRequest, res) => {
  const user = req.user!;
  const { id } = req.params;
  const { completion_date, completion_remarks } = req.body || {};

  const nfa = store.data.nfas.find((n) => n.id === id);
  if (!nfa) {
    return res.status(404).json({ error: 'Note for Approval not found' });
  }

  if (nfa.nfa_type !== 'event') {
    return res.status(400).json({ error: 'Event completion tracking only applies to Event NFAs' });
  }

  if (nfa.status !== 'approved') {
    return res.status(400).json({ error: 'Only finally approved events can be marked as completed' });
  }

  const isOwner = nfa.created_by === user.id;
  const isHod = user.role === 'hod' && user.department_id === nfa.department_id;
  const isCentre = Boolean(nfa.centre_id && user.authorized_centre_ids?.includes(nfa.centre_id));
  const isSenior = ['super_admin', 'director', 'finance', 'finance_head', 'dean', 'associate_dean', 'deans_office'].includes(user.role);

  if (!isOwner && !isHod && !isCentre && !isSenior) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to manage this NFA' });
  }

  const finalDate = completion_date ? String(completion_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const finalRemarks = completion_remarks ? String(completion_remarks).trim() : 'Event completed successfully';

  await store.transact((db) => {
    const target = db.nfas.find((n) => n.id === id);
    if (target) {
      target.event_completion_status = 'completed';
      target.event_completion_date = finalDate;
      target.event_completion_remarks = finalRemarks;
      target.event_completed_by = user.id;
      target.event_completed_at = new Date().toISOString();
      target.updated_at = new Date().toISOString();
    }

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'nfa',
      entity_id: nfa.id,
      department_id: nfa.department_id,
      old_amount: null,
      new_amount: null,
      difference: null,
      changed_by: user.name,
      role: user.role,
      reason: `Event marked as COMPLETED by ${user.name} on ${finalDate}: ${finalRemarks}`,
      source: 'portal',
      approval_status: 'completed',
      created_at: new Date().toISOString(),
    });
  });

  let reminderSent = false;
  if (nfa.will_generate_revenue) {
    try {
      const { sendRevenueReminderNotification } = await import('../services/revenueReminder.js');
      await sendRevenueReminderNotification({ ...nfa, event_completion_date: finalDate, event_completion_remarks: finalRemarks }, user.name);
      reminderSent = true;
    } catch (err: any) {
      console.warn('[REVENUE REMINDER] Notification warning:', err.message);
    }
  }

  res.json({
    success: true,
    message: 'Event successfully marked as completed',
    reminder_sent: reminderSent,
  });
});

/**
 * GET /api/nfas/dev/mock-emails — Developer & Super Admin Mock Email Log
 */
nfasRouter.get('/dev/mock-emails', requireRole('super_admin'), (req: AuthedRequest, res) => {
  const list = store.data.mock_emails || [];
  res.json(list);
});

/**
 * POST /api/nfas/dev/mock-emails/clear — Clear mock email logs
 */
nfasRouter.post('/dev/mock-emails/clear', requireRole('super_admin'), (req: AuthedRequest, res) => {
  store.data.mock_emails = [];
  res.json({ success: true, count: 0 });
});

/**
 * POST /api/nfas/:id/revise — Faculty/HOD change the budget on an ALREADY-APPROVED NFA
 * (requirements #10, #11, #12). Computes the difference; small changes apply immediately,
 * large ones escalate to Finance via 'pending_higher_approval'.
 * body: { new_total_amount, reason, items? }
 */
nfasRouter.post('/:id/revise', requireRole('faculty', 'hod', 'super_admin'), async (req: AuthedRequest, res) => {
  const { new_total_amount, reason, items } = req.body || {};
  if (typeof new_total_amount !== 'number' || new_total_amount < 0) {
    return res.status(400).json({ error: 'new_total_amount must be a non-negative number' });
  }
  if (!reason) return res.status(400).json({ error: 'reason is required for any budget revision' });

  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id);
    if (!nfa) return { error: 404 as const, msg: 'NFA not found' };
    if (nfa.status !== 'approved') return { error: 409 as const, msg: 'Only an approved NFA can be revised' };
    if (req.user!.department_id !== nfa.department_id && req.user!.role !== 'super_admin') {
      return { error: 403 as const, msg: 'You can only revise NFAs in your own department' };
    }

    const line = findBudgetLine(db, nfa.department_id, nfa.financial_year_id, nfa.budget_category_id);
    const oldAmount = nfa.total_amount;

    const outcome = reviseApprovedAmount(db, line.id, oldAmount, new_total_amount, {
      nfa_id: nfa.id,
      project_id: nfa.project_id,
      changed_by: req.user!.id,
      role: req.user!.role,
      department_id: nfa.department_id,
      reason,
      source: 'portal',
    });

    if (outcome.status === 'pending_higher_approval') {
      // Revisions with significant increases route through the complete institutional workflow:
      // Department -> pending_hod_review; Centres or Offices -> pending_deans_office_verification
      // Both ending at pending_finance_head_approval
      const isCentre = nfa.organization_type === 'centre_or_office';
      nfa.status = isCentre ? 'pending_deans_office_verification' : 'pending_hod_review';
      nfa.pending_revision_amount = new_total_amount;
      nfa.pending_revision_reason = reason;
      if (Array.isArray(items)) {
        (nfa as any).pending_revision_items = items;
      }
    } else {
      nfa.total_amount = new_total_amount;
      if (Array.isArray(items)) {
        db.nfa_items = db.nfa_items.filter((i) => i.nfa_id !== nfa.id);
        items.forEach((it: any, i: number) => {
          db.nfa_items.push({ id: uuid(), nfa_id: nfa.id, sl_no: i + 1, particulars: it.particulars, quantity: it.quantity || '', amount: Number(it.amount) || 0 });
        });
      }
    }
    nfa.updated_at = new Date().toISOString();
    return { nfa, outcome };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });
  res.json({ ...result.nfa, items: withItems(result.nfa!.id), revision: { difference: result.outcome!.difference, status: result.outcome!.status } });
});
