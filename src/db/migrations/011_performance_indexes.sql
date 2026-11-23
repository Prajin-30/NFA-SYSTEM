-- Migration 011: Performance Indexes
-- Adds high-performance B-tree indexes for foreign keys, frequent filters, and sort columns
-- to eliminate sequential scans on high-traffic financial and operational tables.

CREATE INDEX IF NOT EXISTS idx_nfas_dept_fy ON nfas(department_id, financial_year_id);
CREATE INDEX IF NOT EXISTS idx_nfas_created_by ON nfas(created_by);
CREATE INDEX IF NOT EXISTS idx_nfas_status ON nfas(status);
CREATE INDEX IF NOT EXISTS idx_nfas_centre_id ON nfas(centre_id);
CREATE INDEX IF NOT EXISTS idx_nfas_created_at ON nfas(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nfas_workflow_type ON nfas(workflow_type);

CREATE INDEX IF NOT EXISTS idx_approvals_nfa_id ON approvals(nfa_id);
CREATE INDEX IF NOT EXISTS idx_approvals_approver_id ON approvals(approver_id);
CREATE INDEX IF NOT EXISTS idx_approvals_decision ON approvals(decision);

CREATE INDEX IF NOT EXISTS idx_nfa_items_nfa_id ON nfa_items(nfa_id);
CREATE INDEX IF NOT EXISTS idx_nfa_items_sl_no ON nfa_items(nfa_id, sl_no);

CREATE INDEX IF NOT EXISTS idx_dept_budgets_dept_fy ON department_budgets(department_id, financial_year_id);
CREATE INDEX IF NOT EXISTS idx_dept_budgets_cat ON department_budgets(budget_category_id);

CREATE INDEX IF NOT EXISTS idx_budget_subcats_dept_cat ON budget_subcategories(department_id, budget_category_id);
CREATE INDEX IF NOT EXISTS idx_budget_subcats_sl_no ON budget_subcategories(department_id, sl_no);

CREATE INDEX IF NOT EXISTS idx_budget_tx_dept_budget ON budget_transactions(department_budget_id);
CREATE INDEX IF NOT EXISTS idx_budget_tx_nfa ON budget_transactions(nfa_id);

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_nfa ON purchase_invoices(nfa_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_status ON purchase_invoices(payment_status);

CREATE INDEX IF NOT EXISTS idx_bank_details_nfa ON resource_person_bank_details(nfa_id);

CREATE INDEX IF NOT EXISTS idx_event_revenues_nfa ON event_revenues(nfa_id);
CREATE INDEX IF NOT EXISTS idx_event_revenues_dept ON event_revenues(department_id);
CREATE INDEX IF NOT EXISTS idx_event_revenues_status ON event_revenues(status);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_departments_school_id ON departments(school_id);
