-- Rollback Migration 008
BEGIN;

ALTER TABLE audit_logs 
DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;

ALTER TABLE audit_logs 
ADD CONSTRAINT audit_logs_entity_type_check 
CHECK (entity_type IN ('nfa', 'project', 'department_budget', 'excel_sync', 'user_account'));

COMMIT;
