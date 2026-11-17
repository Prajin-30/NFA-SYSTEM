-- Migration 001: Initial Schema for CHRIST University NFA Management System
-- Schema covers all 16 existing entity types with ACID relations, RLS, and constraints

BEGIN;

-- Create auth schema mock if not present (for standalone Postgres test environments)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth') THEN
        CREATE SCHEMA auth;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users') THEN
        CREATE TABLE auth.users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email TEXT UNIQUE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    END IF;
END $$;

-- 1. Departments & Centres of Excellence
CREATE TABLE IF NOT EXISTS departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK (category IN ('academic', 'coe')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    hod_name TEXT DEFAULT '',
    dean_name TEXT DEFAULT '',
    faculty_name TEXT DEFAULT '',
    associate_dean_name TEXT DEFAULT '',
    director_name TEXT DEFAULT '',
    finance_officer_name TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Academic & Financial Years
CREATE TABLE IF NOT EXISTS financial_years (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label TEXT NOT NULL UNIQUE, -- e.g. '2026-27'
    is_active BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Budget Types
CREATE TABLE IF NOT EXISTS budget_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE, -- 'Revenue Expenditure', 'Capital Expenditure (CAPEX)', 'Revenue & Earnings'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Budget Categories
CREATE TABLE IF NOT EXISTS budget_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    budget_type_id UUID NOT NULL REFERENCES budget_types(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (budget_type_id, name)
);

-- 5. User Profiles (Linked 1:1 with Supabase auth.users)
CREATE TABLE IF NOT EXISTS user_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('faculty', 'hod', 'dean', 'associate_dean', 'finance', 'director', 'super_admin')),
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    signature_image TEXT,
    must_change_password BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    temp_password_created_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce exactly one active HOD per department
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_dept_hod 
ON user_profiles (department_id) 
WHERE role = 'hod' AND is_active = true;

-- 6. Budget Subcategories
CREATE TABLE IF NOT EXISTS budget_subcategories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    budget_category_id UUID NOT NULL REFERENCES budget_categories(id) ON DELETE CASCADE,
    department_id UUID REFERENCES departments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    allocated_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    approved_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    pending_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    cell_mapping JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Department Budgets (Master Category Ceilings)
CREATE TABLE IF NOT EXISTS department_budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    financial_year_id UUID NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
    budget_category_id UUID NOT NULL REFERENCES budget_categories(id) ON DELETE RESTRICT,
    allocated_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    approved_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    pending_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    revised_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    cell_mapping JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (department_id, financial_year_id, budget_category_id)
);

-- 8. Projects
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    department_id UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    financial_year_id UUID NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
    budget_category_id UUID NOT NULL REFERENCES budget_categories(id) ON DELETE RESTRICT,
    created_by UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    assigned_faculty_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    budget_amount NUMERIC(14, 2) DEFAULT 0.00,
    description TEXT,
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Notes For Approval (NFAs)
CREATE TABLE IF NOT EXISTS nfas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref_no TEXT NOT NULL UNIQUE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    department_id UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    financial_year_id UUID NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
    budget_type_id UUID REFERENCES budget_types(id) ON DELETE RESTRICT,
    budget_category_id UUID NOT NULL REFERENCES budget_categories(id) ON DELETE RESTRICT,
    budget_subcategory_id UUID REFERENCES budget_subcategories(id) ON DELETE SET NULL,
    budget_subcategory_name TEXT DEFAULT '',
    title TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    justification TEXT NOT NULL DEFAULT '',
    sdgs TEXT DEFAULT '',
    requirements TEXT DEFAULT '',
    total_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'submitted', 'under_review', 'dean_review', 'accounts_review',
        'pending_director_approval', 'revision_required', 'budget_validation',
        'pending_higher_approval', 'approved', 'rejected'
    )),
    created_by UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    submitted_by_name TEXT,
    submitted_by_designation TEXT,
    hod_name TEXT DEFAULT '',
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    point1 TEXT DEFAULT '',
    point2 TEXT DEFAULT '',
    point3 TEXT DEFAULT '',
    point4 TEXT DEFAULT '',
    nfa_type TEXT NOT NULL DEFAULT 'event' CHECK (nfa_type IN ('event', 'purchase')),
    event_details JSONB,
    purchase_details JSONB,
    quotations JSONB DEFAULT '[]'::jsonb,
    comparative_statement JSONB,
    proposer_signature TEXT,
    pending_revision_amount NUMERIC(14, 2) DEFAULT 0.00,
    pending_revision_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast role queries & draft isolation
CREATE INDEX IF NOT EXISTS idx_nfas_creator_status ON nfas(created_by, status);
CREATE INDEX IF NOT EXISTS idx_nfas_dept_status ON nfas(department_id, status);

