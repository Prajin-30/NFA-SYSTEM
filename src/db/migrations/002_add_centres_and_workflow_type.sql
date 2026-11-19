-- Migration 002: Add Centres or Offices support and workflow type to User Profiles and NFAs
-- Safe, additive migration preserving all existing institutional data and relations

BEGIN;

-- 1. Add authorized_centre_ids array to user_profiles
ALTER TABLE user_profiles 
ADD COLUMN IF NOT EXISTS authorized_centre_ids TEXT[] DEFAULT '{}';

-- 2. Add organization_type, workflow_type, and centre_id to nfas
ALTER TABLE nfas 
ADD COLUMN IF NOT EXISTS organization_type TEXT DEFAULT 'department' CHECK (organization_type IN ('department', 'centre_or_office')),
ADD COLUMN IF NOT EXISTS workflow_type TEXT DEFAULT 'department' CHECK (workflow_type IN ('department', 'centre_or_office')),
ADD COLUMN IF NOT EXISTS centre_id UUID REFERENCES departments(id) ON DELETE SET NULL;

-- 3. Backfill existing NFAs safely
UPDATE nfas 
SET organization_type = 'department', 
    workflow_type = 'department' 
WHERE organization_type IS NULL OR workflow_type IS NULL;

-- 4. Create performance indexes for filtered queries
CREATE INDEX IF NOT EXISTS idx_nfas_org_type ON nfas(organization_type);
CREATE INDEX IF NOT EXISTS idx_nfas_workflow_type ON nfas(workflow_type);
CREATE INDEX IF NOT EXISTS idx_nfas_centre_id ON nfas(centre_id);

COMMIT;
