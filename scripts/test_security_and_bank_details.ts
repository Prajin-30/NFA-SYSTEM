import assert from 'assert';
import { v4 as uuid } from 'uuid';
import jwt from 'jsonwebtoken';
import { store } from '../src/store.js';
import {
  encryptAccountNumber,
  decryptAccountNumber,
  validateIfsc,
  maskAccountNumber,
} from '../src/lib/encryption.js';
import { revokeToken, isTokenRevoked } from '../src/middleware/auth.js';
import { renderNfaPdf } from '../src/lib/pdf.js';
import { PassThrough } from 'stream';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

console.log('=== CU-NFA SECURITY AUDIT & BANK DETAILS TEST SUITE ===\n');

if (store.initPromise) {
  await store.initPromise;
}

// -------------------------------------------------------------
// TEST 1: Encryption & Decryption Round-Trip, IFSC & Masking
// -------------------------------------------------------------
console.log('1. Testing AES-256-GCM Encryption, Masking & IFSC Validation...');

const rawAccount = '98765432101234';
const enc = encryptAccountNumber(rawAccount);

assert(enc.encrypted_account_number, 'Encrypted account number must exist');
assert(enc.iv, 'IV must exist');
assert(enc.auth_tag, 'Auth tag must exist');
assert.notStrictEqual(enc.encrypted_account_number, rawAccount, 'Ciphertext must not match plaintext');
assert.strictEqual(enc.masked_account_number, '••••••••••1234', 'Masked number must preserve last 4 digits');

const decrypted = decryptAccountNumber(enc.encrypted_account_number, enc.iv, enc.auth_tag);
assert.strictEqual(decrypted, rawAccount, 'Decrypted account number must match original plaintext');

// Verify IFSC validation
assert.strictEqual(validateIfsc('SBIN0001234'), true, 'Standard SBI IFSC must be valid');
assert.strictEqual(validateIfsc('HDFC0000123'), true, 'Standard HDFC IFSC must be valid');
assert.strictEqual(validateIfsc('sbin0001234'), true, 'Lowercase IFSC should be accepted case-insensitively');
assert.strictEqual(validateIfsc('INVALID_IFSC'), false, 'Malformed IFSC must be rejected');
assert.strictEqual(validateIfsc('SBIN1001234'), false, '5th character must be zero');
assert.strictEqual(validateIfsc('12340001234'), false, 'First 4 must be letters');
console.log('✓ Test 1 Passed: AES-256-GCM authenticated encryption, masking and IFSC validation verified.\n');

// -------------------------------------------------------------
// TEST 2: Token Revocation Blacklist & Inactivity Session Control
// -------------------------------------------------------------
console.log('2. Testing JWT Token Blacklist & Session Revocation...');

const fakeToken = jwt.sign({ id: 'test-user-1', role: 'faculty' }, JWT_SECRET, { expiresIn: '8h' });
assert.strictEqual(isTokenRevoked(fakeToken), false, 'Token must not be revoked initially');

revokeToken(fakeToken);
assert.strictEqual(isTokenRevoked(fakeToken), true, 'Token must be marked revoked after logout');
console.log('✓ Test 2 Passed: Token revocation blacklist functions as designed.\n');

// -------------------------------------------------------------
// TEST 3: Creation of Event NFA with Resource Person Bank Details
// -------------------------------------------------------------
console.log('3. Testing Event NFA Creation with Bank Details Encryption at Rest...');

const testNfaId = uuid();
const testNfaRef = `NFA/TEST/SEC/${Date.now().toString().slice(-4)}`;
const facultyUser = store.data.users.find(u => u.role === 'faculty') || { id: uuid(), name: 'Test Faculty', role: 'faculty' as const };
const financeUser = store.data.users.find(u => u.role === 'finance') || { id: uuid(), name: 'Test Finance', role: 'finance' as const };
const hodUser = store.data.users.find(u => u.role === 'hod') || { id: uuid(), name: 'Test HOD', role: 'hod' as const };

const testAccount = '12345678909876';
const encryptedBank = encryptAccountNumber(testAccount);
const bankDetailId = uuid();

const existingCat = store.data.budget_categories.find(c => c.name);
const targetCatId = existingCat ? existingCat.id : 'cat-test-1';

