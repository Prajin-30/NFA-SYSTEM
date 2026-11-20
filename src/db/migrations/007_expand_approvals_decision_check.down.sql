-- Rollback Migration 007
BEGIN;

ALTER TABLE approvals 
DROP CONSTRAINT IF EXISTS approvals_decision_check;

ALTER TABLE approvals 
ADD CONSTRAINT approvals_decision_check 
CHECK (decision IN ('approved', 'rejected', 'revision_required', 'recommended'));

COMMIT;
