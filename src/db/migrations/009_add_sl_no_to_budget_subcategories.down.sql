-- Migration 009 Down: Revert sl_no from budget_subcategories
ALTER TABLE budget_subcategories DROP COLUMN IF EXISTS sl_no;
