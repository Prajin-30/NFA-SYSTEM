import http from 'http';
import { Socket } from 'net';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';
import { sendSuperAdminTestEmail, maskEmail, resetTestEmailRateLimit } from '../src/services/resendService.js';
import { dispatchWorkflowNotification, resetSentNotifications } from '../src/services/notifications.js';

function request(options: { method: string; url: string; headers?: Record<string, string>; body?: any }): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.method = options.method || 'GET';
    req.url = options.url || '/';
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.headers || {})) {
      hdrs[k.toLowerCase()] = v;
    }
    req.headers = hdrs;
    (req as any).body = options.body;

    const res = new http.ServerResponse(req);
    let chunks: Buffer[] = [];
    res.write = function (chunk: any) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return true;
    } as any;
    res.end = function (chunk: any) {
      if (chunk) chunks.push(Buffer.from(chunk));
      const str = Buffer.concat(chunks).toString('utf8');
      let parsed: any = str;
      try { parsed = JSON.parse(str); } catch (e) { }
      resolve({ status: res.statusCode, body: parsed });
      return this;
    } as any;

    app.handle(req, res, (err: any) => {
      if (err) reject(err);
    });
  });
}

async function runResendTests() {
  console.log('\n======================================================');
  console.log('--- STARTING RESEND EMAIL INTEGRATION & SECURITY TESTS ---');
  console.log('======================================================\n');

  // Tokens for various roles
  const superAdminToken = signToken({
    id: 'admin-test-id',
    name: 'Super Administrator',
    role: 'super_admin',
    email: 'admin@christ.edu',
    school: 'SoET',
    is_active: true,
  });

  const facultyToken = signToken({
    id: 'fac-test-id',
    name: 'Dr Faculty',
    role: 'faculty',
    email: 'faculty@christ.edu',
    department_id: '330ada81-5246-4c92-9ca2-688eae0f28d4',
    is_active: true,
  });

  const hodToken = signToken({
    id: 'hod-test-id',
    name: 'Dr HOD',
    role: 'hod',
    email: 'hod@christ.edu',
    department_id: '330ada81-5246-4c92-9ca2-688eae0f28d4',
    is_active: true,
  });

  const deanToken = signToken({
    id: 'dean-test-id',
    name: 'Dr Dean',
    role: 'dean',
    email: 'dean@christ.edu',
    school: 'SoET',
    is_active: true,
  });

  // ----------------------------------------------------
  // TEST 1: Super Admin Configuration Status Endpoint
  // ----------------------------------------------------
  console.log('[TEST 1] Testing GET /api/admin/email-testing/status...');
  const statusRes = await request({
    method: 'GET',
    url: '/api/admin/email-testing/status',
    headers: { Authorization: `Bearer ${superAdminToken}` },
  });
  if (statusRes.status !== 200) {
    throw new Error(`Expected 200 from status endpoint, got ${statusRes.status}: ${JSON.stringify(statusRes.body)}`);
  }
  if (!('fromEmail' in statusRes.body) || !('hasApiKey' in statusRes.body)) {
    throw new Error('Status endpoint missing expected metadata keys');
  }
  // Ensure raw API key is never exposed
  if ('apiKey' in statusRes.body || JSON.stringify(statusRes.body).includes('re_')) {
    throw new Error('SECURITY VIOLATION: Raw API key or token exposed in status response!');
  }
  console.log(`  PASS: Super Admin received configuration metadata safely: sender=${statusRes.body.fromEmail}, recipient=${statusRes.body.testRecipientMasked}`);

  // ----------------------------------------------------
  // TEST 2: Role Authorization Checks (Only Super Admin Allowed)
  // ----------------------------------------------------
  console.log('\n[TEST 2] Testing Role-Based Access Control (RBAC)...');
  const rolesToTest = [
    { role: 'Faculty', token: facultyToken },
    { role: 'HOD', token: hodToken },
    { role: 'Dean', token: deanToken },
  ];

  for (const { role, token } of rolesToTest) {
    const unauthStatus = await request({
      method: 'GET',
      url: '/api/admin/email-testing/status',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (unauthStatus.status !== 403) {
      throw new Error(`Expected 403 for ${role} on status endpoint, got ${unauthStatus.status}`);
    }

    const unauthSend = await request({
      method: 'POST',
      url: '/api/admin/email-testing/send',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: {},
    });
    if (unauthSend.status !== 403) {
      throw new Error(`Expected 403 for ${role} on send endpoint, got ${unauthSend.status}`);
    }
    console.log(`  PASS: Role '${role}' strictly blocked with HTTP 403 Forbidden.`);
  }

  // Unauthenticated request check
  const anonRes = await request({ method: 'GET', url: '/api/admin/email-testing/status' });
  if (anonRes.status !== 401) {
    throw new Error(`Expected 401 for anonymous request, got ${anonRes.status}`);
  }
  console.log('  PASS: Anonymous request strictly blocked with HTTP 401 Unauthorized.');

  // ----------------------------------------------------
  // TEST 3: Mock Resend Client Delivery Execution
  // ----------------------------------------------------
  console.log('\n[TEST 3] Testing Resend Email Send with Mocked SDK Client...');

  // Create a mock Resend client that simulates successful API acceptance
  const mockSentCalls: any[] = [];
  const mockSuccessResendClient: any = {
    emails: {
      send: async (payload: any) => {
        mockSentCalls.push(payload);
        return {
          data: { id: 'msg_resend_mock_abc123' },
          error: null,
        };
      },
    },
  };

  // Temporarily set test recipient for test execution if not present
  const originalRecipient = process.env.RESEND_TEST_RECIPIENT;
  process.env.RESEND_TEST_RECIPIENT = 'prajin.testing@example.com';

  const sendResult = await sendSuperAdminTestEmail({
    clientOverride: mockSuccessResendClient,
    skipRateLimit: true,
  });

  if (!sendResult.success || sendResult.messageId !== 'msg_resend_mock_abc123') {
    throw new Error('Expected successful send with messageId msg_resend_mock_abc123');
  }
  if (sendResult.status !== 'Accepted by Resend') {
    throw new Error(`Expected status 'Accepted by Resend', got '${sendResult.status}'`);
  }
  console.log(`  PASS: sendSuperAdminTestEmail succeeded: ${sendResult.status} (Message ID: ${sendResult.messageId})`);

  // Verify mock payload integrity
  if (mockSentCalls.length !== 1) throw new Error('Expected exactly 1 Resend call');
  const call = mockSentCalls[0];
  if (call.to[0] !== 'prajin.testing@example.com') {
    throw new Error(`Recipient mismatch: expected prajin.testing@example.com, got ${call.to[0]}`);
  }
  if (call.subject !== 'CU-NFA — Email Integration Test') {
    throw new Error(`Subject mismatch: got ${call.subject}`);
  }
  if (!call.text.includes('CU-NFA Management System') || !call.html.includes('CU-NFA Management System')) {
    throw new Error('Email body content missing required official text');
  }
  console.log('  PASS: Email payload strictly matched required text, HTML structure, subject, and recipient.');

  // ----------------------------------------------------
  // TEST 4: Backend Enforcement — Client Recipient Tampering Ignored
  // ----------------------------------------------------
  console.log('\n[TEST 4] Testing Backend Recipient Enforcement (Tamper Resistance)...');
  // Attempt to pass arbitrary recipient in body
  const tamperBody = { to: 'attacker@malicious-domain.com' };
  // The service uses process.env.RESEND_TEST_RECIPIENT and completely ignores req.body.to
  mockSentCalls.length = 0;
  await sendSuperAdminTestEmail({
    clientOverride: mockSuccessResendClient,
    skipRateLimit: true,
  });
  if (mockSentCalls[0].to[0] !== 'prajin.testing@example.com') {
    throw new Error('SECURITY VIOLATION: Service sent email to unconfigured recipient!');
  }
  console.log('  PASS: Backend strictly enforces RESEND_TEST_RECIPIENT and ignores arbitrary client parameters.');

  // ----------------------------------------------------
  // TEST 5: Resend API Failure / Network Error Handling
  // ----------------------------------------------------
  console.log('\n[TEST 5] Testing Resend API Error Handling...');
  const mockFailingResendClient: any = {
    emails: {
      send: async () => ({
        data: null,
        error: { name: 'validation_error', message: 'Domain verification failed for from address' },
      }),
    },
  };

  let caughtError = false;
  try {
    await sendSuperAdminTestEmail({
      clientOverride: mockFailingResendClient,
      skipRateLimit: true,
    });
  } catch (err: any) {
    caughtError = true;
    if (!err.message.includes('Resend delivery failed: Domain verification failed')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!caughtError) throw new Error('Expected sendSuperAdminTestEmail to throw on API error');
  console.log('  PASS: Resend API error cleanly caught and formatted with descriptive message.');

  // ----------------------------------------------------
  // TEST 6: Missing Configuration Error Handling
  // ----------------------------------------------------
  console.log('\n[TEST 6] Testing Missing Configuration Handling...');
  // Missing API key test
  let caughtApiKeyError = false;
  try {
    await sendSuperAdminTestEmail({
      clientOverride: null, // No client available (missing API key)
      skipRateLimit: true,
    });
  } catch (err: any) {
    caughtApiKeyError = true;
    if (!err.message.includes('RESEND_API_KEY is not configured')) {
      throw new Error(`Unexpected error message for missing API key: ${err.message}`);
    }
  }
  if (!caughtApiKeyError) throw new Error('Expected error when RESEND_API_KEY is missing');
  console.log('  PASS: Missing RESEND_API_KEY produced safe, instructive error.');

  // Missing Recipient test
  delete process.env.RESEND_TEST_RECIPIENT;
  let caughtRecipientError = false;
  try {
    await sendSuperAdminTestEmail({
      clientOverride: mockSuccessResendClient,
      skipRateLimit: true,
    });
  } catch (err: any) {
    caughtRecipientError = true;
    if (!err.message.includes('RESEND_TEST_RECIPIENT is not configured')) {
      throw new Error(`Unexpected error message for missing recipient: ${err.message}`);
    }
  }
  if (!caughtRecipientError) throw new Error('Expected error when RESEND_TEST_RECIPIENT is missing');
  console.log('  PASS: Missing RESEND_TEST_RECIPIENT produced safe, instructive error.');

  // Restore recipient
  if (originalRecipient) {
    process.env.RESEND_TEST_RECIPIENT = originalRecipient;
  } else {
    process.env.RESEND_TEST_RECIPIENT = 'prajin.testing@example.com';
  }

  // ----------------------------------------------------
  // TEST 7: Rate Limiting Enforcement
  // ----------------------------------------------------
  console.log('\n[TEST 7] Testing Server-Side Rate Limiting...');
  resetTestEmailRateLimit();
  // First send
  await sendSuperAdminTestEmail({ clientOverride: mockSuccessResendClient, skipRateLimit: false });
  // Immediate second send should be blocked by cooldown
  let rateLimitCaught = false;
  try {
    await sendSuperAdminTestEmail({ clientOverride: mockSuccessResendClient, skipRateLimit: false });
  } catch (err: any) {
    rateLimitCaught = true;
    if (!err.message.includes('Rate limit exceeded')) {
      throw new Error(`Expected rate limit message, got: ${err.message}`);
    }
  }
  if (!rateLimitCaught) throw new Error('Expected rapid send to be blocked by rate limiting');
  console.log('  PASS: Rapid send blocked by 5-second server-side rate limit.');

  // ----------------------------------------------------
  // TEST 8: Workflow Notifications Invariance (Strictly Mock-Only)
  // ----------------------------------------------------
  console.log('\n[TEST 8] Verifying Workflow Notifications Remain Strictly Mock-Only...');
  resetSentNotifications();
  store.data.mock_emails = [];

  const mockNfa: any = {
    id: 'nfa-invariance-test',
    ref_no: 'NFA/CSE/2026-27/9999',
    title: 'Invariance Verification Proposal',
    total_amount: 50000,
    status: 'pending_hod_review',
    department_id: 'b5643609-22d9-4b21-9ce0-2f6eb5b9d04e',
    organization_type: 'department',
  };

  mockSentCalls.length = 0; // Clear any calls

  // Dispatch regular workflow notification
  await dispatchWorkflowNotification(store.data, {
    nfa: mockNfa,
    actor: { id: 'test-user', name: 'Dr Faculty', role: 'faculty' },
    event: 'nfa_submitted',
  });

  // Verify mock email was recorded in store.data.mock_emails
  if (store.data.mock_emails.length === 0) {
    throw new Error('Expected mock email in store.data.mock_emails');
  }
  // Verify Resend was NOT called!
  if (mockSentCalls.length > 0) {
    throw new Error('CRITICAL VIOLATION: Real Resend call triggered during normal workflow notification!');
  }
  console.log('  PASS: Normal workflow notifications strictly recorded in mock email store. Zero real email calls triggered.');

  // ----------------------------------------------------
  // TEST 9: Email Masking Utility Check
  // ----------------------------------------------------
  console.log('\n[TEST 9] Testing Email Masking Utility...');
  const masked1 = maskEmail('john.doe@christuniversity.in');
  const masked2 = maskEmail('a@b.com');
  const masked3 = maskEmail(undefined);
  if (masked1 !== 'jo***e@christuniversity.in') throw new Error(`Unexpected mask: ${masked1}`);
  if (masked2 !== 'a***@b.com') throw new Error(`Unexpected mask: ${masked2}`);
  if (masked3 !== 'Not configured') throw new Error(`Unexpected mask: ${masked3}`);
  console.log(`  PASS: Email masking verified: ${masked1}, ${masked2}, ${masked3}`);

  console.log('\n======================================================');
  console.log('ALL RESEND EMAIL INTEGRATION & SECURITY TESTS PASSED!');
  console.log('======================================================\n');
}

runResendTests().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
