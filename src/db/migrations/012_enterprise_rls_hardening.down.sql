-- 012_enterprise_rls_hardening.down.sql
DROP TABLE IF EXISTS emergency_mode_state CASCADE;
DROP TABLE IF EXISTS security_alerts CASCADE;
DROP TABLE IF EXISTS security_audit_logs CASCADE;
DROP TABLE IF EXISTS user_mfa_settings CASCADE;
