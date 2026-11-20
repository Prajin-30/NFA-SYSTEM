-- Migration 006: Create Revoked Tokens Table for Durable Session Revocation
-- Survives container restarts, daily cycling, and multi-worker deployments.

BEGIN;

CREATE TABLE IF NOT EXISTS revoked_tokens (
    token_hash VARCHAR(64) PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON revoked_tokens(expires_at);

COMMIT;
