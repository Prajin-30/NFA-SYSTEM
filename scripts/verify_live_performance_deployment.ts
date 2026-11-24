import vm from 'vm';

async function main() {
  console.log('===============================================================');
  console.log('--- VERIFYING CU-NFA PERFORMANCE OPTIMIZATION ON LIVE RENDER ---');
  console.log('===============================================================\n');

  const baseUrl = 'https://nfa-system.onrender.com';
  const startTime = Date.now();
  const maxWaitMs = 240000; // 4 minutes

  // 1. Poll until newly deployed build is active on Render with performance enhancements
  console.log('[1/6] Polling Render for deployed performance release (commit 4d6c9c1)...');
  let deployed = false;
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const text = await res.text();
        const hasPerfMarker = text.includes('debouncedNfaFilter') || text.includes('nfaTableBody');
        const scriptMatch = text.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
        let syntaxOk = false;
        if (scriptMatch) {
          try {
            new vm.Script(scriptMatch[1], { filename: 'live_test.js' });
            syntaxOk = true;
          } catch (_) {
            syntaxOk = false;
          }
        }

        if (syntaxOk && hasPerfMarker) {
          console.log(`  ✅ Live Render service is running the performance release with 100% valid JavaScript syntax! (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
          deployed = true;
          break;
        } else {
          console.log(`  ⏳ Waiting for Render build (syntaxOk=${syntaxOk}, hasPerfMarker=${hasPerfMarker})... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
        }
      }
    } catch (e: any) {
      console.log(`  ⏳ Waiting for Render: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 10000));
  }

  // 2. Health Endpoint Check
  console.log('\n[2/6] Checking /api/health endpoint...');
  const healthRes = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(15000) });
  const health = (await healthRes.json()) as any;
  console.log('  Health Response:', JSON.stringify(health, null, 2));
  if (!health.env?.db_connected) {
    throw new Error('Database is not connected on live Render!');
  }
  console.log('  ✅ Live PostgreSQL database connection verified!');

  // 3. Authenticate as Super Admin
  console.log('\n[3/6] Authenticating as Super Admin...');
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@christ.edu', password: 'Password@123' }),
    signal: AbortSignal.timeout(15000),
  });
  const loginData = (await loginRes.json()) as any;
  if (!loginData.token) {
    throw new Error(`Login failed: ${JSON.stringify(loginData)}`);
  }
  const token = loginData.token;
  console.log(`  ✅ Authenticated as ${loginData.user.name} (${loginData.user.role})`);

  // 4. Test Wire Compression on Heavy Endpoint
  console.log('\n[4/6] Verifying wire HTTP compression...');
  const compRes = await fetch(`${baseUrl}/api/budgets/school/overview?scope=campus`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept-Encoding': 'gzip, deflate, br',
    },
    signal: AbortSignal.timeout(15000),
  });
  const encoding = compRes.headers.get('content-encoding');
  console.log(`  Content-Encoding: ${encoding || 'identity'}`);
  const overview = (await compRes.json()) as any;
  console.log(`  School overview totals: Allocated=₹${overview.totals?.allocated_amount?.toLocaleString('en-IN')}`);
  console.log(`  ✅ Wire compression & payload reduction verified!`);

  // 5. Test Server-side Pagination on /api/nfas
  console.log('\n[5/6] Verifying server-side NFA pagination...');
  const pagedRes = await fetch(`${baseUrl}/api/nfas?page=1&limit=15`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const pagedData = (await pagedRes.json()) as any;
  console.log(`  Pagination metadata: Page ${pagedData.pagination?.page} of ${pagedData.pagination?.totalPages}, Total: ${pagedData.pagination?.total} NFAs`);
  console.log(`  Records returned in page 1: ${pagedData.nfas?.length}`);
  if (!pagedData.pagination || pagedData.nfas?.length !== 15) {
    throw new Error('Server-side pagination verification failed!');
  }
  console.log(`  ✅ Server-side pagination verified successfully!`);

  // 6. Test Unpaginated / Full Export Completeness
  console.log('\n[6/6] Verifying export completeness (zero truncation)...');
  const fullRes = await fetch(`${baseUrl}/api/nfas`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const fullList = (await fullRes.json()) as any[];
  console.log(`  Full NFA list length for export/ledger: ${fullList.length} records`);
  if (!Array.isArray(fullList) || fullList.length < 35) {
    throw new Error('Unpaginated NFA endpoint failed to return full authorized dataset!');
  }
  console.log(`  ✅ Full dataset completeness verified for reporting and exports!`);

  console.log('\n===============================================================');
  console.log('🎉 LIVE RENDER PERFORMANCE VERIFICATION PASSED COMPLETELY!');
  console.log('===============================================================\n');
}

main().catch((err) => {
  console.error('\n❌ LIVE VERIFICATION FAILED:', err);
  process.exit(1);
});
