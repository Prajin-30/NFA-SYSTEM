-- Migration 004: Create Secure Resource Person Bank Details Table
-- Encrypted at rest (AES-256-GCM credentials).
-- RLS restricts read/write to creator and finance/super_admin roles.
-- Safe, additive migration preserving all existing institutional data.

BEGIN;

CREATE TABLE IF NOT EXISTS resource_person_bank_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nfa_id UUID NOT NULL REFERENCES nfas(id) ON DELETE CASCADE,
    -- Personal Information
    resource_person_name TEXT NOT NULL,
    designation TEXT,
    organization TEXT,
    email TEXT,
    mobile TEXT,
    honorarium_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    -- Banking Credentials (Encrypted at rest)
    account_holder_name TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    encrypted_account_number TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    masked_account_number TEXT NOT NULL,
    ifsc_code VARCHAR(11) NOT NULL,
    branch_name TEXT,
    remarks TEXT,
    -- Finance Honorarium Payment Tracking
    tracking_status TEXT NOT NULL DEFAULT 'details_submitted' CHECK (
        tracking_status IN (
            'details_pending', 'details_submitted', 'finance_verification',
            'ready_for_payment', 'payment_processing', 'paid',
            'returned_for_correction', 'payment_failed'
        )
    ),
    approved_honorarium NUMERIC(12, 2),
    deductions NUMERIC(12, 2) DEFAULT 0.00,
    net_payable_amount NUMERIC(12, 2),
    payment_date DATE,
    payment_ref_utr TEXT,
    payment_remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Performance and lookup index
CREATE INDEX IF NOT EXISTS idx_rp_bank_details_nfa_id ON resource_person_bank_details(nfa_id);

-- Enable Row Level Security (RLS)
ALTER TABLE resource_person_bank_details ENABLE ROW LEVEL SECURITY;

-- Policy 1: Creator of NFA can view bank details for their own NFAs
CREATE POLICY rp_bank_details_select_creator ON resource_person_bank_details
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM nfas 
            WHERE nfas.id = resource_person_bank_details.nfa_id 
              AND nfas.created_by = auth.uid()
        )
    );

-- Policy 2: Finance and Super Admin can view bank details for all NFAs
CREATE POLICY rp_bank_details_select_finance ON resource_person_bank_details
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM user_profiles 
            WHERE user_profiles.id = auth.uid() 
              AND user_profiles.role IN ('finance', 'finance_head', 'super_admin')
        )
    );

-- Policy 3: Creator of NFA can insert bank details for their own draft/returned NFAs
CREATE POLICY rp_bank_details_insert_creator ON resource_person_bank_details
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM nfas 
            WHERE nfas.id = resource_person_bank_details.nfa_id 
              AND nfas.created_by = auth.uid()
        )
    );

-- Policy 4: Creator can update bank details while NFA is in draft or revision_required
CREATE POLICY rp_bank_details_update_creator ON resource_person_bank_details
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM nfas 
            WHERE nfas.id = resource_person_bank_details.nfa_id 
              AND nfas.created_by = auth.uid()
              AND nfas.status IN ('draft', 'revision_required')
        )
    );

-- Policy 5: Super admin can manage all records
CREATE POLICY rp_bank_details_all_admin ON resource_person_bank_details
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM user_profiles 
            WHERE user_profiles.id = auth.uid() 
              AND user_profiles.role = 'super_admin'
        )
    );

COMMIT;
