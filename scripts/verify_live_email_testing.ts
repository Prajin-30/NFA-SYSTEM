async function main() {
  console.log('===============================================================');
  console.log('--- VERIFYING SAFE EMAIL TESTING ON DEPLOYED RENDER WEBSITE ---');
  console.log('===============================================================\n');

  const baseUrl = 'https://nfa-system.onrender.com';
  const startTime = Date.now();
  const maxWaitMs = 180000; // 3 minutes

  // 1. Poll until newly deployed build is active
  console.log('[1/5] Polling Render for updated deployment with EMAIL_TEST_MODE...');
  let deployed = false;
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const text = await res.text();
        if (text.includes('btnSendMockTestEmail') && text.includes('loadRecentEmailTestingLogs')) {
          console.log(`  ✅ Detected updated build on Render! (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
          deployed = true;
          break;
        } else {
          console.log(`  ⏳ Render still serving previous build... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
        }
      }
    } catch (e: any) {
      console.log(`  ⏳ Reconnecting: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 10000));
  }

  if (!deployed) {
    console.log('  ⚠️ Build not detected within poll timeout. Testing endpoints directly...');
  }

  // 2. Health Endpoint Check
  console.log('\n[2/5] Checking /api/health endpoint...');
  const healthRes = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(15000) });
  const healthJson: any = await healthRes.json();
  console.log(`  Health Status: ${healthRes.status}`);
  console.log(`  Data Source: ${healthJson.env?.data_source_value}`);
  console.log(`  Email Test Mode: ${healthJson.env?.email_test_mode}`);
  console.log(`  Email Provider: ${healthJson.env?.email_provider}`);

  // 3. Super Admin Authentication
  console.log('\n[3/5] Authenticating as Super Admin (admin@christ.edu)...');
  const adminLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@christ.edu', password: 'Password@123' }),
    signal: AbortSignal.timeout(15000),
  });
  const adminLoginJson: any = await adminLoginRes.json();
  if (adminLoginRes.status !== 200 || !adminLoginJson.token) {
    throw new Error(`Admin login failed: ${adminLoginRes.status} ${JSON.stringify(adminLoginJson)}`);
  }
  const adminToken = adminLoginJson.token;
  console.log(`  ✅ Successfully authenticated as: ${adminLoginJson.user?.name} (${adminLoginJson.user?.role})`);

  // 4. Check Email Testing Status as Super Admin
  console.log('\n[4/5] Checking /api/admin/email-testing/status...');
  const statusRes = await fetch(`${baseUrl}/api/admin/email-testing/status`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    signal: AbortSignal.timeout(15000),
  });
  console.log(`  Status API HTTP Status: ${statusRes.status}`);
  const statusJson: any = await statusRes.json();
  console.log('  Status Response:', JSON.stringify(statusJson, null, 2));

  if (!statusJson.isTestingAllowed) {
    throw new Error('isTestingAllowed is false on deployed server!');
  }

  // 5. Trigger Mock Email Test on Render
  console.log('\n[5/5] Executing Mock Email Test (POST /api/admin/email-testing/send)...');
  const sendRes = await fetch(`${baseUrl}/api/admin/email-testing/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode: 'mock' }),
    signal: AbortSignal.timeout(15000),
  });
  console.log(`  Send API HTTP Status: ${sendRes.status}`);
  const sendJson: any = await sendRes.json();
  console.log('  Send Response:', JSON.stringify(sendJson, null, 2));

  if (sendRes.status !== 200 || sendJson.status !== 'Mock Delivered') {
    throw new Error(`Mock email execution failed: ${JSON.stringify(sendJson)}`);
  }

  // 6. Verify Mock Email Logs
  console.log('\n[Verification] Checking /api/admin/email-testing/logs...');
  const logsRes = await fetch(`${baseUrl}/api/admin/email-testing/logs?limit=5`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    signal: AbortSignal.timeout(15000),
  });
  console.log(`  Logs API HTTP Status: ${logsRes.status}`);
  const logsJson: any = await logsRes.json();
  console.log(`  Total Recorded Mock Emails: ${logsJson.total}`);
  console.log('  Latest Log Item:', JSON.stringify(logsJson.logs?.[0], null, 2));

  if (!logsJson.logs || logsJson.logs.length === 0) {
    throw new Error('No mock emails found in logs after test send!');
  }

  // 7. Verify Role-Based Access Control (RBAC) on Render
  console.log('\n[Security] Verifying RBAC restriction for non-admin accounts...');
  const facultyLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'accounts.ke@christuniversity.in', password: 'Password@123' }),
    signal: AbortSignal.timeout(15000),
  });
  const facultyLoginJson: any = await facultyLoginRes.json();
  const nonAdminToken = facultyLoginJson.token;

  const forbiddenRes = await fetch(`${baseUrl}/api/admin/email-testing/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${nonAdminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode: 'mock' }),
    signal: AbortSignal.timeout(15000),
  });
  console.log(`  Non-admin access status: ${forbiddenRes.status} (Expected 403 Forbidden)`);
  if (forbiddenRes.status !== 403) {
    throw new Error(`Security breach: Non-admin received status ${forbiddenRes.status}`);
  }

  console.log('\n===============================================================');
  console.log('🎉 ALL LIVE EMAIL TESTING VERIFICATIONS PASSED ON RENDER!');
  console.log('===============================================================');
}

main().catch((err) => {
  console.error('\n❌ LIVE VERIFICATION FAILED:', err);
  process.exit(1);
});
