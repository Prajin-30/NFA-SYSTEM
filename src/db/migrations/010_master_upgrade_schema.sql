-- Migration 010: Master Upgrade Schema
-- Adds Schools hierarchy, Event NFA Revenue Generation & Completion Tracking, and Event Revenues ledger
-- Safe, additive migration preserving all existing institutional data and relationships

BEGIN;

-- 1. Schools Table (Campus -> School -> Department hierarchy)
CREATE TABLE IF NOT EXISTS schools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    campus TEXT NOT NULL DEFAULT 'Bangalore Kengeri Campus',
    dean_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed Initial Academic Schools
INSERT INTO schools (code, name, campus) VALUES
    ('SOET', 'School of Engineering and Technology', 'Bangalore Kengeri Campus'),
    ('SOA', 'School of Arts', 'Bangalore Central Campus'),
    ('SBM', 'School of Business and Management', 'Bangalore Central Campus'),
    ('SPS', 'School of Psychological Sciences', 'Bangalore Bannerghatta Road Campus')
ON CONFLICT (code) DO NOTHING;

-- 2. Link Departments to Schools
ALTER TABLE departments ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id) ON DELETE SET NULL;

-- Associate existing academic departments with SOET
UPDATE departments
SET school_id = (SELECT id FROM schools WHERE code = 'SOET' LIMIT 1)
WHERE (category = 'academic' OR category IS NULL)
  AND (code NOT LIKE 'COE-%')
  AND school_id IS NULL;

-- 3. Event NFA Revenue Generation & Completion Tracking Columns on NFAs
ALTER TABLE nfas ADD COLUMN IF NOT EXISTS will_generate_revenue BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE nfas ADD COLUMN IF NOT EXISTS event_completion_status TEXT NOT NULL DEFAULT 'not_started';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nfas_event_completion_status_check') THEN
        ALTER TABLE nfas ADD CONSTRAINT nfas_event_completion_status_check 
        CHECK (event_completion_status IN ('not_started', 'scheduled', 'completed', 'cancelled'));
    END IF;
END $$;

ALTER TABLE nfas ADD COLUMN IF NOT EXISTS event_completion_date DATE;
ALTER TABLE nfas ADD COLUMN IF NOT EXISTS event_completion_remarks TEXT;
ALTER TABLE nfas ADD COLUMN IF NOT EXISTS event_completed_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL;
ALTER TABLE nfas ADD COLUMN IF NOT EXISTS event_completed_at TIMESTAMPTZ;

-- 4. Event Revenues Table (Independent Financial Reporting Ledger)
-- NOTE: Event revenues are strictly isolated from expenditure budgets and never offset or increase NFA spendable budget
CREATE TABLE IF NOT EXISTS event_revenues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nfa_id UUID NOT NULL REFERENCES nfas(id) ON DELETE CASCADE,
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    revenue_source TEXT NOT NULL CHECK (revenue_source IN ('registration_fee', 'sponsorship', 'participation_fee', 'event_collection', 'other_income')),
    description TEXT NOT NULL,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    collection_date DATE NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'online',
    receipt_url TEXT,
    receipt_filename TEXT,
    remarks TEXT,
    submitted_by UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    submitted_by_name TEXT,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'verified', 'returned')),
    verified_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    verified_by_name TEXT,
    verified_at TIMESTAMPTZ,
    verification_remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_event_revenues_nfa_id ON event_revenues(nfa_id);
CREATE INDEX IF NOT EXISTS idx_event_revenues_dept_id ON event_revenues(department_id);
CREATE INDEX IF NOT EXISTS idx_event_revenues_status ON event_revenues(status);

-- 5. Event Revenue Reminders Table
CREATE TABLE IF NOT EXISTS event_revenue_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nfa_id UUID NOT NULL REFERENCES nfas(id) ON DELETE CASCADE,
    sent_to UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    sent_to_email TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    status TEXT NOT NULL DEFAULT 'mock_delivered' CHECK (status IN ('mock_delivered', 'delivered', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_event_revenue_reminders_nfa_id ON event_revenue_reminders(nfa_id);

-- 6. Expand audit_logs entity_type CHECK constraint to include 'event_revenue'
ALTER TABLE audit_logs 
DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;

ALTER TABLE audit_logs 
ADD CONSTRAINT audit_logs_entity_type_check 
CHECK (entity_type IN ('nfa', 'project', 'department_budget', 'excel_sync', 'user_account', 'bank_detail', 'purchase_invoice', 'event_revenue'));

-- 7. Enable RLS
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_revenues ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_revenue_reminders ENABLE ROW LEVEL SECURITY;

-- Permissive policies for authenticated backend roles
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'schools_select_all') THEN
        CREATE POLICY schools_select_all ON schools FOR SELECT USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'event_revenues_all') THEN
        CREATE POLICY event_revenues_all ON event_revenues FOR ALL USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'event_revenue_reminders_all') THEN
        CREATE POLICY event_revenue_reminders_all ON event_revenue_reminders FOR ALL USING (true);
    END IF;
END $$;

COMMIT;
