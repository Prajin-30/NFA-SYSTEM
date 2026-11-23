-- Migration 010 Down: Roll back Master Upgrade Schema

BEGIN;

DROP TABLE IF EXISTS event_revenue_reminders CASCADE;
DROP TABLE IF EXISTS event_revenues CASCADE;

ALTER TABLE nfas DROP COLUMN IF EXISTS will_generate_revenue;
ALTER TABLE nfas DROP COLUMN IF EXISTS event_completion_status;
ALTER TABLE nfas DROP COLUMN IF EXISTS event_completion_date;
ALTER TABLE nfas DROP COLUMN IF EXISTS event_completion_remarks;
ALTER TABLE nfas DROP COLUMN IF EXISTS event_completed_by;
ALTER TABLE nfas DROP COLUMN IF EXISTS event_completed_at;

ALTER TABLE departments DROP COLUMN IF EXISTS school_id;

DROP TABLE IF EXISTS schools CASCADE;

ALTER TABLE audit_logs 
DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;

ALTER TABLE audit_logs 
ADD CONSTRAINT audit_logs_entity_type_check 
CHECK (entity_type IN ('nfa', 'project', 'department_budget', 'excel_sync', 'user_account', 'bank_detail', 'purchase_invoice'));

COMMIT;
