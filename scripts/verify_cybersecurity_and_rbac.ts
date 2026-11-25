process.env.DATA_SOURCE = process.env.DATA_SOURCE || 'json';
process.env.NODE_ENV = 'test';
import assert from 'assert';
import http from 'http';
import speakeasy from 'speakeasy';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';
import { validateFileBuffer, sanitizeFormulaInjection } from '../src/lib/fileValidation.js';
import { securityService } from '../src/services/securityService.js';
import { v4 as uuid } from 'uuid';

async function main() {
  console.log('\n=============================================================');
  console.log('   CU-NFA ENTERPRISE CYBERSECURITY & RBAC AUDIT SUITE');
  console.log('=============================================================\n');

  if (store.initPromise) {
    await store.initPromise;
  }
  (store as any).isPostgres = false;

  // Spin up an ephemeral HTTP server
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // ── TEST 1: HTTP Security Headers & Helmet WAF Layer ─────────────────────
    console.log('[TEST 1] Auditing HTTP Security Headers and WAF Protection...');
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    assert(healthRes.headers.get('strict-transport-security'), 'Missing Strict-Transport-Security header');
    assert.strictEqual(healthRes.headers.get('x-content-type-options'), 'nosniff', 'Missing X-Content-Type-Options: nosniff');
    assert.strictEqual(healthRes.headers.get('x-frame-options'), 'SAMEORIGIN', 'Missing X-Frame-Options: SAMEORIGIN');
    assert(healthRes.headers.get('content-security-policy'), 'Missing Content-Security-Policy header');
    console.log('  ✅ HTTP Security Headers passed: HSTS, nosniff, frameguard, and CSP active.');

    // ── TEST 2: RBAC & Cross-School Data Isolation ───────────────────────────
    console.log('\n[TEST 2] Auditing RBAC & Cross-School Boundary Enforcement...');

    const soet = store.data.schools?.find((s) => s.code === 'SOET') || { id: '11111111-0000-0000-0000-000000000001', code: 'SOET', name: 'School of Engineering and Technology' };
    const soa = store.data.schools?.find((s) => s.code === 'SOA') || { id: '11111111-0000-0000-0000-000000000002', code: 'SOA', name: 'School of Arts' };

    const artsDept = {
      id: uuid(),
      code: 'ARTS',
      name: 'Department of Performing Arts',
      school_id: soa.id,
      category: 'academic' as const,
    };

    const targetNfaId = uuid();
    const facultyProposerId = uuid();
    const testNfa = {
      id: targetNfaId,
      ref_no: 'NFA/TEST/SEC/001',
      financial_year_id: store.data.financial_years[0]?.id || 'fy-1',
      department_id: artsDept.id,
      created_by: facultyProposerId,
      submitted_by_name: 'Dr. Faculty Test',
      title: 'External School Research Symposium',
      nfa_type: 'event' as const,
      nature_of_event: 'workshop',
      budget_allocated: 50000,
      estimated_budget: 50000,
      budget_category: 'academic',
      items: [],
      status: 'submitted' as const,
      current_stage: 'dean' as const,
      submitted_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await store.transact((db) => {
      db.departments.push(artsDept);
      db.nfas.push(testNfa);
    });

    const soetDeanToken = signToken({
      id: 'user-dean-soet',
      role: 'dean',
      department_id: null,
      school: 'SOET',
      name: 'Dr. SoET Dean',
      email: 'dean.soet@christuniversity.in',
    });

    const deanListRes = await fetch(`${baseUrl}/api/nfas`, {
      headers: { Authorization: `Bearer ${soetDeanToken}` },
    });
    assert.strictEqual(deanListRes.status, 200);
    const deanListJson = await deanListRes.json();
    const foundLeakedNfa = deanListJson.some((n: any) => n.id === targetNfaId);
    assert.strictEqual(foundLeakedNfa, false, 'Security Violation: Dean accessed NFA outside their School boundary!');
    console.log('  ✅ School Boundary Isolation verified: Cross-school NFAs are completely hidden from Deans.');

    const deanDirectGetRes = await fetch(`${baseUrl}/api/nfas/${targetNfaId}`, {
      headers: { Authorization: `Bearer ${soetDeanToken}` },
    });
    assert(deanDirectGetRes.status === 403 || deanDirectGetRes.status === 404, `Expected 403 or 404 for cross-school fetch, got ${deanDirectGetRes.status}`);
    console.log('  ✅ Cross-school direct GET request successfully blocked with 403/404.');

    // ── TEST 3: Segregation of Duties (SoD) ──────────────────────────────────
    console.log('\n[TEST 3] Auditing Segregation of Duties (Self-Approval Block)...');
    const proposerToken = signToken({
      id: facultyProposerId,
      role: 'hod',
      department_id: artsDept.id,
      name: 'Dr. Faculty Test',
      email: 'faculty.test@christuniversity.in',
    });

    const selfReviewRes = await fetch(`${baseUrl}/api/nfas/${targetNfaId}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${proposerToken}`,
      },
      body: JSON.stringify({ decision: 'approve', comments: 'Self approval attempt' }),
    });

    assert.strictEqual(selfReviewRes.status, 403, 'Security Violation: Proposer was able to approve their own NFA!');
    const selfReviewJson = await selfReviewRes.json();
    assert(selfReviewJson.error.includes('Segregation of Duties'), 'Expected Segregation of Duties error message');
    console.log('  ✅ Segregation of Duties verified: Self-approval attempt strictly rejected with HTTP 403.');

    // ── TEST 4: Multi-Factor Authentication (RFC 6238 TOTP Lifecycle) ─────────
    console.log('\n[TEST 4] Auditing Multi-Factor Authentication (TOTP + Recovery Codes)...');

    const mfaUser = {
      id: uuid(),
      name: 'Prof. MFA Tester',
      email: 'mfa.test@christuniversity.in',
      role: 'faculty' as const,
      department_id: artsDept.id,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await store.transact((db) => {
      const idx = db.users.findIndex((u) => u.id === mfaUser.id);
      if (idx >= 0) db.users[idx] = mfaUser;
      else db.users.push(mfaUser);
    });

    const mfaUserToken = signToken({
      id: mfaUser.id,
      role: mfaUser.role,
      department_id: mfaUser.department_id,
      name: mfaUser.name,
      email: mfaUser.email,
    });

    const setupRes = await fetch(`${baseUrl}/api/auth/mfa/setup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mfaUserToken}` },
    });
    assert.strictEqual(setupRes.status, 200);
    const setupJson = await setupRes.json();
    assert(setupJson.secret, 'Missing MFA secret in setup response');
    assert(setupJson.qr_code_url, 'Missing QR code data URL');
    assert(Array.isArray(setupJson.recovery_codes) && setupJson.recovery_codes.length === 8, 'Expected 8 recovery codes');
    const { secret: mfaSecret, recovery_codes: recoveryCodes } = setupJson;
    console.log(`  -> MFA Setup initialized: Secret generated, 8 recovery codes issued.`);

    const invalidVerifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mfaUserToken}`,
      },
      body: JSON.stringify({ token: '000000' }),
    });
    assert.strictEqual(invalidVerifyRes.status, 400);

    const validTotp = speakeasy.totp({ secret: mfaSecret, encoding: 'base32' });
    const validVerifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mfaUserToken}`,
      },
      body: JSON.stringify({ token: validTotp }),
    });
    assert.strictEqual(validVerifyRes.status, 200);
    const validVerifyJson = await validVerifyRes.json();
    assert.strictEqual(validVerifyJson.mfa_enabled, true);
    console.log('  -> Valid TOTP code confirmed and MFA successfully enabled.');

    const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
    const ticketToken = jwt.sign(
      { id: mfaUser.id, email: mfaUser.email, role: mfaUser.role, mfa_pending: true },
      JWT_SECRET,
      { expiresIn: '5m' }
    );

    const consumedRecoveryCode = recoveryCodes[0];
    const authRecoveryRes = await fetch(`${baseUrl}/api/auth/mfa/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfa_ticket: ticketToken, recovery_code: consumedRecoveryCode }),
    });
    assert.strictEqual(authRecoveryRes.status, 200);
    const authRecoveryJson = await authRecoveryRes.json();
    assert(authRecoveryJson.token, 'Expected JWT session token after recovery code verification');
    assert.strictEqual(authRecoveryJson.used_recovery_code, true);

    const replayRecoveryRes = await fetch(`${baseUrl}/api/auth/mfa/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfa_ticket: ticketToken, recovery_code: consumedRecoveryCode }),
    });
    assert.strictEqual(replayRecoveryRes.status, 401, 'Replay Attack: Consumed recovery code was accepted a second time!');
    console.log('  -> One-time recovery code successfully authenticated and permanently consumed.');

    // ── TEST 5: File Upload Security & Magic Byte Inspection ──────────────────
    console.log('\n[TEST 5] Auditing File Upload Security and Formula Injection Sanitization...');

    const maliciousBuffer = Buffer.from('<script>alert("XSS")</script>', 'utf8');
    const maliciousCheck = validateFileBuffer(maliciousBuffer, 'invoice.pdf', ['pdf']);
    assert.strictEqual(maliciousCheck.valid, false, 'Security Failure: Disguised file bypassed magic byte verification!');
    console.log('  -> Disguised HTML/script file with .pdf extension rejected by magic byte validator.');

    const validPdfBuffer = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF', 'utf8');
    const validCheck = validateFileBuffer(validPdfBuffer, 'genuine.pdf', ['pdf']);
    assert.strictEqual(validCheck.valid, true);
    console.log('  -> Genuine PDF buffer verified and accepted.');

    const dangerousFormula = '=cmd|\' /C calc\'!A0';
    const sanitizedFormula = sanitizeFormulaInjection(dangerousFormula);
    assert.strictEqual(sanitizedFormula, '\'=cmd|\' /C calc\'!A0', 'Formula injection prefix was not neutralized!');
    console.log('  -> Dangerous spreadsheet formula neutralized via apostrophe prefix sanitization.');

    // ── TEST 6: Emergency Security Read-Only Freeze Mode ──────────────────────
    console.log('\n[TEST 6] Auditing Emergency Security Read-Only Freeze Mode...');
    const superAdminToken = signToken({
      id: 'user-admin-1',
      role: 'super_admin',
      department_id: null,
      name: 'Super Admin',
      email: 'admin@christuniversity.in',
    });

    const activateModeRes = await fetch(`${baseUrl}/api/admin/emergency-mode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({ active: true, reason: 'Active Security Threat Incident Response' }),
    });
    assert.strictEqual(activateModeRes.status, 200);
    const activateJson = await activateModeRes.json();
    assert.strictEqual(activateJson.emergency_mode.is_active, true);

    const frozenNfaRes = await fetch(`${baseUrl}/api/nfas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${proposerToken}`,
      },
      body: JSON.stringify({ title: 'Mutating NFA Attempt During Freeze' }),
    });
    assert.strictEqual(frozenNfaRes.status, 503, `Expected 503 during Emergency Freeze, got ${frozenNfaRes.status}`);
    const frozenJson = await frozenNfaRes.json();
    assert.strictEqual(frozenJson.error, 'EMERGENCY_PROTECTION_MODE');
    console.log('  -> Mutating HTTP POST blocked with HTTP 503 EMERGENCY_PROTECTION_MODE.');

    const readHealthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(readHealthRes.status, 200);
    console.log('  -> Read-only GET request permitted during freeze mode.');

    const deactivateModeRes = await fetch(`${baseUrl}/api/admin/emergency-mode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({ active: false, reason: 'Threat neutralized, operations normal' }),
    });
    assert.strictEqual(deactivateModeRes.status, 200);
    const deactivateJson = await deactivateModeRes.json();
    assert.strictEqual(deactivateJson.emergency_mode.is_active, false);
    console.log('  -> Emergency Freeze deactivated; normal operation restored.');

    // ── TEST 7: Application IDS & Brute Force Threat Detection ────────────────
    console.log('\n[TEST 7] Auditing Application IDS & Brute Force Threat Tracker...');
    const testTargetEmail = 'victim.faculty@christuniversity.in';
    const testIp = '198.51.100.42';

    for (let i = 1; i <= 4; i++) {
      const check = securityService.recordFailedLogin(testIp, testTargetEmail);
      assert.strictEqual(check.isBruteForce, false);
    }

    const breachCheck = securityService.recordFailedLogin(testIp, testTargetEmail);
    assert.strictEqual(breachCheck.isBruteForce, true);
    assert(breachCheck.attemptCount >= 5);

    await new Promise((r) => setTimeout(r, 100));
    const activeAlerts = store.data.security_alerts || [];
    const bruteAlert = activeAlerts.find((a) => a.alert_type === 'BRUTE_FORCE_DETECTED');
    assert(bruteAlert, 'Application IDS failed to generate SecurityAlert for brute force breach!');
    assert.strictEqual(bruteAlert.severity, 'HIGH');
    console.log(`  -> Application IDS triggered HIGH severity alert for ${testTargetEmail} from IP ${testIp}.`);

    securityService.clearFailedLogins(testIp, testTargetEmail);

    // ── TEST 8: Security Audit Logging ───────────────────────────────────────
    console.log('\n[TEST 8] Auditing Immutable Security Audit Logs...');
    const auditLogsRes = await fetch(`${baseUrl}/api/admin/security/logs?limit=10`, {
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    assert.strictEqual(auditLogsRes.status, 200);
    const auditLogsJson = await auditLogsRes.json();
    assert(Array.isArray(auditLogsJson.logs) && auditLogsJson.logs.length > 0);
    console.log(`  -> Retrieved ${auditLogsJson.logs.length} immutable security audit logs.`);

    console.log('\n=============================================================');
    console.log('   CYBERSECURITY & RBAC AUDIT: 100% PASSED (8/8 TESTS)');
    console.log('=============================================================\n');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('\n❌ Cybersecurity audit failed with exception:', err);
  process.exit(1);
});
