-- Migration 003: Add Extended Roles and Hierarchical Approval Statuses
-- Expands role and status constraints to support 3 approval workflows (CSE/ADSE Associate Dean routing, Other Academic Dean routing, and Centres routing)

BEGIN;

-- 1. Update user_profiles role CHECK constraint
ALTER TABLE user_profiles 
DROP CONSTRAINT IF EXISTS user_profiles_role_check;

ALTER TABLE user_profiles 
ADD CONSTRAINT user_profiles_role_check 
CHECK (role IN (
    'faculty', 
    'hod', 
    'deans_office', 
    'dean', 
    'associate_dean', 
    'finance', 
    'director', 
    'finance_head', 
    'super_admin'
));

-- 2. Update nfas status CHECK constraint
ALTER TABLE nfas 
DROP CONSTRAINT IF EXISTS nfas_status_check;

ALTER TABLE nfas 
ADD CONSTRAINT nfas_status_check 
CHECK (status IN (
    'draft', 
    'submitted', 
    'pending_hod_review', 
    'pending_deans_office_verification', 
    'pending_associate_dean_approval', 
    'dean_review', 
    'pending_dean_approval', 
    'accounts_review', 
    'pending_finance_office_approval', 
    'pending_director_approval', 
    'pending_finance_head_approval', 
    'under_review', 
    'revision_required', 
    'budget_validation', 
    'pending_higher_approval', 
    'approved', 
    'rejected'
));

-- 3. Add index on status for high-volume inbox queries
CREATE INDEX IF NOT EXISTS idx_nfas_status ON nfas(status);

COMMIT;
