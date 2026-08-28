import { Router } from 'express';
import { store } from '../store.js';
import { requireAuth, AuthedRequest } from '../middleware/auth.js';

export const auditRouter = Router();
auditRouter.use(requireAuth);

/** GET /api/audit?department=&entity_type=&nfa_id= — full financial history, never deleted */
auditRouter.get('/', (req: AuthedRequest, res) => {
  let list = store.data.audit_logs;
  const { role, department_id } = req.user!;
  if (['faculty', 'hod', 'it_admin'].includes(role)) list = list.filter((a) => a.department_id === department_id);
  if (role === 'student') list = list.filter((a) => a.changed_by === req.user!.id);
  if (req.query.department) list = list.filter((a) => a.department_id === req.query.department);
  if (req.query.entity_type) list = list.filter((a) => a.entity_type === req.query.entity_type);
  if (req.query.nfa_id) list = list.filter((a) => a.entity_id === req.query.nfa_id);
  res.json(list.slice().reverse());
});

/** GET /api/audit/transactions — the raw budget_transactions ledger */
auditRouter.get('/transactions', (req: AuthedRequest, res) => {
  let list = store.data.budget_transactions;
  if (req.query.department) {
    const lineIds = store.data.department_budgets.filter((b) => b.department_id === req.query.department).map((b) => b.id);
    list = list.filter((t) => lineIds.includes(t.department_budget_id));
  }
  res.json(list.slice().reverse());
});

/** GET /api/audit/budget-changes — project and original-upload version history. */
auditRouter.get('/budget-changes', (req: AuthedRequest, res) => {
  let list = store.data.budget_changes;
  if (['faculty', 'hod', 'it_admin'].includes(req.user!.role)) list = list.filter((change) => change.department_id === req.user!.department_id);
  if (req.user!.role === 'student') list = list.filter((change) => change.changed_by === req.user!.id);
  res.json(list.slice().reverse());
});
