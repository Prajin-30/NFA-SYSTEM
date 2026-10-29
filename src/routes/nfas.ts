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
import type { NfaStatus, Role } from '../types.js';

export const nfasRouter = Router();
nfasRouter.use(requireAuth);

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

/** GET /api/nfas — role-scoped list */
nfasRouter.get('/', (req: AuthedRequest, res) => {
  let list = store.data.nfas;
  const { role, id, department_id } = req.user!;
  if (role === 'faculty') list = list.filter((n) => n.created_by === id || n.department_id === department_id);
  else if (role === 'hod' || role === 'it_admin') list = list.filter((n) => n.department_id === department_id);
  // dean, associate_dean, director, finance, super_admin see all departments
  if (req.query.status) list = list.filter((n) => n.status === req.query.status);
  if (req.query.department) list = list.filter((n) => n.department_id === req.query.department);
  res.json(list.map((n) => ({ ...n, items: withItems(n.id), approvals: withApprovals(n.id) })));
});

/** GET /api/nfas/next-ref — generate auto reference number */
nfasRouter.get('/next-ref', (req: AuthedRequest, res) => {
  const deptId = String(req.query.department_id || req.user?.department_id || '');
  const fyId = String(req.query.financial_year_id || store.data.financial_years.find((f) => f.is_active)?.id || '');
  const dept = store.data.departments.find((d) => d.id === deptId);
  const fy = store.data.financial_years.find((f) => f.id === fyId);
  const deptCode = dept ? dept.code : 'GEN';
  const fyLabel = fy ? fy.label : String(new Date().getFullYear());
  const count = store.data.nfas.filter((n) => !deptId || n.department_id === deptId).length;
  const seq = String(count + 1).padStart(4, '0');
  res.json({ ref_no: `NFA/${deptCode}/${fyLabel}/${seq}` });
});

/** GET /api/nfas/:id */
nfasRouter.get('/:id', (req, res) => {
  const nfa = store.data.nfas.find((n) => n.id === req.params.id);
  if (!nfa) return res.status(404).json({ error: 'NFA not found' });
  res.json({ ...nfa, items: withItems(nfa.id), approvals: withApprovals(nfa.id) });
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

  const items = Array.isArray(b.items) ? b.items : [];
  const total = items.reduce((s: number, it: any) => s + (Number(it.amount) || 0), 0);

  // Auto reference number calculation
  let refNo = b.ref_no;
  if (!refNo || refNo.trim() === '') {
    const dept = store.data.departments.find((d) => d.id === targetDepartmentId);
    const fy = store.data.financial_years.find((f) => f.id === b.financial_year_id);
    const deptCode = dept ? dept.code : 'GEN';
    const fyLabel = fy ? fy.label : String(new Date().getFullYear());
    const count = store.data.nfas.filter((n) => n.department_id === targetDepartmentId).length;
    refNo = `NFA/${deptCode}/${fyLabel}/${String(count + 1).padStart(4, '0')}`;
  }

  const nfa = {
    id: uuid(),
    ref_no: refNo,
    project_id: b.project_id || null, // Project is optional!
    department_id: targetDepartmentId,
    financial_year_id: b.financial_year_id,
    budget_category_id: b.budget_category_id,
    budget_subcategory_id: b.budget_subcategory_id || null,
    budget_subcategory_name: b.budget_subcategory_name || '',
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
      db.nfa_items.push({
        id: uuid(),
        nfa_id: nfa.id,
        sl_no: i + 1,
        particulars: it.particulars,
        quantity: it.quantity || '',
        rate: it.rate || '',
        amount: Number(it.amount) || 0,
        comments: it.comments || '',
        justification: it.justification || '',
        basis_of_budget: it.basis_of_budget || '',
        previous_year_budget: Number(it.previous_year_budget) || 0,
        previous_year_actual: Number(it.previous_year_actual) || 0,
      });
    });
  });

  res.status(201).json({ ...nfa, items: withItems(nfa.id) });
});

/**
 * PUT /api/nfas/:id — Edit NFA:
 * - Faculty (proposer) can edit while draft, revision_required, or submitted
 * - HOD can review & edit while submitted
 * - Dean & Associate Dean can review & edit while dean_review
 * - Super admin can edit anytime
 */
