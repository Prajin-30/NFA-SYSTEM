import { Router } from 'express';
import { store } from '../store.js';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth.js';
import { availableAmount } from '../lib/budgetEngine.js';
import { exportDepartmentBudgetExcel } from '../lib/excel.js';

export const budgetsRouter = Router();
budgetsRouter.use(requireAuth);

/** GET /api/budgets/departments - reference data */
budgetsRouter.get('/departments', (_req, res) => res.json(store.data.departments));

/** GET /api/budgets/financial-years - reference data (never hard-coded to one year) */
budgetsRouter.get('/financial-years', (_req, res) => res.json(store.data.financial_years));

/** GET /api/budgets/categories - reference data */
budgetsRouter.get('/categories', (_req, res) => res.json(store.data.budget_categories));

/**
 * GET /api/budgets/:department/summary?fy=<financial_year_id>
 * Master department budget view: allocated / approved / pending / available per category.
 */
budgetsRouter.get('/:department/summary', (req: AuthedRequest, res) => {
  const fy = String(req.query.fy || store.data.financial_years.find((f) => f.is_active)?.id);
  const lines = store.data.department_budgets.filter((b) => b.department_id === req.params.department && b.financial_year_id === fy);
  const out = lines.map((line) => {
    const cat = store.data.budget_categories.find((c) => c.id === line.budget_category_id);
    return {
      ...line,
      category_name: cat?.name,
      available_amount: availableAmount(line),
    };
  });
  const totals = out.reduce(
    (acc, l) => ({
      allocated_amount: acc.allocated_amount + l.allocated_amount,
      approved_amount: acc.approved_amount + l.approved_amount,
      pending_amount: acc.pending_amount + l.pending_amount,
      available_amount: acc.available_amount + l.available_amount,
    }),
    { allocated_amount: 0, approved_amount: 0, pending_amount: 0, available_amount: 0 }
  );
  res.json({ lines: out, totals });
});

/** GET /api/budgets/:department - raw budget lines (all financial years) */
budgetsRouter.get('/:department', (req, res) => {
  res.json(store.data.department_budgets.filter((b) => b.department_id === req.params.department));
});

/**
 * PUT /api/budgets/:id — Super Admin only: adjust an allocation (e.g. new financial year setup).
 * This is NOT the approval/revision flow (that's driven through NFAs); this sets the top-line allocation.
 */
budgetsRouter.put('/:id', requireRole('super_admin'), async (req, res) => {
  const { allocated_amount } = req.body || {};
  if (typeof allocated_amount !== 'number' || allocated_amount < 0) {
    return res.status(400).json({ error: 'allocated_amount must be a non-negative number' });
  }
  const updated = await store.transact((db) => {
    const line = db.department_budgets.find((b) => b.id === req.params.id);
    if (!line) throw new Error('not_found');
    line.allocated_amount = allocated_amount;
    return line;
  }).catch((e) => (e.message === 'not_found' ? null : Promise.reject(e)));
  if (!updated) return res.status(404).json({ error: 'Budget line not found' });
  res.json(updated);
});

/** GET /api/budgets/export/:department?fy=... — Excel export (requirement #13) */
budgetsRouter.get('/export/:department', async (req, res) => {
  const fy = String(req.query.fy || store.data.financial_years.find((f) => f.is_active)?.id);
  try {
    await exportDepartmentBudgetExcel(res, store.data, req.params.department, fy);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to export budget workbook' });
  }
});
