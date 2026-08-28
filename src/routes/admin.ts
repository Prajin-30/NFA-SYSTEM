import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { store } from '../store.js';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('super_admin'));

/** POST /api/admin/financial-years — requirement #21: add new financial years without code changes */
adminRouter.post('/financial-years', async (req, res) => {
  const { label } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label is required, e.g. "2027-28"' });
  const fy = { id: uuid(), label, is_active: false };
  await store.transact((db) => db.financial_years.push(fy));
  res.status(201).json(fy);
});

/** PUT /api/admin/financial-years/:id/activate */
adminRouter.put('/financial-years/:id/activate', async (req, res) => {
  await store.transact((db) => db.financial_years.forEach((f) => (f.is_active = f.id === req.params.id)));
  res.json(store.data.financial_years);
});

/** POST /api/admin/departments */
adminRouter.post('/departments', async (req, res) => {
  const { name, code, hod_name, dean_name, faculty_name, associate_dean_name, director_name, finance_officer_name } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
  const dept = { id: uuid(), name, code, hod_name, dean_name, faculty_name, associate_dean_name, director_name, finance_officer_name };
  await store.transact((db) => db.departments.push(dept));
  res.status(201).json(dept);
});

/** PUT /api/admin/departments/:id — update department and approval signer names. */
adminRouter.put('/departments/:id', async (req, res) => {
  const { name, code, hod_name, dean_name, faculty_name, associate_dean_name, director_name, finance_officer_name } = req.body || {};
  const updated = await store.transact((db) => {
    const dept = db.departments.find((d) => d.id === req.params.id);
    if (!dept) return null;
    if (name !== undefined) dept.name = String(name).trim();
    if (code !== undefined) dept.code = String(code).trim();
    if (hod_name !== undefined) dept.hod_name = String(hod_name).trim();
    if (dean_name !== undefined) dept.dean_name = String(dean_name).trim();
    if (faculty_name !== undefined) dept.faculty_name = String(faculty_name).trim();
    if (associate_dean_name !== undefined) dept.associate_dean_name = String(associate_dean_name).trim();
    if (director_name !== undefined) dept.director_name = String(director_name).trim();
    if (finance_officer_name !== undefined) dept.finance_officer_name = String(finance_officer_name).trim();
    return dept;
  });
  if (!updated) return res.status(404).json({ error: 'Department not found' });
  res.json(updated);
});

/** POST /api/admin/budget-types */
adminRouter.post('/budget-types', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const bt = { id: uuid(), name };
  await store.transact((db) => db.budget_types.push(bt));
  res.status(201).json(bt);
});

/** POST /api/admin/budget-categories */
adminRouter.post('/budget-categories', async (req, res) => {
  const { budget_type_id, name } = req.body || {};
  if (!budget_type_id || !name) return res.status(400).json({ error: 'budget_type_id and name are required' });
  const cat = { id: uuid(), budget_type_id, name };
  await store.transact((db) => db.budget_categories.push(cat));
  res.status(201).json(cat);
});

/**
 * POST /api/admin/department-budgets — allocate a category's budget for a dept/FY.
 * This is how a new financial year's allocations get set up (requirement #21).
 */
adminRouter.post('/department-budgets', async (req, res) => {
  const { department_id, financial_year_id, budget_category_id, allocated_amount } = req.body || {};
  if (!department_id || !financial_year_id || !budget_category_id || typeof allocated_amount !== 'number') {
    return res.status(400).json({ error: 'department_id, financial_year_id, budget_category_id, allocated_amount are required' });
  }
  const line = { id: uuid(), department_id, financial_year_id, budget_category_id, allocated_amount, approved_amount: 0, pending_amount: 0, revised_amount: 0 };
  await store.transact((db) => db.department_budgets.push(line));
  res.status(201).json(line);
});

/** POST /api/admin/users — create faculty/hod/finance/student/it_admin accounts */
adminRouter.post('/users', async (req, res) => {
  const { name, email, password, role, department_id } = req.body || {};
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'name, email, password, role are required' });
  if (store.data.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email already in use' });
  const user = { id: uuid(), name, email, password_hash: bcrypt.hashSync(password, 8), role, department_id: department_id || null, created_at: new Date().toISOString() };
  await store.transact((db) => db.users.push(user));
  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role, department_id: user.department_id });
});

/** PUT /api/admin/users/:id — update identity details without changing the user ID. */
adminRouter.put('/users/:id', async (req, res) => {
  const { name, email, password, role, department_id } = req.body || {};
  const updated = await store.transact((db) => {
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) return null;
    if (name !== undefined) user.name = String(name).trim();
    if (email !== undefined) {
      const normalizedEmail = String(email).trim().toLowerCase();
      if (db.users.some((u) => u.id !== user.id && u.email.toLowerCase() === normalizedEmail)) throw new Error('Email already in use');
      user.email = normalizedEmail;
    }
    if (password) user.password_hash = bcrypt.hashSync(String(password), 8);
    if (role !== undefined) user.role = role;
    if (department_id !== undefined) user.department_id = department_id || null;
    return user;
  }).catch((error) => {
    if (error.message === 'Email already in use') return 'duplicate_email' as const;
    throw error;
  });
  if (updated === 'duplicate_email') return res.status(409).json({ error: 'Email already in use' });
  if (!updated) return res.status(404).json({ error: 'User not found' });
  res.json({ id: updated.id, name: updated.name, email: updated.email, role: updated.role, department_id: updated.department_id });
});

/** DELETE /api/admin/users/:id — remove an account and release its project assignments. */
adminRouter.delete('/users/:id', async (req: AuthedRequest, res) => {
  if (req.user!.id === req.params.id) return res.status(400).json({ error: 'You cannot remove the active administrator account' });
  const removed = await store.transact((db) => {
    const index = db.users.findIndex((u) => u.id === req.params.id);
    if (index < 0) return null;
    const [user] = db.users.splice(index, 1);
    db.projects.forEach((project) => {
      if (project.assigned_faculty_id === user.id) project.assigned_faculty_id = null;
    });
    return { id: user.id, name: user.name };
  });
  if (!removed) return res.status(404).json({ error: 'User not found' });
  res.json({ deleted: true, ...removed });
});

/** GET /api/admin/users */
adminRouter.get('/users', (_req, res) => {
  res.json(store.data.users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, department_id: u.department_id })));
});
