import http from 'http';
import assert from 'assert';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';

if (store.initPromise) {
  store.initPromise.catch(() => {});
}

async function run() {
  console.log('--- Testing Executive Summary API Endpoints & Exports ---');

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
    // 1. Overview API
    console.log('1. Testing GET /api/reports/summary/overview');
    const overviewRes = await req('/api/reports/summary/overview?scope=department');
    assert.strictEqual(overviewRes.status, 200, 'Overview must return 200 OK');
    const overviewJson = JSON.parse(overviewRes.buffer.toString('utf-8'));
    assert(overviewJson.metrics, 'Metrics present');
    assert(Array.isArray(overviewJson.faculty_activity), 'Faculty activity present');
    assert(Array.isArray(overviewJson.detailed_nfas), 'Detailed NFAs present');
    console.log(`  ✓ Overview returned successfully: ${overviewJson.org_name} (${overviewJson.org_code})`);

    // 2. Summary PDF Export
    console.log('2. Testing GET /api/reports/summary/export/pdf');
    const pdfRes = await req('/api/reports/summary/export/pdf?scope=department');
    assert.strictEqual(pdfRes.status, 200, 'Summary PDF must return 200 OK');
    assert.strictEqual(pdfRes.headers['content-type'], 'application/pdf');
    assert.strictEqual(pdfRes.buffer.subarray(0, 4).toString(), '%PDF', 'Must be valid PDF stream');
    console.log(`  ✓ Summary PDF generated successfully (${pdfRes.buffer.length} bytes)`);

    // 3. Summary Excel Export
    console.log('3. Testing GET /api/reports/summary/export/excel');
    const excelRes = await req('/api/reports/summary/export/excel?scope=department');
    assert.strictEqual(excelRes.status, 200, 'Summary Excel must return 200 OK');
    assert(excelRes.headers['content-type'].includes('spreadsheetml'), 'Must be xlsx');
    assert.strictEqual(excelRes.buffer.subarray(0, 2).toString(), 'PK', 'Must be valid xlsx zip container');
    console.log(`  ✓ Summary Excel generated successfully (${excelRes.buffer.length} bytes)`);

    console.log('--- ALL SUMMARY EXPORT TESTS PASSED ---');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
