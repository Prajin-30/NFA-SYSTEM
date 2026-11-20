-- Migration 007: Expand approvals decision check to support verification step
BEGIN;

ALTER TABLE approvals 
DROP CONSTRAINT IF EXISTS approvals_decision_check;

ALTER TABLE approvals 
ADD CONSTRAINT approvals_decision_check 
CHECK (decision IN ('approved', 'rejected', 'revision_required', 'recommended', 'verified'));

COMMIT;
