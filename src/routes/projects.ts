import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { store } from '../store.js';
import { requireAuth, AuthedRequest } from '../middleware/auth.js';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

/** GET /api/projects?department=&fy= */
projectsRouter.get('/', (req: AuthedRequest, res) => {
  let list = store.data.projects;
  if (req.query.department) list = list.filter((p) => p.department_id === req.query.department);
  if (req.query.fy) list = list.filter((p) => p.financial_year_id === req.query.fy);
  // Students only see their own projects
  if (req.user!.role === 'student') list = list.filter((p) => p.created_by === req.user!.id);
  if (req.user!.role === 'faculty') list = list.filter((p) => p.assigned_faculty_id === req.user!.id || p.created_by === req.user!.id);
  const withNfas = list.map((p) => ({
    ...p,
    nfas: store.data.nfas.filter((n) => n.project_id === p.id).map((n) => ({ id: n.id, ref_no: n.ref_no, status: n.status, total_amount: n.total_amount })),
  }));
  res.json(withNfas);
});

/** GET /api/projects/faculty — faculty available for HOD assignment. */
projectsRouter.get('/faculty', (req: AuthedRequest, res) => {
  if (!['hod', 'super_admin'].includes(req.user!.role)) return res.status(403).json({ error: 'Only HOD or admin can assign faculty' });
  const departmentId = String(req.query.department || req.user!.department_id || '');
  res.json(store.data.users.filter((user) => user.role === 'faculty' && user.department_id === departmentId).map(({ id, name, email }) => ({ id, name, email })));
});

/** POST /api/projects — any authenticated user can propose a project; it's inert until an NFA on it is approved */
projectsRouter.post('/', (req: AuthedRequest, res) => {
  const { name, department_id, financial_year_id, budget_category_id, description, budget_amount, remarks, assigned_faculty_id } = req.body || {};
  if (!name || !department_id || !financial_year_id || !budget_category_id) {
    return res.status(400).json({ error: 'name, department_id, financial_year_id, budget_category_id are required' });
  }
  if (req.user!.role === 'faculty' && department_id !== req.user!.department_id) return res.status(403).json({ error: 'Faculty can only create projects in their department' });
  const project = {
    id: uuid(),
    name,
    department_id,
    financial_year_id,
    budget_category_id,
    created_by: req.user!.id,
    status: 'active' as const,
    created_at: new Date().toISOString(),
    description: description || '', budget_amount: Number(budget_amount) || 0, remarks: remarks || '', assigned_faculty_id: req.user!.role === 'faculty' ? req.user!.id : (assigned_faculty_id || null),
  };
  store.transact((db) => {
    db.projects.push(project);
    const line = db.department_budgets.find((budget) => budget.department_id === department_id && budget.financial_year_id === financial_year_id && budget.budget_category_id === budget_category_id);
    if (line) {
      if (project.assigned_faculty_id && req.user!.role === 'faculty') line.pending_amount += project.budget_amount || 0;
      else line.approved_amount += project.budget_amount || 0;
    }
    db.budget_changes.push({ id: uuid(), version: db.budget_changes.length + 1, financial_year_id, department_id, project_id: project.id, changed_by: req.user!.id, action: 'Project added', previous_value: '', new_value: String(project.budget_amount), description: `New project added: ${name}`, approval_status: req.user!.role === 'faculty' ? 'pending' : 'approved', created_at: project.created_at });
  });
  res.status(201).json(project);
});

/** PUT /api/projects/:id */
projectsRouter.put('/:id', async (req: AuthedRequest, res) => {
  const result = await store.transact((db) => {
    const p = db.projects.find((x) => x.id === req.params.id);
    if (!p) return { error: 404 as const };
    const isManager = ['hod', 'super_admin'].includes(req.user!.role);
    const isOwner = p.created_by === req.user!.id || (req.user!.role === 'faculty' && p.assigned_faculty_id === req.user!.id);
    if (!isManager && !isOwner) return { error: 403 as const };
    const before = JSON.stringify({ name: p.name, budget_amount: p.budget_amount, description: p.description, remarks: p.remarks, assigned_faculty_id: p.assigned_faculty_id });
    const oldAmount = p.budget_amount || 0;
    const fields = ['name', 'description', 'budget_amount', 'remarks'] as const;
    fields.forEach((field) => { if (req.body?.[field] !== undefined) (p as any)[field] = field === 'budget_amount' ? Number(req.body[field]) || 0 : String(req.body[field]); });
    if (isManager && req.body?.assigned_faculty_id !== undefined) p.assigned_faculty_id = req.body.assigned_faculty_id || null;
    const line = db.department_budgets.find((budget) => budget.department_id === p.department_id && budget.financial_year_id === p.financial_year_id && budget.budget_category_id === p.budget_category_id);
    if (line && p.budget_amount !== oldAmount) {
      const difference = (p.budget_amount || 0) - oldAmount;
      if (req.user!.role === 'faculty') line.pending_amount += difference;
      else line.approved_amount += difference;
    }
    db.budget_changes.push({ id: uuid(), version: db.budget_changes.length + 1, financial_year_id: p.financial_year_id, department_id: p.department_id, project_id: p.id, changed_by: req.user!.id, action: 'Project updated', previous_value: before, new_value: JSON.stringify(p), description: `Project ${p.name} updated`, approval_status: req.user!.role === 'faculty' ? 'pending' : 'approved', created_at: new Date().toISOString() });
    return { project: p };
  });
  if ('error' in result) return res.status(result.error).json({ error: result.error === 404 ? 'Project not found' : 'Not authorized to update this project' });
  res.json(result.project);
});

/** DELETE /api/projects/:id — delete a project and its NFAs when authorized. */
projectsRouter.delete('/:id', async (req: AuthedRequest, res) => {
  const result = await store.transact((db) => {
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) return { error: 404 as const };
    const canDelete = req.user!.role === 'super_admin' || project.created_by === req.user!.id || (['faculty', 'hod'].includes(req.user!.role) && project.department_id === req.user!.department_id);
    if (!canDelete) return { error: 403 as const };
    const nfaIds = db.nfas.filter((n) => n.project_id === project.id).map((n) => n.id);
    db.projects = db.projects.filter((p) => p.id !== project.id);
    db.nfas = db.nfas.filter((n) => n.project_id !== project.id);
    db.nfa_items = db.nfa_items.filter((item) => !nfaIds.includes(item.nfa_id));
    db.approvals = db.approvals.filter((approval) => !nfaIds.includes(approval.nfa_id));
    return { deleted: true };
  });
  if ('error' in result) return res.status(result.error).json({ error: result.error === 404 ? 'Project not found' : 'Not authorized to delete this project' });
  res.json(result);
});
