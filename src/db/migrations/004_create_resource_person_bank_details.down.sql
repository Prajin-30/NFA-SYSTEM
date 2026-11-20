-- Rollback Migration 004: Drop resource_person_bank_details table safely

BEGIN;

DROP POLICY IF EXISTS rp_bank_details_all_admin ON resource_person_bank_details;
DROP POLICY IF EXISTS rp_bank_details_update_creator ON resource_person_bank_details;
DROP POLICY IF EXISTS rp_bank_details_insert_creator ON resource_person_bank_details;
DROP POLICY IF EXISTS rp_bank_details_select_finance ON resource_person_bank_details;
DROP POLICY IF EXISTS rp_bank_details_select_creator ON resource_person_bank_details;

DROP INDEX IF EXISTS idx_rp_bank_details_nfa_id;

DROP TABLE IF EXISTS resource_person_bank_details CASCADE;

COMMIT;
