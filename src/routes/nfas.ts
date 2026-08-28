import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { store } from '../store.js';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth.js';
import {
  findBudgetLine,
  validateBudget,
  applyNewApproval,
  reviseApprovedAmount,
  finalizePendingRevision,
  BudgetError,
} from '../lib/budgetEngine.js';
import { renderNfaPdf } from '../lib/pdf.js';
import type { NfaStatus } from '../types.js';

export const nfasRouter = Router();
nfasRouter.use(requireAuth);

function withItems(nfaId: string) {
  return store.data.nfa_items.filter((i) => i.nfa_id === nfaId).sort((a, b) => a.sl_no - b.sl_no);
}

/** GET /api/nfas — role-scoped list */
nfasRouter.get('/', (req: AuthedRequest, res) => {
  let list = store.data.nfas;
  const { role, id, department_id } = req.user!;
  if (role === 'student') list = list.filter((n) => n.created_by === id);
  else if (role === 'faculty' || role === 'hod' || role === 'it_admin') list = list.filter((n) => n.department_id === department_id);
  // finance & super_admin see everything
  if (req.query.status) list = list.filter((n) => n.status === req.query.status);
  if (req.query.department) list = list.filter((n) => n.department_id === req.query.department);
  res.json(list.map((n) => ({ ...n, items: withItems(n.id) })));
});

/** GET /api/nfas/:id */
nfasRouter.get('/:id', (req, res) => {
  const nfa = store.data.nfas.find((n) => n.id === req.params.id);
  if (!nfa) return res.status(404).json({ error: 'NFA not found' });
  res.json({ ...nfa, items: withItems(nfa.id) });
});

/** GET /api/nfas/:id/pdf */
nfasRouter.get('/:id/pdf', (req, res) => {
  const nfa = store.data.nfas.find((n) => n.id === req.params.id);
  if (!nfa) return res.status(404).json({ error: 'NFA not found' });
  const dept = store.data.departments.find((d) => d.id === nfa.department_id)!;
  const cat = store.data.budget_categories.find((c) => c.id === nfa.budget_category_id)!;
  const project = store.data.projects.find((p) => p.id === nfa.project_id);
  const creator = store.data.users.find((u) => u.id === nfa.created_by);
  renderNfaPdf(res, { ...nfa, submitted_by_name: creator?.name || nfa.submitted_by_name, hod_name: dept.hod_name || nfa.hod_name }, withItems(nfa.id), dept, cat, project?.name);
});

/** DELETE /api/nfas/:id — remove an NFA and its draft data when authorized. */
nfasRouter.delete('/:id', async (req: AuthedRequest, res) => {
  const result = await store.transact((db) => {
    const nfa = db.nfas.find((item) => item.id === req.params.id);
    if (!nfa) return { error: 404 as const };
    const canDelete = req.user!.role === 'super_admin' || nfa.created_by === req.user!.id || (['faculty', 'hod'].includes(req.user!.role) && nfa.department_id === req.user!.department_id);
    if (!canDelete) return { error: 403 as const };
    db.nfas = db.nfas.filter((item) => item.id !== nfa.id);
    db.nfa_items = db.nfa_items.filter((item) => item.nfa_id !== nfa.id);
    db.approvals = db.approvals.filter((approval) => approval.nfa_id !== nfa.id);
    return { deleted: true };
  });
  if ('error' in result) return res.status(result.error).json({ error: result.error === 404 ? 'NFA not found' : 'Not authorized to delete this NFA' });
  res.json(result);
});

/**
 * POST /api/nfas — students and faculty can create (draft).
 * body: { project_id, department_id, financial_year_id, budget_category_id, title, purpose, description,
 *         justification, sdgs, items: [{particulars, quantity, amount}] }
 */
nfasRouter.post('/', requireRole('student', 'faculty', 'hod'), (req: AuthedRequest, res) => {
  const b = req.body || {};
  const required = ['project_id', 'department_id', 'financial_year_id', 'budget_category_id', 'title'];
  for (const f of required) if (!b[f]) return res.status(400).json({ error: `${f} is required` });

  const items = Array.isArray(b.items) ? b.items : [];
  const total = items.reduce((s: number, it: any) => s + (Number(it.amount) || 0), 0);
  const refNo = `NFA/CU/${b.department_id.slice(0, 4).toUpperCase()}/${new Date().getFullYear()}/${String(store.data.nfas.length + 1).padStart(3, '0')}`;

  const nfa = {
    id: uuid(),
    ref_no: refNo,
    project_id: b.project_id,
    department_id: b.department_id,
    financial_year_id: b.financial_year_id,
    budget_category_id: b.budget_category_id,
    title: b.title,
    purpose: b.purpose || '',
    description: b.description || '',
    justification: b.justification || '',
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
  };

  store.transact((db) => {
    db.nfas.push(nfa);
    items.forEach((it: any, i: number) => {
      db.nfa_items.push({ id: uuid(), nfa_id: nfa.id, sl_no: i + 1, particulars: it.particulars, quantity: it.quantity || '', rate: it.rate || '', amount: Number(it.amount) || 0, comments: it.comments || '', justification: it.justification || '', basis_of_budget: it.basis_of_budget || '', previous_year_budget: Number(it.previous_year_budget) || 0, previous_year_actual: Number(it.previous_year_actual) || 0 });
    });
  });

  res.status(201).json({ ...nfa, items: withItems(nfa.id) });
});

