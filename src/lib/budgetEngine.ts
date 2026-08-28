import { v4 as uuid } from 'uuid';
import type { DB, DepartmentBudget, Role } from '../types.js';

export class BudgetError extends Error {
  constructor(message: string, public payload?: any) {
    super(message);
  }
}

/** Threshold above which an amount change needs Finance's higher approval, not just HOD's. */
export const HIGHER_APPROVAL_THRESHOLD = 100000;
/** A revision whose absolute % change exceeds this also escalates, even if under the flat threshold. */
export const HIGHER_APPROVAL_PCT = 0.25;

export function getBudget(db: DB, id: string): DepartmentBudget {
  const b = db.department_budgets.find((x) => x.id === id);
  if (!b) throw new BudgetError('Department budget line not found');
  return b;
}

export function findBudgetLine(db: DB, department_id: string, financial_year_id: string, budget_category_id: string) {
  const b = db.department_budgets.find(
    (x) => x.department_id === department_id && x.financial_year_id === financial_year_id && x.budget_category_id === budget_category_id
  );
  if (!b) throw new BudgetError('No budget allocated for this department/category/financial year combination');
  return b;
}

export function availableAmount(b: DepartmentBudget) {
  return b.allocated_amount - b.approved_amount - b.pending_amount;
}

/** Requirement #17: validate requested amount against available budget. Never silently over-allocate. */
export function validateBudget(b: DepartmentBudget, requestedAmount: number) {
  const available = availableAmount(b);
  const sufficient = requestedAmount <= available;
  return {
    available,
    requested: requestedAmount,
    sufficient,
    shortfall: sufficient ? 0 : requestedAmount - available,
    higherApprovalRequired: !sufficient || requestedAmount >= HIGHER_APPROVAL_THRESHOLD,
  };
}

/**
 * Requirement #9: new project approval -> auto add to master department budget.
 * Moves `amount` from "pending" into "approved" (or straight into approved if it was never staged as pending).
 */
export function applyNewApproval(
  db: DB,
  budgetLineId: string,
  amount: number,
  ctx: { nfa_id: string; project_id: string; changed_by: string; role: Role; department_id: string }
) {
  const line = getBudget(db, budgetLineId);
  const oldApproved = line.approved_amount;
  line.pending_amount = Math.max(0, line.pending_amount - amount);
  line.approved_amount += amount;

  db.budget_transactions.push({
    id: uuid(),
    nfa_id: ctx.nfa_id,
    project_id: ctx.project_id,
    department_budget_id: line.id,
    type: 'new',
    old_amount: oldApproved,
    new_amount: line.approved_amount,
    difference: amount,
    created_by: ctx.changed_by,
    created_at: new Date().toISOString(),
  });

  db.audit_logs.push({
    id: uuid(),
    entity_type: 'nfa',
    entity_id: ctx.nfa_id,
    department_id: ctx.department_id,
    old_amount: oldApproved,
    new_amount: line.approved_amount,
    difference: amount,
    changed_by: ctx.changed_by,
    role: ctx.role,
    reason: 'NFA approved - new project budget added to department master budget',
    source: 'portal',
    approval_status: 'approved',
    created_at: new Date().toISOString(),
  });

  return line;
}

/**
 * Requirements #10/#11/#12: revise an already-approved NFA's amount.
 * Computes the difference (never overwrites blindly), and either applies it immediately
 * or escalates to "pending higher approval" if it crosses the threshold.
 */
export function reviseApprovedAmount(
  db: DB,
  budgetLineId: string,
  oldAmount: number,
  newAmount: number,
  ctx: { nfa_id: string; project_id: string; changed_by: string; role: Role; department_id: string; reason: string; source: 'portal' | 'excel' }
) {
  const line = getBudget(db, budgetLineId);
  const difference = newAmount - oldAmount;
  // Only increases can breach the department's available budget, so only increases escalate;
  // decreases always apply immediately and free up budget right away.
  const needsHigherApproval = difference > 0 && difference >= HIGHER_APPROVAL_THRESHOLD;

  if (needsHigherApproval) {
    // Stage as pending; do NOT touch approved_amount yet.
    line.pending_amount += difference;
    db.audit_logs.push({
      id: uuid(),
      entity_type: 'nfa',
      entity_id: ctx.nfa_id,
      department_id: ctx.department_id,
      old_amount: oldAmount,
      new_amount: newAmount,
      difference,
      changed_by: ctx.changed_by,
      role: ctx.role,
      reason: ctx.reason,
      source: ctx.source,
      approval_status: 'pending_higher_approval',
      created_at: new Date().toISOString(),
    });
    return { line, difference, status: 'pending_higher_approval' as const };
  }

  // Apply immediately (increase or decrease)
  const oldApproved = line.approved_amount;
  line.approved_amount += difference; // difference is negative for a decrease -> frees up budget automatically

  db.budget_transactions.push({
    id: uuid(),
    nfa_id: ctx.nfa_id,
    project_id: ctx.project_id,
    department_budget_id: line.id,
    type: difference >= 0 ? 'increase' : 'decrease',
    old_amount: oldApproved,
    new_amount: line.approved_amount,
    difference,
    created_by: ctx.changed_by,
    created_at: new Date().toISOString(),
  });

  db.audit_logs.push({
    id: uuid(),
    entity_type: 'nfa',
    entity_id: ctx.nfa_id,
    department_id: ctx.department_id,
    old_amount: oldAmount,
    new_amount: newAmount,
    difference,
    changed_by: ctx.changed_by,
    role: ctx.role,
    reason: ctx.reason,
    source: ctx.source,
    approval_status: 'approved',
    created_at: new Date().toISOString(),
  });

  return { line, difference, status: 'approved' as const };
}

/** Finance clears a pending-higher-approval revision that was staged earlier. */
export function finalizePendingRevision(
  db: DB,
  budgetLineId: string,
  difference: number,
  ctx: { nfa_id: string; project_id: string; changed_by: string; role: Role; department_id: string; reason: string }
) {
  const line = getBudget(db, budgetLineId);
  const oldApproved = line.approved_amount;
  line.pending_amount = Math.max(0, line.pending_amount - difference);
  line.approved_amount += difference;

  db.budget_transactions.push({
    id: uuid(),
    nfa_id: ctx.nfa_id,
    project_id: ctx.project_id,
    department_budget_id: line.id,
    type: difference >= 0 ? 'increase' : 'decrease',
    old_amount: oldApproved,
    new_amount: line.approved_amount,
    difference,
    created_by: ctx.changed_by,
    created_at: new Date().toISOString(),
  });

  db.audit_logs.push({
    id: uuid(),
    entity_type: 'nfa',
    entity_id: ctx.nfa_id,
    department_id: ctx.department_id,
    old_amount: oldApproved,
    new_amount: line.approved_amount,
    difference,
    changed_by: ctx.changed_by,
    role: ctx.role,
    reason: ctx.reason + ' (higher approval granted)',
    source: 'portal',
    approval_status: 'approved',
    created_at: new Date().toISOString(),
  });

  return line;
}