-- 10. NFA Items
CREATE TABLE IF NOT EXISTS nfa_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nfa_id UUID NOT NULL REFERENCES nfas(id) ON DELETE CASCADE,
    sl_no INT NOT NULL,
    particulars TEXT NOT NULL,
    quantity TEXT NOT NULL,
    rate TEXT DEFAULT '',
    amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    comments TEXT,
    justification TEXT,
    basis_of_budget TEXT,
    previous_year_budget NUMERIC(14, 2) DEFAULT 0.00,
    previous_year_actual NUMERIC(14, 2) DEFAULT 0.00,
    is_predefined BOOLEAN DEFAULT false,
    predefined_key TEXT,
    distance_km TEXT,
    carry_back_arrangement TEXT,
    sampling_required BOOLEAN DEFAULT false,
    item_type TEXT DEFAULT 'custom' CHECK (item_type IN ('predefined', 'custom', 'purchase')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Approvals (Audit Stepper Ledger)
CREATE TABLE IF NOT EXISTS approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nfa_id UUID NOT NULL REFERENCES nfas(id) ON DELETE CASCADE,
    approver_role TEXT NOT NULL,
    approver_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    approver_name TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'revision_required', 'recommended')),
    comments TEXT DEFAULT '',
    level INT NOT NULL,
    signature_image TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. Budget Transactions (Immutable Financial Ledger)
CREATE TABLE IF NOT EXISTS budget_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nfa_id UUID REFERENCES nfas(id) ON DELETE SET NULL,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    department_budget_id UUID NOT NULL REFERENCES department_budgets(id) ON DELETE RESTRICT,
    type TEXT NOT NULL CHECK (type IN ('new', 'increase', 'decrease', 'excel_sync')),
    old_amount NUMERIC(14, 2) NOT NULL,
    new_amount NUMERIC(14, 2) NOT NULL,
    difference NUMERIC(14, 2) NOT NULL,
    created_by UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 13. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('nfa', 'project', 'department_budget', 'excel_sync', 'user_account')),
    entity_id TEXT NOT NULL,
    department_id TEXT NOT NULL,
    old_amount NUMERIC(14, 2),
    new_amount NUMERIC(14, 2),
    difference NUMERIC(14, 2),
    changed_by UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    role TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'excel', 'system')),
    approval_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 14. Excel Sync Records
CREATE TABLE IF NOT EXISTS excel_sync_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    financial_year_id UUID NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
    department_id UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    filename TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending_review', 'confirmed', 'rejected')),
    diff_json JSONB NOT NULL,
    created_by UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 15. Budget Uploads (Master Workbooks)
CREATE TABLE IF NOT EXISTS budget_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    financial_year_id UUID NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
    department_id UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    uploaded_by UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('original', 'active', 'archived')),
    is_master BOOLEAN DEFAULT false,
    sheets_info JSONB,
    cell_mappings JSONB
);

-- 16. Budget Changes (Versioning Log)
CREATE TABLE IF NOT EXISTS budget_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version INT NOT NULL,
    financial_year_id UUID NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
    department_id UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    changed_by UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    previous_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    description TEXT NOT NULL,
    approval_status TEXT NOT NULL CHECK (approval_status IN ('original', 'pending', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security (RLS) on sensitive tables
ALTER TABLE nfas ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_subcategories ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;

-- Helper function to extract authenticated user UID safely
CREATE OR REPLACE FUNCTION current_auth_uid() RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- RLS POLICIES FOR NFAS
-- Policy 1: Faculty Draft Privacy — Draft NFAs can ONLY be seen by their creator
DROP POLICY IF EXISTS nfas_select_policy ON nfas;
CREATE POLICY nfas_select_policy ON nfas
FOR SELECT
USING (
    status != 'draft' OR created_by = current_auth_uid()
);

-- Policy 2: Creator can insert draft or proposal
DROP POLICY IF EXISTS nfas_insert_policy ON nfas;
CREATE POLICY nfas_insert_policy ON nfas
FOR INSERT
WITH CHECK (
    created_by = current_auth_uid()
);

-- Policy 3: Draft updates strictly restricted to creator
DROP POLICY IF EXISTS nfas_update_policy ON nfas;
CREATE POLICY nfas_update_policy ON nfas
FOR UPDATE
USING (
    (status = 'draft' AND created_by = current_auth_uid())
    OR (status != 'draft')
);

-- Policy 4: Draft deletion strictly restricted to creator
DROP POLICY IF EXISTS nfas_delete_policy ON nfas;
CREATE POLICY nfas_delete_policy ON nfas
FOR DELETE
USING (
    status = 'draft' AND created_by = current_auth_uid()
);

-- Migration Tracking Table
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('001_initial_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
