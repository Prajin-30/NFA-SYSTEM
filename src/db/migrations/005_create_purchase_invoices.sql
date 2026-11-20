-- Migration 005: Create Purchase Invoices Table
-- Tracks invoice submissions, attachments, finance verification, and payment execution.
-- RLS restricts invoice upload and view permissions.

BEGIN;

CREATE TABLE IF NOT EXISTS purchase_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nfa_id UUID NOT NULL REFERENCES nfas(id) ON DELETE CASCADE,
    invoice_number TEXT NOT NULL,
    invoice_date DATE NOT NULL,
    vendor_name TEXT NOT NULL,
    invoice_amount NUMERIC(14, 2) NOT NULL,
    gst_amount NUMERIC(14, 2) DEFAULT 0.00,
    file_id UUID,
    original_filename TEXT,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    uploaded_by UUID NOT NULL REFERENCES user_profiles(id),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    -- Verification Lifecycle
    verification_status TEXT NOT NULL DEFAULT 'pending_verification' CHECK (
        verification_status IN ('pending_verification', 'verified', 'returned')
    ),
    verified_by UUID REFERENCES user_profiles(id),
    verified_at TIMESTAMPTZ,
    return_reason TEXT,
    -- Payment Lifecycle
    payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (
        payment_status IN ('unpaid', 'in_process', 'paid')
    ),
    paid_amount NUMERIC(14, 2) DEFAULT 0.00,
    payment_date DATE,
    payment_ref_utr TEXT,
    payment_remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_nfa_invoice UNIQUE (nfa_id, invoice_number, vendor_name)
);

-- Performance and query indexes
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_nfa_id ON purchase_invoices(nfa_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_status ON purchase_invoices(verification_status, payment_status);

-- Enable Row Level Security (RLS)
ALTER TABLE purchase_invoices ENABLE ROW LEVEL SECURITY;

-- Policy 1: Faculty can view invoices for their own approved NFAs
CREATE POLICY purchase_invoices_select_owner ON purchase_invoices
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM nfas 
            WHERE nfas.id = purchase_invoices.nfa_id 
              AND nfas.created_by = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM user_profiles 
            WHERE user_profiles.id = auth.uid() 
              AND user_profiles.role IN ('finance', 'finance_head', 'super_admin', 'director', 'dean', 'hod')
        )
    );

-- Policy 2: Faculty can insert invoices for their own finally approved Purchase NFAs
CREATE POLICY purchase_invoices_insert_faculty ON purchase_invoices
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM nfas 
            WHERE nfas.id = purchase_invoices.nfa_id 
              AND nfas.created_by = auth.uid()
              AND nfas.status = 'approved'
              AND (nfas.nfa_type = 'purchase' OR nfas.purchase_details IS NOT NULL)
        )
    );

-- Policy 3: Faculty can update invoices returned for correction
CREATE POLICY purchase_invoices_update_faculty ON purchase_invoices
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM nfas 
            WHERE nfas.id = purchase_invoices.nfa_id 
              AND nfas.created_by = auth.uid()
              AND purchase_invoices.verification_status = 'returned'
        )
    );

-- Policy 4: Finance Office, Finance Head, Super Admin can manage all invoices
CREATE POLICY purchase_invoices_manage_finance ON purchase_invoices
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM user_profiles 
            WHERE user_profiles.id = auth.uid() 
              AND user_profiles.role IN ('finance', 'finance_head', 'super_admin')
        )
    );

COMMIT;
