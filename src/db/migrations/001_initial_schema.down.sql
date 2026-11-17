-- Migration 001 Rollback: Drop Initial Schema (Isolated Staging & Testing ONLY)
-- SAFETY GUARD: Never execute against production database.

BEGIN;

-- Drop RLS policies
DROP POLICY IF EXISTS nfas_delete_policy ON nfas;
DROP POLICY IF EXISTS nfas_update_policy ON nfas;
DROP POLICY IF EXISTS nfas_insert_policy ON nfas;
DROP POLICY IF EXISTS nfas_select_policy ON nfas;
DROP FUNCTION IF EXISTS current_auth_uid();

-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS budget_changes CASCADE;
DROP TABLE IF EXISTS budget_uploads CASCADE;
DROP TABLE IF EXISTS excel_sync_records CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS budget_transactions CASCADE;
DROP TABLE IF EXISTS approvals CASCADE;
DROP TABLE IF EXISTS nfa_items CASCADE;
DROP TABLE IF EXISTS nfas CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS department_budgets CASCADE;
DROP TABLE IF EXISTS budget_subcategories CASCADE;
DROP TABLE IF EXISTS user_profiles CASCADE;
DROP TABLE IF EXISTS budget_categories CASCADE;
DROP TABLE IF EXISTS budget_types CASCADE;
DROP TABLE IF EXISTS financial_years CASCADE;
DROP TABLE IF EXISTS departments CASCADE;

DELETE FROM schema_migrations WHERE version = '001_initial_schema';

COMMIT;