nfasRouter.put('/:id', async (req: AuthedRequest, res) => {
  const result = await store.transact((db) => {
    const nfa = db.nfas.find((n) => n.id === req.params.id);
    if (!nfa) return { error: 404 as const };

    const isOwner = nfa.created_by === req.user!.id;
    const isHod = req.user!.role === 'hod' && req.user!.department_id === nfa.department_id && ['submitted', 'under_review'].includes(nfa.status);
    const isDean = ['dean', 'associate_dean'].includes(req.user!.role) && ['under_review', 'dean_review'].includes(nfa.status);
    const isSuperAdmin = req.user!.role === 'super_admin';
    const canOwnerEdit = isOwner && ['draft', 'revision_required', 'submitted'].includes(nfa.status);

    if (!canOwnerEdit && !isHod && !isDean && !isSuperAdmin) {
      return { error: 403 as const };
    }

    const b = req.body || {};
    [
      'title',
      'purpose',
      'description',
      'justification',
      'sdgs',
      'requirements',
      'budget_category_id',
      'budget_subcategory_id',
      'budget_subcategory_name',
      'submitted_by_name',
      'submitted_by_designation',
    ].forEach((f) => {
      if (b[f] !== undefined) (nfa as any)[f] = b[f];
    });

    if (Array.isArray(b.items)) {
      db.nfa_items = db.nfa_items.filter((i) => i.nfa_id !== nfa.id);
      b.items.forEach((it: any, i: number) => {
        db.nfa_items.push({
          id: uuid(),
          nfa_id: nfa.id,
          sl_no: i + 1,
          particulars: it.particulars,
          quantity: it.quantity || '',
          rate: it.rate || '',
          amount: Number(it.amount) || 0,
          comments: it.comments || '',
          justification: it.justification || '',
          basis_of_budget: it.basis_of_budget || '',
          previous_year_budget: Number(it.previous_year_budget) || 0,
          previous_year_actual: Number(it.previous_year_actual) || 0,
        });
      });
      nfa.total_amount = b.items.reduce((s: number, it: any) => s + (Number(it.amount) || 0), 0);
    }

    if (nfa.status === 'revision_required' && isOwner) {
      nfa.status = 'draft';
    }
    nfa.updated_at = new Date().toISOString();
    return { nfa };
  });

  if ('error' in result) {
    if (result.error === 404) return res.status(404).json({ error: 'NFA not found' });
    return res.status(403).json({ error: 'Not authorized to edit this NFA at current stage' });
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
    if (db.nfa_items.filter((i) => i.nfa_id === nfa.id).length === 0) return { error: 'no_items' as const };

    // Submitting draft always moves to HOD review (submitted)
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

    db.approvals.push({
      id: uuid(),
      nfa_id: nfa.id,
      approver_role: role,
      approver_id: req.user!.id,
      approver_name: req.user!.name,
      decision: decision === 'approve' ? (level < 4 ? 'recommended' : 'approved') : decision,
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
      // HOD recommended -> moves to Dean & Associate Dean
      nfa.status = 'dean_review';
      nfa.hod_name = req.user!.name;
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null };
    }

    if (level === 2) {
      // Dean recommended -> moves to Accounts Officer
      nfa.status = 'accounts_review';
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation: null };
    }

    if (level === 3) {
      // Accounts Officer validated -> stages budget & moves to University Director
      let line;
      try {
        line = findBudgetLine(db, nfa.department_id, nfa.financial_year_id, nfa.budget_category_id);
      } catch (e) {
        return { error: 400 as const, msg: (e as BudgetError).message };
      }
      const validation = validateBudget(line, nfa.total_amount);
      line.pending_amount += nfa.total_amount;
      if (nfa.budget_subcategory_id && db.budget_subcategories) {
        const subcat = db.budget_subcategories.find((s) => s.id === nfa.budget_subcategory_id);
        if (subcat) subcat.pending_amount += nfa.total_amount;
      }
      nfa.status = 'pending_director_approval';
      nfa.updated_at = new Date().toISOString();
      return { nfa, validation, escalated: true };
    }

    // level === 4 (University Director) approving -> automatically changes to 'approved' and debits budget!
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
      line.pending_amount = Math.max(0, line.pending_amount - nfa.total_amount);
      if (nfa.budget_subcategory_id && db.budget_subcategories) {
        const subcat = db.budget_subcategories.find((s) => s.id === nfa.budget_subcategory_id);
        if (subcat) subcat.pending_amount = Math.max(0, subcat.pending_amount - nfa.total_amount);
      }
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
