import assert from 'assert';
import { v4 as uuid } from 'uuid';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import type { Server } from 'http';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

function generateToken(user: any): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      department_id: user.department_id,
    },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

async function runTests() {
  console.log('=== CU-NFA PURCHASE INVOICE MONITORING & RESOURCE PERSON BANK DETAILS TEST SUITE ===\n');

  // Start ephemeral test server
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    if (store.initPromise) {
      await store.initPromise;
    }

    // Find authorized users (must have must_change_password = false)
    const facultyUser = store.data.users.find((u) => u.email === 'arul.v@christuniversity.in') || store.data.users.find((u) => u.role === 'faculty' && !u.must_change_password);
    const financeUser = store.data.users.find((u) => u.email === 'accounts.ke@christuniversity.in') || store.data.users.find((u) => (u.role === 'finance' || u.role === 'finance_head') && !u.must_change_password);
    const hodUser = store.data.users.find((u) => u.email === 'michael.moses@christuniversity.in') || store.data.users.find((u) => u.role === 'hod' && !u.must_change_password);
    const adminUser = store.data.users.find((u) => u.role === 'super_admin' && !u.must_change_password) || store.data.users.find((u) => u.role === 'super_admin');

    assert(facultyUser, 'Faculty user must exist');
    assert(financeUser, 'Finance user must exist');
    assert(adminUser, 'Admin user must exist');

    const facultyToken = generateToken(facultyUser);
    const financeToken = generateToken(financeUser);
    const hodToken = generateToken(hodUser!);
    const adminToken = generateToken(adminUser);

    const activeFy = store.data.financial_years.find((f) => f.is_active) || store.data.financial_years[0];
    const adseDept = store.data.departments.find((d) => d.code === 'ADSE') || store.data.departments[0];
    const cat = store.data.budget_categories[0];

    async function req(
      method: string,
      endpoint: string,
      token: string,
      body?: any
    ): Promise<{ status: number; body: any }> {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };
      if (body) headers['Content-Type'] = 'application/json';

      const res = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      let json = {};
      try {
        json = await res.json();
      } catch {
        json = {};
      }
      return { status: res.status, body: json };
    }

    // ==========================================
    // PART 1: PURCHASE INVOICE MONITORING TESTS
    // ==========================================
    console.log('--- PART 1: PURCHASE INVOICE MONITORING TESTS ---');

    // Test 1: Eligibility Rules
    console.log('1. Testing Eligibility Rules (Draft, Pending, Event vs Approved Purchase)...');

    // 1a. Create Draft Purchase NFA
    const draftPurchaseId = uuid();
    await store.transact((db) => {
      db.nfas.push({
        id: draftPurchaseId,
        ref_no: `NFA/TEST/PUR-DRAFT/${Date.now()}`,
        department_id: adseDept.id,
        financial_year_id: activeFy.id,
        budget_category_id: cat.id,
        title: 'Draft Lab Equipment Purchase',
        purpose: 'Draft',
        description: 'Draft',
        justification: 'Draft',
        sdgs: '4',
        total_amount: 50000,
        status: 'draft',
        created_by: facultyUser.id,
        date: '2026-11-20',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        nfa_type: 'purchase',
        purchase_details: { item_name: 'Oscilloscope' },
      });
    });

    const resDraftUpload = await req('POST', `/api/invoices/${draftPurchaseId}`, facultyToken, {
      invoice_number: 'INV-TEST-001',
      invoice_date: '2026-11-20',
      vendor_name: 'Tektronix India',
      invoice_amount: 20000,
      file_path: 'test_inv_doc.pdf',
    });
    assert.strictEqual(resDraftUpload.status, 400, 'Uploading invoice on draft Purchase NFA must be rejected');
    assert(resDraftUpload.body.error.includes('approved'), 'Error must specify NFA must be approved');

    // 1b. Create Pending Purchase NFA
    const pendingPurchaseId = uuid();
    await store.transact((db) => {
      db.nfas.push({
        id: pendingPurchaseId,
        ref_no: `NFA/TEST/PUR-PEND/${Date.now()}`,
        department_id: adseDept.id,
        financial_year_id: activeFy.id,
        budget_category_id: cat.id,
        title: 'Pending Lab Equipment Purchase',
        purpose: 'Pending',
        description: 'Pending',
        justification: 'Pending',
        sdgs: '4',
        total_amount: 50000,
        status: 'pending_hod_review',
        created_by: facultyUser.id,
        date: '2026-11-20',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        nfa_type: 'purchase',
        purchase_details: { item_name: 'Oscilloscope' },
      });
    });

    const resPendingUpload = await req('POST', `/api/invoices/${pendingPurchaseId}`, facultyToken, {
      invoice_number: 'INV-TEST-002',
      invoice_date: '2026-11-20',
      vendor_name: 'Tektronix India',
      invoice_amount: 20000,
      file_path: 'test_inv_doc.pdf',
    });
    assert.strictEqual(resPendingUpload.status, 400, 'Uploading invoice on pending Purchase NFA must be rejected');

    // 1c. Create Approved Event NFA (must be rejected for invoices)
    const approvedEventId = uuid();
    await store.transact((db) => {
      db.nfas.push({
        id: approvedEventId,
        ref_no: `NFA/TEST/EVT-APP/${Date.now()}`,
        department_id: adseDept.id,
        financial_year_id: activeFy.id,
        budget_category_id: cat.id,
        title: 'Approved AI Workshop',
        purpose: 'Event',
        description: 'Event',
        justification: 'Event',
        sdgs: '4',
        total_amount: 25000,
        status: 'approved',
        created_by: facultyUser.id,
        date: '2026-11-20',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        nfa_type: 'event',
      });
    });

    const resEventUpload = await req('POST', `/api/invoices/${approvedEventId}`, facultyToken, {
      invoice_number: 'INV-TEST-003',
      invoice_date: '2026-11-20',
      vendor_name: 'Tektronix India',
      invoice_amount: 10000,
      file_path: 'test_inv_doc.pdf',
    });
    assert.strictEqual(resEventUpload.status, 400, 'Uploading invoice on Event NFA must be rejected');
    assert(resEventUpload.body.error.includes('Purchase'), 'Error must specify invoice monitoring is only for Purchase NFAs');
    console.log('✓ Test 1 Passed: Ineligibility of Draft, Pending, and Event NFAs strictly enforced.');

    // Test 2: Multi-Invoice Upload, Financial Ceiling & Duplicate Prevention
    console.log('\n2. Testing Multi-Invoice Upload, Financial Ceiling & Duplicate Prevention...');

    // Create Finally Approved Purchase NFA of ₹50,000
    const approvedPurchaseId = uuid();
    const approvedPurchaseRef = `NFA/ADSE/2026-27/${Date.now().toString().slice(-4)}`;
    await store.transact((db) => {
      db.nfas.push({
        id: approvedPurchaseId,
        ref_no: approvedPurchaseRef,
        department_id: adseDept.id,
        financial_year_id: activeFy.id,
        budget_category_id: cat.id,
        title: 'Approved Workstation Cluster Purchase',
        purpose: 'Lab hardware',
        description: 'Hardware for AI cluster',
        justification: 'Required for compute',
        sdgs: '9',
        total_amount: 50000,
        status: 'approved',
        created_by: facultyUser.id,
        submitted_by_name: facultyUser.name,
        date: '2026-11-20',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        nfa_type: 'purchase',
        purchase_details: { item_name: 'GPU Server Rack' },
      });
    });

    // 2a. Submit Invoice 1: ₹20,000
    const resInv1 = await req('POST', `/api/invoices/${approvedPurchaseId}`, facultyToken, {
      invoice_number: 'INV-GPU-001',
      invoice_date: '2026-11-20',
      vendor_name: 'NVIDIA Hardware Partner',
      invoice_amount: 20000,
      gst_amount: 3600,
      file_path: 'nvidia_invoice_1.pdf',
      remarks: 'First consignment 1x GPU unit',
    });
    assert.strictEqual(resInv1.status, 201, 'Invoice 1 must be created with status 201');
    const inv1 = resInv1.body;
    assert.strictEqual(inv1.verification_status, 'pending_verification');
    assert.strictEqual(inv1.payment_status, 'unpaid');

    // 2b. Submit Invoice 2: ₹15,000
    const resInv2 = await req('POST', `/api/invoices/${approvedPurchaseId}`, facultyToken, {
      invoice_number: 'INV-GPU-002',
      invoice_date: '2026-11-20',
      vendor_name: 'NVIDIA Hardware Partner',
      invoice_amount: 15000,
      gst_amount: 2700,
      file_path: 'nvidia_invoice_2.pdf',
      remarks: 'Second consignment 1x GPU unit',
    });
    assert.strictEqual(resInv2.status, 201, 'Invoice 2 must be created with status 201');
    const inv2 = resInv2.body;

    // 2c. Attempt Duplicate Submission (Same Invoice Number & Vendor)
    const resDup = await req('POST', `/api/invoices/${approvedPurchaseId}`, facultyToken, {
      invoice_number: 'INV-GPU-001', // Duplicate
      invoice_date: '2026-11-20',
      vendor_name: 'NVIDIA Hardware Partner',
      invoice_amount: 20000,
      file_path: 'nvidia_invoice_1_dup.pdf',
    });
    assert.strictEqual(resDup.status, 400, 'Duplicate invoice submission must be blocked');
    assert(resDup.body.error.includes('already exists'), 'Duplicate message must indicate invoice already exists');

    // 2d. Attempt Over-Ceiling Invoice (Remaining: ₹15,000; Attempting ₹20,000)
    const resOver = await req('POST', `/api/invoices/${approvedPurchaseId}`, facultyToken, {
      invoice_number: 'INV-GPU-003',
      invoice_date: '2026-11-20',
      vendor_name: 'NVIDIA Hardware Partner',
      invoice_amount: 20000, // Exceeds remaining 15,000
      file_path: 'nvidia_invoice_3.pdf',
    });
    assert.strictEqual(resOver.status, 400, 'Invoice exceeding approved balance must be blocked');
    assert(resOver.body.error.includes('exceeds the remaining approved'), 'Over-ceiling error message confirmed');

    // 2e. Verify Invoices List endpoint returns accurate financial metrics
    const resList = await req('GET', `/api/invoices?fy=${activeFy.id}`, facultyToken);
    assert.strictEqual(resList.status, 200);
    const nfaEntry = resList.body.find((item: any) => item.nfa_id === approvedPurchaseId);
    assert(nfaEntry, 'Approved Purchase NFA must appear in invoices list');
    assert.strictEqual(nfaEntry.approved_amount, 50000);
    assert.strictEqual(nfaEntry.total_invoiced, 35000); // 20k + 15k
    assert.strictEqual(nfaEntry.remaining_uninvoiced, 15000);
    assert.strictEqual(nfaEntry.invoices_count, 2);
    assert.strictEqual(nfaEntry.invoice_status, 'partially_invoiced');

    console.log('✓ Test 2 Passed: Multi-invoice tracking, duplicate detection, and ceiling enforcement verified.');

    // Test 3: Invoice Permissions & Verification / Payment Workflow
    console.log('\n3. Testing Invoice Verification, Return, Resubmission & Payment Workflow...');

    // 3a. Faculty cannot verify or mark Paid
    const resFacultyVerify = await req('POST', `/api/invoices/${inv1.id}/verify`, facultyToken, {
      decision: 'verified',
    });
    assert.strictEqual(resFacultyVerify.status, 403, 'Faculty must be forbidden from verifying invoices');

    const resFacultyPay = await req('POST', `/api/invoices/${inv1.id}/payment`, facultyToken, {
      payment_status: 'paid',
    });
    assert.strictEqual(resFacultyPay.status, 403, 'Faculty must be forbidden from marking invoices as Paid');

    // 3b. Finance returns Invoice 2 for correction
    const resReturn = await req('POST', `/api/invoices/${inv2.id}/verify`, financeToken, {
      decision: 'returned',
      remarks: 'Missing vendor GST seal on document',
    });
    assert.strictEqual(resReturn.status, 200);

    let updatedInv2 = (store.data.purchase_invoices || []).find((i) => i.id === inv2.id);
    assert.strictEqual(updatedInv2?.verification_status, 'returned');
    assert.strictEqual(updatedInv2?.return_reason, 'Missing vendor GST seal on document');

    // 3c. Faculty corrects and resubmits Invoice 2
    const resCorrect = await req('PUT', `/api/invoices/${inv2.id}`, facultyToken, {
      invoice_number: 'INV-GPU-002',
      invoice_date: '2026-11-20',
      vendor_name: 'NVIDIA Hardware Partner',
      invoice_amount: 15000,
      remarks: 'Vendor GST seal affixed and re-uploaded',
    });
    assert.strictEqual(resCorrect.status, 200);
    updatedInv2 = (store.data.purchase_invoices || []).find((i) => i.id === inv2.id);
    assert.strictEqual(updatedInv2?.verification_status, 'pending_verification', 'Resubmitted invoice must reset to pending_verification');

    // 3d. Finance verifies Invoice 1
    const resVerify1 = await req('POST', `/api/invoices/${inv1.id}/verify`, financeToken, {
      decision: 'verified',
    });
    assert.strictEqual(resVerify1.status, 200);

    let updatedInv1 = (store.data.purchase_invoices || []).find((i) => i.id === inv1.id);
    assert.strictEqual(updatedInv1?.verification_status, 'verified');

    // 3e. Finance records Payment with UTR for Invoice 1
    const resPay1 = await req('POST', `/api/invoices/${inv1.id}/payment`, financeToken, {
      payment_status: 'paid',
      paid_amount: 20000,
      payment_date: '2026-11-20',
      payment_ref_utr: 'UTR9988776655',
      payment_remarks: 'Disbursed via RTGS transfer',
    });
    assert.strictEqual(resPay1.status, 200);

    updatedInv1 = (store.data.purchase_invoices || []).find((i) => i.id === inv1.id);
    assert.strictEqual(updatedInv1?.payment_status, 'paid');
    assert.strictEqual(updatedInv1?.payment_ref_utr, 'UTR9988776655');

    console.log('✓ Test 3 Passed: Segregation of duties, return-correction lifecycle, and payment recording verified.');

    // Test 4: Dashboard Summary Counts & Academic Year Filtering
    console.log('\n4. Testing Dashboard Summary Counts...');
    const resDash = await req('GET', `/api/invoices/dashboard-summary?fy=${activeFy.id}`, facultyToken);
    assert.strictEqual(resDash.status, 200);
    const dashData = resDash.body;
    assert.strictEqual(dashData.has_approved_purchases, true, 'User has approved purchase NFA');
    assert(dashData.total_invoices >= 2, 'Total invoices >= 2');
    assert(dashData.paid >= 1, 'Paid invoices count >= 1');
    console.log(
      `✓ Test 4 Passed: Dashboard counts verified: Total: ${dashData.total_invoices}, Pending: ${dashData.pending_verification}, Awaiting Payment: ${dashData.awaiting_payment}, Paid: ${dashData.paid}`
    );

    // ==========================================
    // PART 2: RESOURCE PERSON BANK DETAILS TESTS
    // ==========================================
    console.log('\n--- PART 2: RESOURCE PERSON BANK DETAILS TESTS ---');

    // Test 5: Multiple Resource Persons with Complete Information & Reconciliation
    console.log('5. Testing Multi-Resource Person Creation, Validation & AES-256-GCM Encryption...');

    const eventProposalRef = `NFA/ADSE/2026-27/${Date.now().toString().slice(-4)}`;

    const resEventCreate = await req('POST', '/api/nfas', facultyToken, {
      ref_no: eventProposalRef,
      department_id: adseDept.id,
      financial_year_id: activeFy.id,
      budget_category_id: cat.id,
      title: 'National AI Symposium 2026',
      purpose: 'Keynote and hands-on workshops',
      nfa_type: 'event',
      point1: 'Purpose',
      point2: 'Logistics',
      point3: 'Justification',
      point4: 'Expenditure',
      sdgs: '4,9',
      items: [
        { sl_no: 1, particulars: 'Keynote Speaker Honorarium', quantity: '1', rate: 5000, amount: 5000 },
        { sl_no: 2, particulars: 'Workshop Expert Honorarium', quantity: '1', rate: 3000, amount: 3000 },
        { sl_no: 3, particulars: 'Guest Speaker Travel Honorarium', quantity: '1', rate: 4000, amount: 4000 },
      ],
      total_amount: 12000,
      resource_person_bank_details: [
        {
          resource_person_name: 'Dr. Jane Smith',
          designation: 'Professor & Head of AI',
          organization: 'Indian Institute of Science, Bangalore',
          email: 'jane.smith@iisc.ac.in',
          mobile: '9876543210',
          honorarium_amount: 5000,
          account_holder_name: 'JANE SMITH',
          bank_name: 'State Bank of India',
          branch_name: 'IISc Campus, Bangalore',
          ifsc_code: 'SBIN0002215',
          account_number: '123456789012',
          confirm_account_number: '123456789012',
          remarks: 'Keynote honorarium',
        },
        {
          resource_person_name: 'Dr. Robert Miller',
          designation: 'Principal Scientist',
          organization: 'ISRO Satellite Centre',
          email: 'robert.miller@isro.gov.in',
          mobile: '9811223344',
          honorarium_amount: 3000,
          account_holder_name: 'ROBERT MILLER',
          bank_name: 'HDFC Bank',
          branch_name: 'Indiranagar Branch, Bangalore',
          ifsc_code: 'HDFC0000123',
          account_number: '987654321098',
          confirm_account_number: '987654321098',
          remarks: 'Workshop session honorarium',
        },
      ],
    });

    assert.strictEqual(resEventCreate.status, 201, 'Event NFA with multi-resource persons must be created');
    const createdNfa = resEventCreate.body;

    // Verify at-rest encryption in store
    const storedBds = (store.data.resource_person_bank_details || []).filter((d) => d.nfa_id === createdNfa.id);
    assert.strictEqual(storedBds.length, 2, 'Exactly 2 resource persons must be stored');

    storedBds.forEach((bd) => {
      assert(bd.encrypted_account_number, 'Account number must be encrypted');
      assert.strictEqual(bd.encrypted_account_number.includes('123456789012'), false, 'Plaintext must not exist at rest');
      assert.strictEqual(bd.encrypted_account_number.includes('987654321098'), false, 'Plaintext must not exist at rest');
      assert(bd.iv, 'IV must be present');
      assert(bd.auth_tag, 'Auth tag must be present');
      assert.strictEqual(bd.masked_account_number.startsWith('••••'), true, 'Masked number must start with bullets');
      assert.strictEqual(bd.tracking_status, 'details_submitted', 'Initial tracking status must be details_submitted');
    });

    console.log('✓ Test 5 Passed: Multi-resource persons created with AES-256-GCM encryption at rest.');

    // Test 6: Access Permissions & Audited Plaintext Reveal
    console.log('\n6. Testing Role-Based Bank Access & Audited Account Reveal...');

    // 6a. Faculty sees masked details only
    const resFacultyBds = await req('GET', `/api/nfas/${createdNfa.id}/bank-details`, facultyToken);
    assert.strictEqual(resFacultyBds.status, 200);
    assert.strictEqual(resFacultyBds.body.length, 2);
    assert.strictEqual(resFacultyBds.body[0].can_reveal, false, 'Faculty must not have reveal permission');
    assert.strictEqual(resFacultyBds.body[0].masked_account_number, '••••••••9012');
    assert.strictEqual(resFacultyBds.body[1].masked_account_number, '••••••••1098');

    // 6b. Faculty cannot reveal plaintext account
    const resFacultyReveal = await req(
      'POST',
      `/api/nfas/${createdNfa.id}/bank-details/${storedBds[0].id}/reveal`,
      facultyToken
    );
    assert.strictEqual(resFacultyReveal.status, 403, 'Faculty must be forbidden from revealing full account');

    // 6c. Finance can reveal plaintext account with audit trail
    const initialAuditCount = store.data.audit_logs.length;
    const resFinanceReveal = await req(
      'POST',
      `/api/nfas/${createdNfa.id}/bank-details/${storedBds[0].id}/reveal`,
      financeToken
    );
    assert.strictEqual(resFinanceReveal.status, 200);
    assert.strictEqual(resFinanceReveal.body.account_number, '123456789012', 'Decrypted account number must match original');

    // Verify audit log entry
    assert(store.data.audit_logs.length > initialAuditCount, 'Audit log entry must be created');
    const auditEntry = store.data.audit_logs[store.data.audit_logs.length - 1];
    assert(auditEntry.reason.includes('Confidential bank details revealed'), 'Audit reason must record reveal');
    assert.strictEqual(auditEntry.reason.includes('123456789012'), false, 'Audit log must never store plaintext account');

    console.log('✓ Test 6 Passed: RBAC and audited reveal verified.');

    // Test 7: Finance Payment Tracking for Resource Persons
    console.log('\n7. Testing Honorarium Payment Tracking Lifecycle...');

    // Finance updates Dr. Jane Smith tracking to 'paid' with deductions and UTR
    const resTracking = await req(
      'POST',
      `/api/nfas/${createdNfa.id}/bank-details/${storedBds[0].id}/payment-tracking`,
      financeToken,
      {
        tracking_status: 'paid',
        approved_honorarium: 5000,
        deductions: 500, // TDS
        net_payable_amount: 4500,
        payment_date: '2026-11-20',
        payment_ref_utr: 'UTR-HON-112233',
        payment_remarks: 'NEFT transfer completed with 10% TDS deduction',
      }
    );
    assert.strictEqual(resTracking.status, 200);

    const updatedBd = (store.data.resource_person_bank_details || []).find((d) => d.id === storedBds[0].id);
    assert.strictEqual(updatedBd?.tracking_status, 'paid');
    assert.strictEqual(updatedBd?.approved_honorarium, 5000);
    assert.strictEqual(updatedBd?.deductions, 500);
    assert.strictEqual(updatedBd?.net_payable_amount, 4500);
    assert.strictEqual(updatedBd?.payment_ref_utr, 'UTR-HON-112233');

    console.log('✓ Test 7 Passed: Multi-stage honorarium payment tracking, deductions, and UTR recording verified.');

    // Clean up test data
    console.log('\n--- CLEANING UP TEST ARTIFACTS ---');
    await store.transact((db) => {
      const testIds = new Set([draftPurchaseId, pendingPurchaseId, approvedEventId, approvedPurchaseId, createdNfa.id]);
      db.nfas = db.nfas.filter((n) => !testIds.has(n.id));
      db.purchase_invoices = (db.purchase_invoices || []).filter((i) => !testIds.has(i.nfa_id));
      db.resource_person_bank_details = (db.resource_person_bank_details || []).filter((d) => !testIds.has(d.nfa_id));
    });
    console.log('✓ Test records cleanly removed.');

    console.log('\n================================================================');
    console.log('ALL PURCHASE INVOICE & RESOURCE PERSON BANK TESTS PASSED! (7/7)');
    console.log('================================================================');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
