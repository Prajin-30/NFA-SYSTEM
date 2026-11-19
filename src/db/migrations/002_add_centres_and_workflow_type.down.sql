-- Rollback Migration 002: Revert Centres or Offices additions
-- STRICT SAFETY: For non-production development rollbacks only

BEGIN;

DROP INDEX IF EXISTS idx_nfas_centre_id;
DROP INDEX IF EXISTS idx_nfas_workflow_type;
DROP INDEX IF EXISTS idx_nfas_org_type;

ALTER TABLE nfas 
DROP COLUMN IF EXISTS centre_id,
DROP COLUMN IF EXISTS workflow_type,
DROP COLUMN IF EXISTS organization_type;

ALTER TABLE user_profiles 
DROP COLUMN IF EXISTS authorized_centre_ids;

COMMIT;
