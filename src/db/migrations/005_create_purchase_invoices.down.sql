-- Rollback Migration 005: Drop Purchase Invoices Table

BEGIN;

DROP TABLE IF EXISTS purchase_invoices CASCADE;

COMMIT;
