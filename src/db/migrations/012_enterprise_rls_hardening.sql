-- 012_enterprise_rls_hardening.sql
-- Complete Enterprise Row Level Security (RLS) hardening, MFA, security audit logs and threat protection.

-- 1. Create Security Supporting Tables
CREATE TABLE IF NOT EXISTS user_mfa_settings (
    user_id UUID PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
    mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    secret TEXT,
    recovery_codes TEXT[] DEFAULT '{}',
    enrolled_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    user_id UUID,
    user_role VARCHAR(50),
    ip_address VARCHAR(100),
    user_agent TEXT,
    resource VARCHAR(255),
    action VARCHAR(100),
    status VARCHAR(50) NOT NULL CHECK (status IN ('SUCCESS', 'FAILURE', 'BLOCKED', 'FLAGGED')),
    details JSONB DEFAULT '{}'::jsonb,
    request_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sec_audit_event ON security_audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_sec_audit_severity ON security_audit_logs(severity);
CREATE INDEX IF NOT EXISTS idx_sec_audit_user ON security_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_sec_audit_created ON security_audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS security_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_ref VARCHAR(100) NOT NULL UNIQUE,
    alert_type VARCHAR(100) NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    affected_component VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    action_taken TEXT NOT NULL,
    recommended_action TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE')),
    acknowledged_by UUID,
    acknowledged_at TIMESTAMPTZ,
    resolved_by UUID,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sec_alerts_severity ON security_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_sec_alerts_status ON security_alerts(status);
CREATE INDEX IF NOT EXISTS idx_sec_alerts_created ON security_alerts(created_at DESC);

CREATE TABLE IF NOT EXISTS emergency_mode_state (
    id VARCHAR(50) PRIMARY KEY DEFAULT 'current_state',
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    activated_by UUID REFERENCES user_profiles(id),
    activated_at TIMESTAMPTZ,
    reason TEXT,
    restrictions JSONB DEFAULT '{"read_only": true, "block_approvals": true, "block_disbursements": true}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO emergency_mode_state (id, is_active, reason)
VALUES ('current_state', false, 'Normal operation')
ON CONFLICT (id) DO NOTHING;

-- 2. Enable RLS on All Tables
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_subcategories ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfas ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfa_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_person_bank_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_revenues ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_revenue_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_mode_state ENABLE ROW LEVEL SECURITY;

-- 3. Dedicated Backend & Service Role Policies (Full Administrative Access for Node.js backend)
DO $$
DECLARE
    tbl text;
    tables text[] := ARRAY[
        'user_profiles', 'departments', 'schools', 'financial_years', 'budget_types',
        'budget_categories', 'budget_subcategories', 'department_budgets', 'projects',
        'nfas', 'nfa_items', 'approvals', 'budget_transactions', 'budget_uploads',
        'budget_changes', 'resource_person_bank_details', 'purchase_invoices',
        'event_revenues', 'event_revenue_reminders', 'audit_logs', 'revoked_tokens',
        'user_mfa_settings', 'security_audit_logs', 'security_alerts', 'emergency_mode_state'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I_backend_all ON %I;', tbl, tbl);
        EXECUTE format('CREATE POLICY %I_backend_all ON %I FOR ALL TO postgres, service_role USING (true) WITH CHECK (true);', tbl, tbl);
    END LOOP;
END $$;

-- 4. PostgREST / Public Client Hardening (Deny anonymous access to sensitive tables)
-- Public Reference Tables (Read-only for authenticated, or anon if public directory)
DROP POLICY IF EXISTS departments_read_all ON departments;
CREATE POLICY departments_read_all ON departments FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS schools_read_all ON schools;
CREATE POLICY schools_read_all ON schools FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS financial_years_read_all ON financial_years;
CREATE POLICY financial_years_read_all ON financial_years FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS budget_types_read_all ON budget_types;
CREATE POLICY budget_types_read_all ON budget_types FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS budget_categories_read_all ON budget_categories;
CREATE POLICY budget_categories_read_all ON budget_categories FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS budget_subcategories_read_all ON budget_subcategories;
CREATE POLICY budget_subcategories_read_all ON budget_subcategories FOR SELECT TO authenticated USING (true);

-- User Profiles: Self-read & update, deny anon
DROP POLICY IF EXISTS user_profiles_self_read ON user_profiles;
CREATE POLICY user_profiles_self_read ON user_profiles FOR SELECT TO authenticated
    USING (auth.uid() = id);

-- NFAs: Authoritative RLS for direct access
DROP POLICY IF EXISTS nfas_auth_read ON nfas;
CREATE POLICY nfas_auth_read ON nfas FOR SELECT TO authenticated
    USING (
        (status != 'draft') OR
        (auth.uid() = created_by)
    );

-- Audit Logs & Security Logs: Append-only or Super Admin view
DROP POLICY IF EXISTS security_audit_logs_insert ON security_audit_logs;
CREATE POLICY security_audit_logs_insert ON security_audit_logs FOR INSERT TO authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS emergency_mode_read ON emergency_mode_state;
CREATE POLICY emergency_mode_read ON emergency_mode_state FOR SELECT TO authenticated, anon
    USING (true);
