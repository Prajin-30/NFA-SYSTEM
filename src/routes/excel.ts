import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { store } from '../store.js';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth.js';
import { inspectExcelWorkbook, parseExcelDiff } from '../lib/excel.js';
import { findBudgetLine, reviseApprovedAmount } from '../lib/budgetEngine.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const excelRouter = Router();
excelRouter.use(requireAuth);
const upload = multer({ storage: multer.memoryStorage() });
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'budget-uploads');

/** POST /api/budgets/upload — save an original year budget without overwriting it. */
excelRouter.post('/upload', requireRole('hod', 'super_admin'), upload.single('file'), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const { department_id, financial_year_id } = req.body || {};
  if (!department_id || !financial_year_id) return res.status(400).json({ error: 'department_id and financial_year_id are required' });
  if (req.user!.role === 'hod' && department_id !== req.user!.department_id) return res.status(403).json({ error: 'HOD can only upload the budget for their department' });
  const id = uuid();
  const storedFilename = `${id}-${path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, storedFilename), req.file.buffer);
  const record = { id, financial_year_id, department_id, filename: req.file.originalname, stored_filename: storedFilename, uploaded_by: req.user!.id, uploaded_at: new Date().toISOString(), status: 'original' as const };
  await store.transact((db) => {
    db.budget_uploads.push(record);
    db.budget_changes.push({ id: uuid(), version: db.budget_changes.length + 1, financial_year_id, department_id, project_id: null, changed_by: req.user!.id, action: 'Original budget uploaded', previous_value: '', new_value: req.file!.originalname, description: `Original budget uploaded by HOD: ${req.file!.originalname}`, approval_status: 'original', created_at: record.uploaded_at });
  });
  res.status(201).json(record);
});

/** GET /api/budgets/uploads — original workbooks and version history. */
excelRouter.get('/uploads', (req: AuthedRequest, res) => {
  let uploads = store.data.budget_uploads;
  let changes = store.data.budget_changes;
  if (req.query.department) {
    uploads = uploads.filter((item) => item.department_id === req.query.department);
    changes = changes.filter((item) => item.department_id === req.query.department);
  }
  if (req.query.fy) {
    uploads = uploads.filter((item) => item.financial_year_id === req.query.fy);
    changes = changes.filter((item) => item.financial_year_id === req.query.fy);
  }
  res.json({ uploads, changes });
});

/**
 * POST /api/budgets/import/preview — step 1: upload, detect changes, DO NOT write to DB yet.
 * Requirement #13/#14/#15: authorized sync only, central DB stays source of truth until confirmed.
 */
excelRouter.post('/import/preview', requireRole('faculty', 'hod', 'super_admin'), upload.single('file'), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (multipart/form-data, field name "file")' });
  const { department_id, financial_year_id } = req.body;
  if (!department_id || !financial_year_id) return res.status(400).json({ error: 'department_id and financial_year_id are required' });

  try {
    const sheets = await inspectExcelWorkbook(req.file.buffer);
    const diffs = await parseExcelDiff(req.file.buffer, store.data, department_id, financial_year_id);
    const record = {
      id: uuid(),
      financial_year_id,
      department_id,
      filename: req.file.originalname,
      status: 'pending_review' as const,
      diff_json: JSON.stringify(diffs),
      created_by: req.user!.id,
      created_at: new Date().toISOString(),
    };
    await store.transact((db) => db.excel_sync_records.push(record));
    res.json({ sync_record_id: record.id, sheets, diffs });
  } catch (e: any) {
    res.status(400).json({ error: e.message || 'Failed to parse workbook' });
  }
});

/**
 * POST /api/budgets/import/confirm/:syncId — step 2: apply the previewed diff to the central DB.
 * Each changed item goes through the same difference-calculating budget engine as a manual portal edit.
 */
excelRouter.post('/import/confirm/:syncId', requireRole('faculty', 'hod', 'super_admin'), async (req: AuthedRequest, res) => {
  const result = await store.transact((db) => {
    const record = db.excel_sync_records.find((r) => r.id === req.params.syncId);
    if (!record) return { error: 404 as const, msg: 'Sync record not found' };
    if (record.status !== 'pending_review') return { error: 409 as const, msg: 'This sync record has already been resolved' };

    const diffs: any[] = JSON.parse(record.diff_json);
    const applied: any[] = [];
    for (const d of diffs) {
      if (!d.matched_nfa_id) continue; // new unmatched rows are reported but require creating an NFA through the normal flow, not silently created
      const nfa = db.nfas.find((n) => n.id === d.matched_nfa_id);
      if (!nfa || nfa.status !== 'approved') continue;
      const line = findBudgetLine(db, nfa.department_id, nfa.financial_year_id, nfa.budget_category_id);
      const outcome = reviseApprovedAmount(db, line.id, d.old_amount, d.new_amount, {
        nfa_id: nfa.id,
        project_id: nfa.project_id,
        changed_by: req.user!.id,
        role: req.user!.role,
        department_id: nfa.department_id,
        reason: `Excel synchronization (${record.filename}): ${d.particulars}`,
        source: 'excel',
      });
      if (outcome.status === 'approved') {
        nfa.total_amount = nfa.total_amount - d.old_amount + d.new_amount;
        const item = db.nfa_items.find((i) => i.nfa_id === nfa.id && i.particulars.trim().toLowerCase() === d.particulars.trim().toLowerCase());
        if (item) item.amount = d.new_amount;
      } else {
        nfa.status = 'pending_higher_approval';
        nfa.pending_revision_amount = nfa.total_amount - d.old_amount + d.new_amount;
        nfa.pending_revision_reason = `Excel synchronization (${record.filename}): ${d.particulars}`;
      }
      applied.push({ ...d, status: outcome.status });
    }
    record.status = 'confirmed';
    db.audit_logs.push({
      id: uuid(),
      entity_type: 'excel_sync',
      entity_id: record.id,
      department_id: record.department_id,
      old_amount: null,
      new_amount: null,
      difference: null,
      changed_by: req.user!.id,
      role: req.user!.role,
      reason: `Confirmed Excel sync of ${record.filename}: ${applied.length} item(s) updated`,
      source: 'excel',
      approval_status: 'confirmed',
      created_at: new Date().toISOString(),
    });
    return { applied };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });
  res.json({ applied: result.applied });
});

/** GET /api/budgets/import/records?department= */
excelRouter.get('/import/records', (req: AuthedRequest, res) => {
  let list = store.data.excel_sync_records;
  if (req.query.department) list = list.filter((r) => r.department_id === req.query.department);
  res.json(list.map((r) => ({ ...r, diff: JSON.parse(r.diff_json) })));
});