/** PUT /api/nfas/:id — edit while draft or revision_required (creator, or faculty/hod of that dept) */
nfasRouter.put('/:id', async (req: AuthedRequest, res) => {
  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id);
    if (!nfa) return { error: 404 as const };
    if (!['draft', 'revision_required'].includes(nfa.status)) return { error: 'locked' as const };
    const isOwner = nfa.created_by === req.user!.id;
    const isDeptStaff = ['faculty', 'hod'].includes(req.user!.role) && req.user!.department_id === nfa.department_id;
    if (!isOwner && !isDeptStaff && req.user!.role !== 'super_admin') return { error: 403 as const };

    const b = req.body || {};
    ['title', 'purpose', 'description', 'justification', 'sdgs', 'requirements', 'budget_category_id', 'submitted_by_name', 'submitted_by_designation'].forEach((f) => {
      if (b[f] !== undefined) (nfa as any)[f] = b[f];
    });
    if (Array.isArray(b.items)) {
      // replace items
      db.nfa_items = db.nfa_items.filter((i) => i.nfa_id !== nfa.id);
      b.items.forEach((it: any, i: number) => {
        db.nfa_items.push({ id: uuid(), nfa_id: nfa.id, sl_no: i + 1, particulars: it.particulars, quantity: it.quantity || '', rate: it.rate || '', amount: Number(it.amount) || 0, comments: it.comments || '', justification: it.justification || '', basis_of_budget: it.basis_of_budget || '', previous_year_budget: Number(it.previous_year_budget) || 0, previous_year_actual: Number(it.previous_year_actual) || 0 });
      });
      nfa.total_amount = b.items.reduce((s: number, it: any) => s + (Number(it.amount) || 0), 0);
    }
    nfa.status = 'draft';
    nfa.updated_at = new Date().toISOString();
    return { nfa };
  });
  if ('error' in result) {
    if (result.error === 404) return res.status(404).json({ error: 'NFA not found' });
    if (result.error === 'locked') return res.status(409).json({ error: 'NFA can only be edited while draft or revision_required' });
    return res.status(403).json({ error: 'Not authorized to edit this NFA' });
  }
  res.json({ ...result.nfa, items: withItems(result.nfa!.id) });
});

/** POST /api/nfas/:id/submit — creator submits draft for review */
nfasRouter.post('/:id/submit', async (req: AuthedRequest, res) => {
  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id);
    if (!nfa) return { error: 404 as const };
    if (nfa.created_by !== req.user!.id && req.user!.role !== 'super_admin') return { error: 403 as const };
    if (!['draft', 'revision_required'].includes(nfa.status)) return { error: 'bad_status' as const };
    if (db.nfa_items.filter((i) => i.nfa_id === nfa.id).length === 0) return { error: 'no_items' as const };
    nfa.status = 'submitted';
    nfa.updated_at = new Date().toISOString();
    return { nfa };
  });
  if ('error' in result) {
    const map: Record<string, [number, string]> = {
      404: [404, 'NFA not found'],
      403: [403, 'Only the creator can submit this NFA'],
      bad_status: [409, 'NFA is not in a submittable state'],
      no_items: [400, 'Add at least one budget item before submitting'],
    };
    const [code, msg] = map[result.error];
    return res.status(code).json({ error: msg });
  }
  res.json({ ...result.nfa, items: withItems(result.nfa!.id) });
});

