import http from 'http';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { signToken } from '../src/middleware/auth.js';

async function runBenchmark() {
  console.log('================================================================');
  console.log('   CU-NFA PERFORMANCE AUDIT & BASELINE BENCHMARK SUITE          ');
  console.log('================================================================\n');

  if (store.initPromise) {
    try {
      await store.initPromise;
    } catch {}
  }

  const admin = store.data.users.find((u) => u.role === 'super_admin') || store.data.users[0];
  const adminToken = signToken(admin as any);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  function makeRequest(
    method: 'GET' | 'POST',
    path: string,
    body?: any
  ): Promise<{ statusCode: number; durationMs: number; bytes: number }> {
    return new Promise((resolve, reject) => {
      const startTime = performance.now();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            Authorization: `Bearer ${adminToken}`,
          },
        },
        (res) => {
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
          });
          res.on('end', () => {
            const durationMs = performance.now() - startTime;
            resolve({ statusCode: res.statusCode || 500, durationMs, bytes });
          });
        }
      );
      req.on('error', reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  // 1. Single-request Baselines across 10 core operations
  const operations = [
    { name: 'Login API', method: 'POST' as const, path: '/api/auth/login', body: { email: 'admin@christ.edu', password: 'Password@123' } },
    { name: 'Current User (Whoami)', method: 'GET' as const, path: '/api/auth/me' },
    { name: 'Dashboard Overview (Campus)', method: 'GET' as const, path: '/api/budgets/school/overview?scope=campus' },
    { name: 'NFA List (Full Unpaginated)', method: 'GET' as const, path: '/api/nfas' },
    { name: 'NFA List (Paginated Page 1)', method: 'GET' as const, path: '/api/nfas?page=1&limit=15' },
    { name: 'Budget Categories & Lines', method: 'GET' as const, path: '/api/budgets/categories' },
    { name: 'Revenue Summary & Ledger', method: 'GET' as const, path: '/api/revenue/summary' },
    { name: 'Executive Summary Overview', method: 'GET' as const, path: '/api/reports/summary/overview?scope=department' },
    { name: 'Report Dataset (NFA Activity)', method: 'GET' as const, path: '/api/reports/data/nfa_activity' },
    { name: 'Executive Summary PDF Export', method: 'GET' as const, path: '/api/reports/summary/export/pdf?scope=department' },
    { name: 'Executive Summary Excel Export', method: 'GET' as const, path: '/api/reports/summary/export/excel?scope=department' },
  ];

  console.log('--- 1. SINGLE-REQUEST LATENCY & PAYLOAD MEASUREMENTS (5 iterations avg) ---');
  const baselineResults: Record<string, { avgMs: number; p95Ms: number; bytes: number }> = {};

  for (const op of operations) {
    const times: number[] = [];
    let lastBytes = 0;
    for (let i = 0; i < 5; i++) {
      const res = await makeRequest(op.method, op.path, op.body);
      times.push(res.durationMs);
      lastBytes = res.bytes;
    }
    times.sort((a, b) => a - b);
    const avgMs = Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10;
    const p95Ms = Math.round(times[Math.floor(times.length * 0.95)] * 10) / 10;
    baselineResults[op.name] = { avgMs, p95Ms, bytes: lastBytes };
    console.log(`  ${op.name.padEnd(32)}: Avg = ${String(avgMs).padStart(6)}ms | P95 = ${String(p95Ms).padStart(6)}ms | Payload = ${String(lastBytes).padStart(7)} bytes`);
  }

  // 2. Concurrency Stress Test (1, 5, 10, 25 concurrent requests)
  console.log('\n--- 2. CONCURRENCY LOAD TEST (GET /api/reports/summary/overview) ---');
  const concurrencyLevels = [1, 5, 10, 25];

  for (const c of concurrencyLevels) {
    const start = performance.now();
    const promises = Array.from({ length: c }, () => makeRequest('GET', '/api/reports/summary/overview?scope=department'));
    const resList = await Promise.all(promises);
    const totalDuration = performance.now() - start;
    const allSuccessful = resList.every((r) => r.statusCode === 200);
    const avgDuration = Math.round((resList.reduce((acc, r) => acc + r.durationMs, 0) / c) * 10) / 10;
    console.log(`  ${String(c).padStart(2)} concurrent requests: Total time = ${Math.round(totalDuration)}ms | Avg per req = ${avgDuration}ms | Success = ${allSuccessful ? '100%' : 'FAIL'}`);
  }

  // 3. Memory Usage
  const mem = process.memoryUsage();
  console.log('\n--- 3. SERVER MEMORY FOOTPRINT ---');
  console.log(`  RSS       : ${Math.round(mem.rss / 1024 / 1024)} MB`);
  console.log(`  Heap Total: ${Math.round(mem.heapTotal / 1024 / 1024)} MB`);
  console.log(`  Heap Used : ${Math.round(mem.heapUsed / 1024 / 1024)} MB`);
  console.log('================================================================\n');

  server.close();
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
