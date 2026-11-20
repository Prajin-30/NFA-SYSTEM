import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import http from 'http';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import {
  revokeToken,
  isTokenRevoked,
  revokedTokenSet,
  loadRevokedTokensFromStore,
  signToken
} from '../src/middleware/auth.js';
import { encryptAccountNumber, decryptAccountNumber } from '../src/lib/encryption.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('=== CU-NFA STAGE 1 VERIFICATION & REGRESSION SUITE ===\n');

  // ----------------------------------------------------
  // TEST 1: Frontend TABS_BY_ROLE and isInstitutionalRole
  // ----------------------------------------------------
  console.log('[TEST 1] Verifying public/index.html role navigation & institutional visibility...');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  // Check deans_office in TABS_BY_ROLE
  assert(indexHtml.includes("deans_office: ['dashboard', 'inbox', 'nfas', 'invoices', 'budgets', 'audit']"),
    'deans_office must be present in TABS_BY_ROLE with inbox');
  // Check finance_head in TABS_BY_ROLE
  assert(indexHtml.includes("finance_head: ['dashboard', 'inbox', 'nfas', 'invoices', 'budgets', 'audit']"),
    'finance_head must be present in TABS_BY_ROLE with inbox');

  // Check isInstitutionalRole in renderHome
  assert(indexHtml.includes("['super_admin', 'director', 'finance', 'finance_head', 'dean', 'associate_dean', 'deans_office'].includes(USER.role)"),
    'isInstitutionalRole must include deans_office and finance_head');

  console.log('  PASS: TABS_BY_ROLE and isInstitutionalRole verified for deans_office & finance_head.\n');

  // ----------------------------------------------------
  // TEST 2: Encryption Key Decoupling & Dedicated Key Enforcement
  // ----------------------------------------------------
  console.log('[TEST 2] Verifying BANK_DETAILS_ENCRYPTION_KEY decoupling and enforcement...');
  
  // Test round-trip with dedicated key
  const testAccount = '987654321098';
  const encrypted = encryptAccountNumber(testAccount);
  assert(encrypted.encrypted_account_number, 'Encrypted account number must exist');
  assert(encrypted.masked_account_number === '••••••••1098', 'Masked account number must mask all but last 4 digits');

  const decrypted = decryptAccountNumber(encrypted.encrypted_account_number, encrypted.iv, encrypted.auth_tag);
  assert.strictEqual(decrypted, testAccount, 'Decrypted account number must match original plaintext');

  // Verify that JWT_SECRET fallback is removed
  const originalKey = process.env.BANK_DETAILS_ENCRYPTION_KEY;
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.BANK_DETAILS_ENCRYPTION_KEY;
    process.env.NODE_ENV = 'production';
    let threw = false;
    try {
      encryptAccountNumber('1234567890');
    } catch (e: any) {
      threw = true;
      assert(e.message.includes('BANK_DETAILS_ENCRYPTION_KEY is required'), 'Error must specify BANK_DETAILS_ENCRYPTION_KEY is required');
      assert(e.message.includes('Fallback to JWT_SECRET has been permanently deprecated'), 'Must state fallback is deprecated');
    }
    assert(threw, 'Must throw fatal configuration error when BANK_DETAILS_ENCRYPTION_KEY is missing in non-test mode');
  } finally {
    process.env.BANK_DETAILS_ENCRYPTION_KEY = originalKey;
    process.env.NODE_ENV = originalNodeEnv;
  }

  console.log('  PASS: Dedicated bank encryption key enforced and decoupling confirmed.\n');

  // ----------------------------------------------------
  // TEST 3: Persistent Session Revocation Across Server Restarts
  // ----------------------------------------------------
  console.log('[TEST 3] Verifying persistent session revocation across simulated container restarts...');

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const user = store.data.users[0] || {
      id: '05fee8aa-7cd5-4168-bc21-3b20ea533f62',
      name: 'Dr Arul V',
      email: 'faculty@christ.edu',
      role: 'faculty',
      department_id: '330ada81-5246-4c92-9ca2-688eae0f28d4',
    };

    const token = signToken({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as any,
      department_id: user.department_id,
      authorized_centre_ids: [],
    });

    // Verify token works initially
    const res1 = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res1.status, 200, 'Active token must access protected endpoint');

    // Revoke token via logout
    await revokeToken(token);
    assert(isTokenRevoked(token), 'Token must be revoked immediately in memory');

    // Verify token is rejected
    const res2 = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res2.status, 401, 'Revoked token must be rejected with 401');

    // SIMULATE SERVER RESTART:
    // 1. Wipe in-memory revokedTokenSet completely
    revokedTokenSet.clear();
    assert.strictEqual(revokedTokenSet.size, 0, 'In-memory set must be cleared to simulate container crash/restart');

    // 2. Hydrate from persistent store as happens on server boot
    loadRevokedTokensFromStore();

    // 3. Check that token remains revoked after restart
    assert(isTokenRevoked(token), 'Token must remain revoked after server restart');

    const res3 = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res3.status, 401, 'Revoked token must still be rejected with 401 after restart');

    console.log('  PASS: Persistent session revocation successfully survived server restart.\n');
  } finally {
    server.close();
  }

  console.log('=== ALL STAGE 1 TESTS PASSED SUCCESSFULLY! ===\n');
}

main().catch((err) => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
