-- Migration 009: Add sl_no to budget_subcategories
-- Preserves original source Excel serial numbers (numbers or alphanumeric e.g. 1, 2, 3, 1.1)

ALTER TABLE budget_subcategories ADD COLUMN IF NOT EXISTS sl_no TEXT;
