-- Rollback Migration 011: Performance Indexes
DROP INDEX IF EXISTS idx_nfas_dept_fy;
DROP INDEX IF EXISTS idx_nfas_created_by;
DROP INDEX IF EXISTS idx_nfas_status;
DROP INDEX IF EXISTS idx_nfas_centre_id;
DROP INDEX IF EXISTS idx_nfas_created_at;
DROP INDEX IF EXISTS idx_nfas_workflow_type;

DROP INDEX IF EXISTS idx_approvals_nfa_id;
DROP INDEX IF EXISTS idx_approvals_approver_id;
DROP INDEX IF EXISTS idx_approvals_decision;

DROP INDEX IF EXISTS idx_nfa_items_nfa_id;
DROP INDEX IF EXISTS idx_nfa_items_sl_no;

DROP INDEX IF EXISTS idx_dept_budgets_dept_fy;
DROP INDEX IF EXISTS idx_dept_budgets_cat;

DROP INDEX IF EXISTS idx_budget_subcats_dept_cat;
DROP INDEX IF EXISTS idx_budget_subcats_sl_no;

DROP INDEX IF EXISTS idx_budget_tx_dept_budget;
DROP INDEX IF EXISTS idx_budget_tx_nfa;

DROP INDEX IF EXISTS idx_purchase_invoices_nfa;
DROP INDEX IF EXISTS idx_purchase_invoices_status;

DROP INDEX IF EXISTS idx_bank_details_nfa;

DROP INDEX IF EXISTS idx_event_revenues_nfa;
DROP INDEX IF EXISTS idx_event_revenues_dept;
DROP INDEX IF EXISTS idx_event_revenues_status;

DROP INDEX IF EXISTS idx_audit_logs_entity;
DROP INDEX IF EXISTS idx_audit_logs_created_at;

DROP INDEX IF EXISTS idx_departments_school_id;