/**
 * POST /api/nfas/:id/review — the unified review action for faculty (level 1) and HOD (level 2).
 * body: { decision: 'approve' | 'reject' | 'revision_required', comments }
 *
 * Faculty approve on a 'submitted' NFA -> 'under_review' (now awaiting HOD).
 * HOD approve on an 'under_review' NFA -> runs budget validation:
 *    sufficient & under threshold -> auto-applied, status 'approved', master budget updated
 *    insufficient or over threshold -> status 'pending_higher_approval' (awaiting Finance)
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
    if (nfa.status === 'submitted') level = 1;
    else if (nfa.status === 'under_review') level = 2;
    else return { error: 409 as const, msg: `NFA in status '${nfa.status}' is not awaiting review` };

    const requiredRole = level === 1 ? 'faculty' : 'hod';
    if (role !== requiredRole && role !== 'super_admin') {
      return { error: 403 as const, msg: `This NFA requires review by role '${requiredRole}' at this stage` };
    }
    if (['faculty', 'hod'].includes(role) && req.user!.department_id !== nfa.department_id) {
      return { error: 403 as const, msg: 'You can only review NFAs in your own department' };
    }

    db.approvals.push({
      id: uuid(),
      nfa_id: nfa.id,
      approver_role: role,
      approver_id: req.user!.id,
      decision: decision === 'approve' ? (level === 1 ? 'recommended' : 'approved') : decision,
      comments: comments || '',
      level,
      created_at: new Date().toISOString(),
    });

    if (decision === 'reject') {
      nfa.status = 'rejected';
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null };
    }
    if (decision === 'revision_required') {
      nfa.status = 'revision_required';
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null };
    }

    // decision === 'approve'
    if (level === 1) {
      nfa.status = 'under_review';
      nfa.hod_name = req.user!.name;
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null };
    }

    // level 2 (HOD) approving -> run budget validation now
    let line;
    try {
      line = findBudgetLine(db, nfa.department_id, nfa.financial_year_id, nfa.budget_category_id);
    } catch (e) {
      return { error: 400 as const, msg: (e as BudgetError).message };
    }
    const validation = validateBudget(line, nfa.total_amount);
    nfa.status = 'budget_validation';
    nfa.updated_at = new Date().toISOString();

    if (validation.higherApprovalRequired) {
      nfa.status = 'pending_higher_approval';
      line.pending_amount += nfa.total_amount;
      return { nfa, validation, escalated: true };
    }

    applyNewApproval(db, line.id, nfa.total_amount, {
      nfa_id: nfa.id,
      project_id: nfa.project_id,
      changed_by: req.user!.id,
      role,
      department_id: nfa.department_id,
    });
    nfa.status = 'approved';
    return { nfa, validation, escalated: false };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });
  res.json({ ...result.nfa, items: withItems(result.nfa!.id), validation: result.validation, escalated: (result as any).escalated || false });
});

/**
 * POST /api/nfas/:id/finance-decision — Finance's final call on a 'pending_higher_approval' NFA
 * (either a first-time budget-exceeded approval, or a large revision to an approved NFA).
 * body: { decision: 'approve' | 'reject', comments }
 */
nfasRouter.post('/:id/finance-decision', requireRole('finance', 'super_admin'), async (req: AuthedRequest, res) => {
  const { decision, comments } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });

  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id);
    if (!nfa) return { error: 404 as const, msg: 'NFA not found' };
    if (nfa.status !== 'pending_higher_approval') return { error: 409 as const, msg: 'NFA is not pending higher approval' };

    db.approvals.push({
      id: uuid(),
      nfa_id: nfa.id,
      approver_role: 'finance',
      approver_id: req.user!.id,
      decision: decision === 'approve' ? 'approved' : 'rejected',
      comments: comments || '',
      level: 3,
      created_at: new Date().toISOString(),
    });

    const line = findBudgetLine(db, nfa.department_id, nfa.financial_year_id, nfa.budget_category_id);
    const isRevision = nfa.pending_revision_amount !== undefined;

    if (decision === 'reject') {
      const staged = isRevision ? (nfa.pending_revision_amount! - nfa.total_amount) : nfa.total_amount;
      line.pending_amount = Math.max(0, line.pending_amount - staged);
      nfa.status = isRevision ? 'approved' : 'rejected';
      nfa.pending_revision_amount = undefined;
      nfa.pending_revision_reason = undefined;
      nfa.updated_at = new Date().toISOString();
      return { nfa };
    }

    if (isRevision) {
      const difference = nfa.pending_revision_amount! - nfa.total_amount;
      finalizePendingRevision(db, line.id, difference, {
        nfa_id: nfa.id,
        project_id: nfa.project_id,
        changed_by: req.user!.id,
        role: 'finance',
        department_id: nfa.department_id,
        reason: nfa.pending_revision_reason || 'Revision',
      });
      nfa.total_amount = nfa.pending_revision_amount!;
      nfa.pending_revision_amount = undefined;
      nfa.pending_revision_reason = undefined;
      nfa.status = 'approved';
    } else {
      applyNewApproval(db, line.id, nfa.total_amount, {
        nfa_id: nfa.id,
        project_id: nfa.project_id,
        changed_by: req.user!.id,
        role: 'finance',
        department_id: nfa.department_id,
      });
      nfa.status = 'approved';
    }
    nfa.updated_at = new Date().toISOString();
    return { nfa };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });
  res.json({ ...result.nfa, items: withItems(result.nfa!.id) });
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
