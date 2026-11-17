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
import type { NfaStatus, Role } from '../types.js';

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
  // Strict Draft Privacy: Unsubmitted draft attachments are strictly private to creator
  if (nfa.status === 'draft' && nfa.created_by !== u.id && u.role !== 'super_admin') {
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

function countWords(str: string): number {
  if (!str) return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
}

/** GET /api/nfas/inbox — NFAs requiring immediate action from logged in user */
nfasRouter.get('/inbox', (req: AuthedRequest, res) => {
  const { role, id, department_id } = req.user!;
  let list = store.data.nfas;
  if (role === 'faculty') {
    list = list.filter((n) => n.created_by === id && (n.status === 'draft' || n.status === 'revision_required'));
  } else if (role === 'hod') {
    list = list.filter((n) => n.department_id === department_id && n.status === 'submitted');
  } else if (role === 'dean' || role === 'associate_dean') {
    list = list.filter((n) => n.status === 'dean_review');
  } else if (role === 'finance') {
    list = list.filter((n) => n.status === 'accounts_review');
  } else if (role === 'director') {
    list = list.filter((n) => n.status === 'pending_director_approval' || n.status === 'pending_higher_approval');
  } else if (role === 'super_admin') {
    list = list.filter((n) => ['submitted', 'dean_review', 'accounts_review', 'pending_director_approval', 'pending_higher_approval'].includes(n.status));
  } else {
    list = [];
  }
  res.json(list.map((n) => ({ ...n, items: withItems(n.id), approvals: withApprovals(n.id) })));
});

/** GET /api/nfas — role-scoped list with strict draft privacy */
nfasRouter.get('/', (req: AuthedRequest, res) => {
  let list = store.data.nfas;
  const { role, id, department_id } = req.user!;
  if (role === 'faculty') {
    list = list.filter((n) => n.created_by === id);
  } else if (role === 'hod' || role === 'it_admin') {
    list = list.filter((n) => n.department_id === department_id);
  }
  // dean, associate_dean, director, finance, super_admin see all departments

  // Strict Draft Privacy: Unsubmitted draft NFAs are strictly private to their creator.
  // Higher officials (HOD, Dean, Finance, Director) and other users must NOT see another user's draft.
  // Super Admin administrative access is supported via ?all_drafts=true or for drafts created by super_admin.
  const canSeeAllDrafts = role === 'super_admin' && req.query.all_drafts === 'true';
  list = list.filter((n) => {
    if (n.status === 'draft') {
      return n.created_by === id || canSeeAllDrafts;
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
  const nextSeq = Math.max(maxSeq + 1, deptCount + 1);
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
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
    // Strict Draft Privacy: An unsubmitted Draft NFA is strictly private to its creator
    if (nfa.status === 'draft' && nfa.created_by !== id && role !== 'super_admin') {
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
    // Strict Draft Privacy: Unsubmitted draft NFAs cannot be downloaded by non-creators
    if (nfa.status === 'draft' && nfa.created_by !== id && role !== 'super_admin') {
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

  // 4. Available Subcategory Budget
  let currentAvailable = 0;
  if (subcat && subcat.allocated_amount > 0) {
    currentAvailable = subcat.allocated_amount - subcat.approved_amount - subcat.pending_amount;
  } else if (budgetLine && budgetLine.allocated_amount > 0) {
    currentAvailable = budgetLine.allocated_amount - budgetLine.approved_amount - budgetLine.pending_amount;
  }

  // Determine if NFA total_amount was already deducted in pending or approved
  const isAlreadyDeducted = ['pending_director_approval', 'pending_higher_approval', 'approved'].includes(nfa.status);
  let availableBudget = 0;
  let balanceAfter = 0;

  if (isAlreadyDeducted) {
    balanceAfter = Math.max(0, currentAvailable);
    availableBudget = balanceAfter + nfa.total_amount;
  } else {
    availableBudget = Math.max(0, currentAvailable > 0 ? currentAvailable : totalAllocationSubcategory);
    balanceAfter = Math.max(0, availableBudget - nfa.total_amount);
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

/** DELETE /api/nfas/:id — remove an NFA and its draft data when authorized. */
nfasRouter.delete('/:id', async (req: AuthedRequest, res) => {
  const result = await store.transact((db) => {
    const nfa = db.nfas.find((item) => item.id === req.params.id);
    if (!nfa) return { error: 404 as const };

    // When status is 'draft', only the creator (or super_admin) can delete their draft
    let canDelete: boolean;
    if (nfa.status === 'draft') {
      canDelete = nfa.created_by === req.user!.id || req.user!.role === 'super_admin';
    } else {
      canDelete = req.user!.role === 'super_admin' || nfa.created_by === req.user!.id || (['faculty', 'hod'].includes(req.user!.role) && nfa.department_id === req.user!.department_id);
    }
    if (!canDelete) return { error: 403 as const };

    // If deleting an NFA that has an active reservation, release the reserved funds
    if (['submitted', 'dean_review', 'accounts_review', 'pending_director_approval', 'under_review'].includes(nfa.status)) {
      releaseNfaReservation(db, nfa, { changed_by: req.user!.id, role: req.user!.role, reason: 'NFA deleted / withdrawn by user' });
    }

    db.nfas = db.nfas.filter((item) => item.id !== nfa.id);
    db.nfa_items = db.nfa_items.filter((item) => item.nfa_id !== nfa.id);
    db.approvals = db.approvals.filter((approval) => approval.nfa_id !== nfa.id);
    return { deleted: true };
  });
  if ('error' in result) return res.status(result.error).json({ error: result.error === 404 ? 'NFA not found' : 'Not authorized to delete this NFA' });
  res.json(result);
});

/**
 * POST /api/nfas — Faculty, HOD, and administrators can create an NFA.
 * Note: project_id is completely OPTIONAL.
 * Department can be chosen or custom entered.
 * Ref No is automatically generated if not provided.
 */
nfasRouter.post('/', requireRole('faculty', 'hod', 'dean', 'super_admin'), (req: AuthedRequest, res) => {
  const b = req.body || {};
  
  // Handle custom department if applicant specified
  let targetDepartmentId = b.department_id;
  if ((b.department_id === '__custom__' || !b.department_id) && b.custom_department_name) {
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

  // Ensure department is selected or fallback to user's assigned department
  if (!targetDepartmentId) {
    targetDepartmentId = req.user?.department_id || store.data.departments[0]?.id;
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

  // Auto reference number calculation with enforced uniqueness
  let refNo = b.ref_no ? String(b.ref_no).trim() : '';
  const refExists = refNo && store.data.nfas.some((n) => n.ref_no.toLowerCase() === refNo.toLowerCase());
  if (!refNo || refExists) {
    refNo = generateUniqueNfaRefNo(store.data, targetDepartmentId, b.financial_year_id);
  }

  const creatorUser = store.data.users.find((u) => u.id === req.user!.id);
  const proposerSig = creatorUser?.signature_image || (fs.existsSync(path.join(signaturesDir, `${req.user!.id}.png`)) ? `${req.user!.id}.png` : undefined);

  const nfa = {
    id: uuid(),
    ref_no: refNo,
    project_id: b.project_id || null, // Project is optional!
    department_id: targetDepartmentId,
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
  };

  store.transact((db) => {
    db.nfas.push(nfa);
    processedItems.forEach((it: any) => {
      db.nfa_items.push({
        ...it,
        nfa_id: nfa.id,
      });
    });
  });

  res.status(201).json({ ...nfa, items: withItems(nfa.id) });
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

    // Strict Draft Editing: An unsubmitted Draft can ONLY be edited by its creator (or super_admin)
    if (nfa.status === 'draft') {
      if (!isOwner && !isSuperAdmin) {
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
    if (b.department_id && b.department_id !== oldDeptId) {
      if (req.user!.role === 'super_admin' || req.user!.department_id === b.department_id) {
        targetDeptId = b.department_id;
      } else {
        return { error: 403 as const, msg: 'You can only assign NFAs to your authorized department' };
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
      if (b.event_details !== undefined) {
        nfa.event_details = b.event_details;
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

/** POST /api/nfas/:id/submit — Faculty submits draft to HOD */
nfasRouter.post('/:id/submit', async (req: AuthedRequest, res) => {
  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id);
    if (!nfa) return { error: 404 as const };
    if (nfa.created_by !== req.user!.id && req.user!.role !== 'super_admin') return { error: 403 as const };
    if (!['draft', 'revision_required'].includes(nfa.status)) return { error: 'bad_status' as const };
    
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

    // Submitting draft moves to HOD review (submitted)
    nfa.status = 'submitted';
    nfa.updated_at = new Date().toISOString();
    return { nfa };
  });

  if ('error' in result) {
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
  res.json({ ...result.nfa, items: withItems(result.nfa!.id), approvals: withApprovals(result.nfa!.id) });
});

/**
 * POST /api/nfas/:id/review — Multi-tier hierarchical university review:
 * Stage 1: HOD reviews 'submitted' -> 'dean_review'
 * Stage 2: Dean & Assoc Dean reviews 'dean_review' -> 'accounts_review'
 * Stage 3: Accounts Officer reviews 'accounts_review' -> 'pending_director_approval' (Need Permission)
 * Stage 4: University Director reviews 'pending_director_approval' -> 'approved' (Auto debits budget!)
 */
nfasRouter.post('/:id/review', async (req: AuthedRequest, res) => {
  const { decision, comments } = req.body || {};
  if (!['approve', 'reject', 'revision_required'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approve', 'reject', or 'revision_required'" });
  }

  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id);
    if (!nfa) return { error: 404 as const, msg: 'NFA not found' };

    const role = req.user!.role;
    let level: number;
    let requiredRole: Role | Role[];

    if (nfa.status === 'submitted' || nfa.status === 'under_review') {
      level = 1;
      requiredRole = 'hod';
    } else if (nfa.status === 'dean_review') {
      level = 2;
      requiredRole = ['dean', 'associate_dean'];
    } else if (nfa.status === 'accounts_review' || nfa.status === 'budget_validation') {
      level = 3;
      requiredRole = 'finance';
    } else if (nfa.status === 'pending_director_approval' || nfa.status === 'pending_higher_approval') {
      level = 4;
      requiredRole = ['director', 'finance'];
    } else {
      return { error: 409 as const, msg: `NFA in status '${nfa.status}' is not awaiting review` };
    }

    const matchesRole = Array.isArray(requiredRole) ? requiredRole.includes(role) : role === requiredRole;
    if (!matchesRole && role !== 'super_admin') {
      const needed = Array.isArray(requiredRole) ? requiredRole.join(' or ') : requiredRole;
      return { error: 403 as const, msg: `This stage requires review by '${needed}'` };
    }

    if (role === 'hod' && req.user!.department_id !== nfa.department_id) {
      return { error: 403 as const, msg: 'You can only review NFAs in your own department' };
    }

    const approverUser = db.users.find((u) => u.id === req.user!.id);
    const sigFilename = approverUser?.signature_image || (fs.existsSync(path.join(signaturesDir, `${req.user!.id}.png`)) ? `${req.user!.id}.png` : undefined);

    db.approvals.push({
      id: uuid(),
      nfa_id: nfa.id,
      approver_role: role,
      approver_id: req.user!.id,
      approver_name: req.user!.name,
      decision: decision === 'approve' ? (level < 4 ? 'recommended' : 'approved') : decision,
      comments: comments || '',
      level,
      signature_image: decision === 'approve' ? sigFilename : undefined,
      created_at: new Date().toISOString(),
    });

    if (decision === 'reject') {
      releaseNfaReservation(db, nfa, { changed_by: req.user!.id, role, reason: comments || 'Proposal rejected during review' });
      nfa.status = 'rejected';
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null };
    }
    if (decision === 'revision_required') {
      releaseNfaReservation(db, nfa, { changed_by: req.user!.id, role, reason: comments || 'Revision requested by reviewer' });
      nfa.status = 'revision_required';
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null };
    }

    // decision === 'approve'
    if (level === 1) {
      // HOD recommended -> moves to Dean & Associate Dean (reservation maintained)
      nfa.status = 'dean_review';
      nfa.hod_name = req.user!.name;
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null };
    }

    if (level === 2) {
      // Dean recommended -> moves to Accounts Officer (reservation maintained)
      nfa.status = 'accounts_review';
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null };
    }

    if (level === 3) {
      // Accounts Officer validated -> moves to University Director (reservation maintained, no duplicate reservation)
      let line;
      try {
        line = findBudgetLine(db, nfa.department_id, nfa.financial_year_id, nfa.budget_category_id);
      } catch (e) {
        return { error: 400 as const, msg: (e as BudgetError).message };
      }
      const validation = validateBudget(line, nfa.total_amount);
      nfa.status = 'pending_director_approval';
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation, escalated: true };
    }

    // level === 4 (University Director) approving -> automatically changes to 'approved' and debits budget!
    if ((nfa.status as string) === 'approved') {
      return { error: 409 as const, msg: 'NFA is already approved. Cannot apply duplicate approval deduction.' };
    }
    let line;
    try {
      line = findBudgetLine(db, nfa.department_id, nfa.financial_year_id, nfa.budget_category_id);
    } catch (e) {
      return { error: 400 as const, msg: (e as BudgetError).message };
    }
    applyNewApproval(db, line.id, nfa.total_amount, {
      nfa_id: nfa.id,
      project_id: nfa.project_id,
      changed_by: req.user!.id,
      role,
      department_id: nfa.department_id,
    });
    nfa.status = 'approved';
    nfa.updated_at = new Date().toISOString();
    return { nfa, validation: null, escalated: false };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });
  res.json({
    ...result.nfa,
    items: withItems(result.nfa!.id),
    approvals: withApprovals(result.nfa!.id),
    validation: result.validation,
  });
});

/**
 * POST /api/nfas/:id/finance-decision — Alias for Director / Accounts decision on pending_director_approval
 */
nfasRouter.post('/:id/finance-decision', requireRole('director', 'finance', 'super_admin'), async (req: AuthedRequest, res) => {
  const { decision, comments } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });

  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id);
    if (!nfa) return { error: 404 as const, msg: 'NFA not found' };
    if ((nfa.status as string) === 'approved') {
      return { error: 409 as const, msg: 'NFA is already approved. Cannot apply duplicate approval deduction.' };
    }
    if (!['pending_director_approval', 'pending_higher_approval'].includes(nfa.status)) {
      return { error: 409 as const, msg: 'NFA is not pending Director approval' };
    }

    db.approvals.push({
      id: uuid(),
      nfa_id: nfa.id,
      approver_role: req.user!.role,
      approver_id: req.user!.id,
      approver_name: req.user!.name,
      decision: decision === 'approve' ? 'approved' : 'rejected',
      comments: comments || '',
      level: 4,
      created_at: new Date().toISOString(),
    });

    const line = findBudgetLine(db, nfa.department_id, nfa.financial_year_id, nfa.budget_category_id);

    if (decision === 'reject') {
      releaseNfaReservation(db, nfa, { changed_by: req.user!.id, role: req.user!.role, reason: comments || 'Rejected by Director' });
      nfa.status = 'rejected';
      nfa.updated_at = new Date().toISOString();
      return { nfa };
    }

    applyNewApproval(db, line.id, nfa.total_amount, {
      nfa_id: nfa.id,
      project_id: nfa.project_id,
      changed_by: req.user!.id,
      role: req.user!.role,
      department_id: nfa.department_id,
    });
    nfa.status = 'approved';
    nfa.updated_at = new Date().toISOString();
    return { nfa };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });
  res.json({ ...result.nfa, items: withItems(result.nfa!.id), approvals: withApprovals(result.nfa!.id) });
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
      nfa.status = 'pending_higher_approval';
      nfa.pending_revision_amount = new_total_amount;
      nfa.pending_revision_reason = reason;
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