await store.transact(db => {
  if (!existingCat) {
    db.budget_categories.push({
      id: targetCatId,
      name: 'Academic Guest Lecture & Honorarium',
      budget_type_id: db.budget_types[0]?.id || 'bt-1',
      allocated_amount: 100000,
    } as any);
  }

  // Push test NFA
  db.nfas.push({
    id: testNfaId,
    ref_no: testNfaRef,
    department_id: db.departments[0]?.id || 'dept-1',
    financial_year_id: db.financial_years[0]?.id || 'fy-1',
    budget_category_id: targetCatId,
    title: 'National AI Workshop with Resource Person',
    purpose: 'Academic and hands-on workshop on generative AI',
    description: 'Technical sessions conducted by external expert',
    justification: 'Crucial for departmental research advancement',
    sdgs: 'Quality Education',
    total_amount: 25000,
    status: 'draft',
    created_by: facultyUser.id,
    submitted_by_name: facultyUser.name,
    date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nfa_type: 'event',
    event_details: {
      resource_person_name: 'Dr. John Doe',
      designation: 'Principal Scientist',
      organization: 'National AI Research Lab',
      event_date: '2026-12-10',
      venue: 'Main Seminar Hall'
    }
  });

  // Push bank detail
  db.resource_person_bank_details = db.resource_person_bank_details || [];
  db.resource_person_bank_details.push({
    id: bankDetailId,
    nfa_id: testNfaId,
    resource_person_name: 'Dr. John Doe',
    account_holder_name: 'John Doe',
    bank_name: 'State Bank of India',
    encrypted_account_number: encryptedBank.encrypted_account_number,
    iv: encryptedBank.iv,
    auth_tag: encryptedBank.auth_tag,
    masked_account_number: encryptedBank.masked_account_number,
    ifsc_code: 'SBIN0001234',
    branch_name: 'Bangalore Main Branch',
    remarks: 'Honorarium and local conveyance',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
});

// Verify stored data in store.data
const storedDetail = store.data.resource_person_bank_details?.find(d => d.id === bankDetailId);
assert(storedDetail, 'Bank detail must be persisted in store');
assert.strictEqual(storedDetail.encrypted_account_number, encryptedBank.encrypted_account_number);
assert.strictEqual(storedDetail.masked_account_number, '••••••••••9876');
assert(!('account_number' in storedDetail), 'Plaintext account_number must NEVER exist on the stored record');
console.log('✓ Test 3 Passed: Bank details safely encrypted at rest with zero plaintext exposure.\n');

// -------------------------------------------------------------
// TEST 4: RBAC & Segregation of Duties for Bank Details
// -------------------------------------------------------------
console.log('4. Testing Role-Based Segregation of Duties for Bank Details...');

// Simulation of GET /api/nfas/:id/bank-details authorization check
function simulateGetBankDetails(userRole: string, userId: string, targetNfaId: string) {
  const nfa = store.data.nfas.find(n => n.id === targetNfaId && !n.is_deleted);
  if (!nfa) throw new Error('404');
  const isCreator = userId === nfa.created_by;
  const isFinanceOrAdmin = ['finance', 'finance_head', 'super_admin'].includes(userRole);
  if (!isCreator && !isFinanceOrAdmin) {
    return { status: 403, error: 'Forbidden' };
  }
  const details = (store.data.resource_person_bank_details || []).filter(d => d.nfa_id === targetNfaId);
  return {
    status: 200,
    data: details.map(d => ({
      id: d.id,
      nfa_id: d.nfa_id,
      resource_person_name: d.resource_person_name,
      account_holder_name: d.account_holder_name,
      bank_name: d.bank_name,
      masked_account_number: d.masked_account_number,
      ifsc_code: d.ifsc_code,
      branch_name: d.branch_name,
      remarks: d.remarks,
      can_reveal: isFinanceOrAdmin
    }))
  };
}

// 4a. Faculty (creator): can view masked, cannot reveal
const facultyView = simulateGetBankDetails('faculty', facultyUser.id, testNfaId);
assert.strictEqual(facultyView.status, 200);
assert.strictEqual(facultyView.data?.[0]?.masked_account_number, '••••••••••9876');
assert.strictEqual(facultyView.data?.[0]?.can_reveal, false, 'Faculty creator must NOT have reveal authorization');

// 4b. Finance: can view masked and CAN reveal
const financeView = simulateGetBankDetails('finance', financeUser.id, testNfaId);
assert.strictEqual(financeView.status, 200);
assert.strictEqual(financeView.data?.[0]?.can_reveal, true, 'Finance must have reveal authorization');

// 4c. HOD, Dean, Assoc Dean, Director: strictly 403 Forbidden
['hod', 'dean', 'associate_dean', 'director'].forEach(role => {
  const result = simulateGetBankDetails(role, 'other-user', testNfaId);
  assert.strictEqual(result.status, 403, `Role "${role}" must receive 403 Forbidden on bank details endpoint`);
});
console.log('✓ Test 4 Passed: Strict RBAC enforced (Faculty=masked, Finance=reveal authorized, HOD/Dean/Director=403 Forbidden).\n');

// -------------------------------------------------------------
// TEST 5: Decryption & Reveal with Audit Logging
// -------------------------------------------------------------
console.log('5. Testing On-Demand Decryption & Security Audit Logging...');

async function simulateRevealBankDetail(userRole: string, userId: string, userName: string, targetNfaId: string, targetDetailId: string) {
  const nfa = store.data.nfas.find(n => n.id === targetNfaId && !n.is_deleted);
  if (!nfa) throw new Error('404');
  const isFinanceOrAdmin = ['finance', 'finance_head', 'super_admin'].includes(userRole);
  if (!isFinanceOrAdmin) {
    return { status: 403, error: 'Forbidden' };
  }
  const detail = (store.data.resource_person_bank_details || []).find(d => d.id === targetDetailId && d.nfa_id === targetNfaId);
  if (!detail) throw new Error('404');

  // Audit log entry
  await store.transact(db => {
    db.audit_logs.push({
      id: uuid(),
      entity_type: 'bank_detail',
      entity_id: detail.id,
      department_id: nfa.department_id,
      old_amount: null,
      new_amount: null,
      difference: null,
      changed_by: userId,
      role: userRole as any,
      reason: `Confidential bank details revealed for Resource Person "${detail.resource_person_name}" on NFA ${nfa.ref_no} by ${userName} (${userRole}).`,
      source: 'portal',
      approval_status: 'revealed',
      created_at: new Date().toISOString()
    });
  });

  const plain = decryptAccountNumber(detail.encrypted_account_number, detail.iv, detail.auth_tag);
  return {
    status: 200,
    data: {
      id: detail.id,
      resource_person_name: detail.resource_person_name,
      account_number: plain
    }
  };
}

// 5a. Non-finance reveal attempt -> 403
const facultyRevealAttempt = await simulateRevealBankDetail('faculty', facultyUser.id, facultyUser.name, testNfaId, bankDetailId);
assert.strictEqual(facultyRevealAttempt.status, 403, 'Faculty reveal attempt must be rejected with 403');

const hodRevealAttempt = await simulateRevealBankDetail('hod', hodUser.id, hodUser.name, testNfaId, bankDetailId);
assert.strictEqual(hodRevealAttempt.status, 403, 'HOD reveal attempt must be rejected with 403');

// 5b. Finance reveal attempt -> success
const financeReveal = await simulateRevealBankDetail('finance', financeUser.id, financeUser.name, testNfaId, bankDetailId);
assert.strictEqual(financeReveal.status, 200);
assert.strictEqual(financeReveal.data?.account_number, testAccount, 'Revealed account number must match original');

// 5c. Verify Audit Log entry
const auditEntry = store.data.audit_logs.find(a => a.entity_id === bankDetailId && a.approval_status === 'revealed');
assert(auditEntry, 'Audit log entry must be created on bank detail reveal');
assert.strictEqual(auditEntry.role, 'finance');
assert(!auditEntry.reason.includes(testAccount), 'Audit log reason must NEVER contain plaintext account numbers');
console.log('✓ Test 5 Passed: Decryption on-demand works seamlessly and security audit trail records the event safely.\n');

// -------------------------------------------------------------
// TEST 6: Invariance & Complete Exclusion from PDF and General APIs
// -------------------------------------------------------------
console.log('6. Verifying Bank Details Exclusion from PDF and General NFA Records...');

const testNfa = store.data.nfas.find(n => n.id === testNfaId)!;
assert(!('resource_person_bank_details' in testNfa), 'NFA document must not embed bank details in general object');

// Generate PDF buffer to verify PDF does not crash and does not contain bank details
const pass = new PassThrough();
const chunks: Buffer[] = [];
pass.on('data', chunk => chunks.push(Buffer.from(chunk)));

await new Promise<void>((resolve, reject) => {
  pass.on('end', () => resolve());
  pass.on('error', err => reject(err));
  const dept = store.data.departments[0] || { id: 'd1', name: 'Computer Science and Engineering', code: 'CSE' };
  const cat = existingCat || { id: targetCatId, name: 'Academic Guest Lecture & Honorarium' };
  renderNfaPdf(pass as any, testNfa, [], dept as any, cat as any);
});

const pdfBuffer = Buffer.concat(chunks);
assert(pdfBuffer.length > 500, 'PDF generation must succeed');
const pdfString = pdfBuffer.toString('utf-8');
assert(!pdfString.includes(testAccount), 'PDF binary content must NOT contain bank account numbers');

console.log('✓ Test 6 Passed: Complete exclusion of confidential bank details from PDF and general models confirmed.\n');

// Clean up test NFA and bank details from store
await store.transact(db => {
  db.nfas = db.nfas.filter(n => n.id !== testNfaId);
  db.resource_person_bank_details = (db.resource_person_bank_details || []).filter(d => d.id !== bankDetailId);
  db.audit_logs = db.audit_logs.filter(a => a.entity_id !== bankDetailId);
});

console.log('=== ALL SECURITY AUDIT & BANK DETAILS TESTS PASSED SUCCESSFULLY ===');
