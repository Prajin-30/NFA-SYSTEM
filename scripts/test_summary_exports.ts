import http from 'http';
import assert from 'assert';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';
import { isCurrencyKey, formatStatusLabel } from '../src/routes/reports.js';

if (store.initPromise) {
  store.initPromise.catch(() => {});
}

async function run() {
  if (store.initPromise) {
    try {
      await store.initPromise;
    } catch {}
  }
  console.log('--- Testing Executive Summary API Endpoints & Exports ---');

  // Test isCurrencyKey and formatStatusLabel helpers
  console.log('Testing Currency and Status formatting helpers:');
  assert.strictEqual(isCurrencyKey('sl_no'), false, 'sl_no must NOT be currency');
  assert.strictEqual(isCurrencyKey('s_no'), false, 's_no must NOT be currency');
  assert.strictEqual(isCurrencyKey('total_submitted'), false, 'counts must NOT be currency');
  assert.strictEqual(isCurrencyKey('events_completed'), false, 'counts must NOT be currency');
  assert.strictEqual(isCurrencyKey('allocated'), true, 'allocated must be currency');
  assert.strictEqual(isCurrencyKey('total_revenue'), true, 'revenue must be currency');
  assert.strictEqual(isCurrencyKey('approved_amount'), true, 'approved_amount must be currency');
  console.log('  ✓ isCurrencyKey passed all assertions');

  assert.strictEqual(formatStatusLabel('PENDING_FINANCE_OFFICE_APPROVAL'), 'Pending Finance Office Approval');
  assert.strictEqual(formatStatusLabel('PENDING_DEANS_OFFICE_VERIFICATION'), 'Pending Deans Office Verification');
  assert.strictEqual(formatStatusLabel('APPROVED'), 'Approved');
  console.log('  ✓ formatStatusLabel passed all assertions');

  const admin = store.data.users.find((u) => u.role === 'super_admin') || store.data.users[0];
  const adminToken = signToken(admin as any);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr: any = server.address();
  const port = addr.port;

  function req(path: string): Promise<{ status: number; headers: any; buffer: Buffer }> {
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers: { Authorization: `Bearer ${adminToken}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode || 500,
              headers: res.headers,
              buffer: Buffer.concat(chunks),
            });
          });
        }
      );
      r.on('error', reject);
      r.end();
    });
  }

  try {
    const sbm = store.data.schools?.find((s) => s.code === 'SBM');
    const adse = store.data.departments?.find((d) => d.code === 'ADSE');

    // 1. Overview API with SBM School
    console.log('1. Testing GET /api/reports/summary/overview with SBM (must NOT return SOET)');
    const sbmOverviewRes = await req(`/api/reports/summary/overview?scope=school&id=${sbm?.id || 'SBM'}`);
    assert.strictEqual(sbmOverviewRes.status, 200, 'SBM Overview must return 200 OK');
    const sbmJson = JSON.parse(sbmOverviewRes.buffer.toString('utf-8'));
    assert.strictEqual(sbmJson.scope, 'school', 'Scope must be school');
    assert.strictEqual(sbmJson.org_code, 'SBM', 'Must be SBM code');
    assert.strictEqual(sbmJson.org_name, 'School of Business and Management', 'Must be SBM name');
    console.log(`  ✓ SBM Overview resolved correctly: ${sbmJson.org_name} (${sbmJson.org_code})`);

    // 2. Overview API with ADSE Dept
    console.log('2. Testing GET /api/reports/summary/overview with ADSE (must NOT return CAMPUS)');
    const adseOverviewRes = await req(`/api/reports/summary/overview?scope=department&id=${adse?.id}`);
    assert.strictEqual(adseOverviewRes.status, 200, 'ADSE Overview must return 200 OK');
    const adseJson = JSON.parse(adseOverviewRes.buffer.toString('utf-8'));
    assert.strictEqual(adseJson.scope, 'department', 'Scope must be department');
    assert.strictEqual(adseJson.org_code, 'ADSE', 'Must be ADSE code');
    console.log(`  ✓ ADSE Overview resolved correctly: ${adseJson.org_name} (${adseJson.org_code})`);

    // 3. Summary PDF Export for SBM
    console.log('3. Testing GET /api/reports/summary/export/pdf for SBM');
    const sbmPdfRes = await req(`/api/reports/summary/export/pdf?scope=school&id=${sbm?.id || 'SBM'}`);
    assert.strictEqual(sbmPdfRes.status, 200, 'SBM PDF must return 200 OK');
    assert.strictEqual(sbmPdfRes.headers['content-type'], 'application/pdf');
    assert.strictEqual(sbmPdfRes.buffer.subarray(0, 4).toString(), '%PDF', 'Must be valid PDF stream');
    console.log(`  ✓ SBM Summary PDF generated successfully (${sbmPdfRes.buffer.length} bytes)`);

    // 4. Summary PDF Export for ADSE
    console.log('4. Testing GET /api/reports/summary/export/pdf for ADSE');
    const adsePdfRes = await req(`/api/reports/summary/export/pdf?scope=department&id=${adse?.id}`);
    assert.strictEqual(adsePdfRes.status, 200, 'ADSE PDF must return 200 OK');
    assert.strictEqual(adsePdfRes.headers['content-type'], 'application/pdf');
    assert.strictEqual(adsePdfRes.buffer.subarray(0, 4).toString(), '%PDF', 'Must be valid PDF stream');
    console.log(`  ✓ ADSE Summary PDF generated successfully (${adsePdfRes.buffer.length} bytes)`);

    // 5. Summary Excel Export for ADSE
    console.log('5. Testing GET /api/reports/summary/export/excel for ADSE');
    const adseExcelRes = await req(`/api/reports/summary/export/excel?scope=department&id=${adse?.id}`);
    assert.strictEqual(adseExcelRes.status, 200, 'ADSE Excel must return 200 OK');
    assert(adseExcelRes.headers['content-type'].includes('spreadsheetml'), 'Must be xlsx');
    assert.strictEqual(adseExcelRes.buffer.subarray(0, 2).toString(), 'PK', 'Must be valid xlsx zip container');
    console.log(`  ✓ ADSE Summary Excel generated successfully (${adseExcelRes.buffer.length} bytes)`);

    console.log('--- ALL SUMMARY EXPORT TESTS PASSED ---');
    process.exit(0);
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
