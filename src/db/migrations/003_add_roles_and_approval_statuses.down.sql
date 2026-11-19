-- Down Migration 003: Revert Extended Roles and Statuses to Initial Schema

BEGIN;

DROP INDEX IF EXISTS idx_nfas_status;

ALTER TABLE user_profiles 
DROP CONSTRAINT IF EXISTS user_profiles_role_check;

ALTER TABLE user_profiles 
ADD CONSTRAINT user_profiles_role_check 
CHECK (role IN ('faculty', 'hod', 'dean', 'associate_dean', 'finance', 'director', 'super_admin'));

ALTER TABLE nfas 
DROP CONSTRAINT IF EXISTS nfas_status_check;

ALTER TABLE nfas 
ADD CONSTRAINT nfas_status_check 
CHECK (status IN (
    'draft', 'submitted', 'under_review', 'dean_review', 'accounts_review',
    'pending_director_approval', 'revision_required', 'budget_validation',
    'pending_higher_approval', 'approved', 'rejected'
));

COMMIT;
