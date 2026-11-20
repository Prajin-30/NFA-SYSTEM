import { store } from '../src/store.js';
import { generateUniqueNfaRefNo } from '../src/lib/refGen.js';

async function runDuplicatePreventionTest() {
  console.log('--- Starting Duplicate NFA Prevention & Idempotency Test ---');

  if (store.initPromise) {
    await store.initPromise;
  }

  // Find a faculty user in store
  const faculty = store.data.users.find((u) => u.role === 'faculty' && u.department_id);
  if (!faculty) throw new Error('No faculty user found in store');
  const deptId = faculty.department_id;
  const activeFy = store.data.financial_years.find((f) => f.is_active) || store.data.financial_years[0];
  const cat = store.data.budget_categories[0];

  console.log(`Testing with Faculty: ${faculty.name} (${faculty.email}), Dept: ${deptId}`);

  // Test 1: In-memory Idempotency Cache Hit
  const idempotencyKey = 'test_key_' + Date.now();
  const payload = {
    organization_type: 'department',
    department_id: deptId,
    financial_year_id: activeFy.id,
    budget_category_id: cat.id,
    title: 'Test Idempotency Submission ' + Date.now(),
    idempotency_key: idempotencyKey,
    items: [
      {
        particulars: 'Test Item',
        quantity: '2',
        rate: '1100',
        amount: 2200,
      }
    ]
  };

  const initialNfaCount = store.data.nfas.length;
  console.log(`Initial total NFAs in store: ${initialNfaCount}`);

  // Simulate Express handlers directly with auth mock
  const { nfasRouter } = await import('../src/routes/nfas.js');
  
  // Create a helper to simulate request to nfasRouter
  async function simulatePost(path: string, body: any, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: any }>((resolve) => {
      const req: any = {
        method: 'POST',
        url: path,
        body,
        headers: {
          'idempotency-key': headers['idempotency-key'] || body.idempotency_key || '',
          ...headers
        },
        user: faculty,
        params: {}
      };
      // Extract params if /:id/submit
      const match = path.match(/^\/([^/]+)\/submit$/);
      if (match) {
        req.params = { id: match[1] };
      }
      
      const res: any = {
        _status: 200,
        status(c: number) { this._status = c; return this; },
        json(data: any) { resolve({ status: this._status, body: data }); }
      };

      // Find the route
      if (path === '/') {
        // Trigger POST / handler
        // The router stack has middleware + handler
        const layer = (nfasRouter as any).stack.find((l: any) => l.route && l.route.path === '/' && l.route.methods.post);
        const handler = layer.route.stack[layer.route.stack.length - 1].handle;
        handler(req, res, () => {});
      } else if (match) {
        const layer = (nfasRouter as any).stack.find((l: any) => l.route && l.route.path === '/:id/submit' && l.route.methods.post);
        const handler = layer.route.stack[layer.route.stack.length - 1].handle;
        handler(req, res, () => {});
      }
    });
  }

  console.log('\n[TEST 1] Rapid duplicate submissions with SAME idempotency key (simulating 5 rapid clicks)...');
  const results = await Promise.all([
    simulatePost('/', payload, { 'idempotency-key': idempotencyKey }),
    simulatePost('/', payload, { 'idempotency-key': idempotencyKey }),
    simulatePost('/', payload, { 'idempotency-key': idempotencyKey }),
    simulatePost('/', payload, { 'idempotency-key': idempotencyKey }),
    simulatePost('/', payload, { 'idempotency-key': idempotencyKey }),
  ]);

  console.log(`Results status codes: ${results.map(r => r.status).join(', ')}`);
  const createdIds = new Set(results.map(r => r.body.id));
  console.log(`Distinct NFA IDs returned: ${Array.from(createdIds).join(', ')}`);
  
  if (createdIds.size !== 1) {
    throw new Error(`FAIL: Expected exactly 1 distinct NFA ID, got ${createdIds.size}`);
  }
  const createdId = results[0].body.id;
  const createdRef = results[0].body.ref_no;
  console.log(`PASS: Exactly 1 NFA was created: ${createdRef} (${createdId})`);

  // Test 2: Rapid duplicate submission WITHOUT idempotency key (simulating fast double-click with same payload)
  console.log('\n[TEST 2] Rapid duplicate submission WITHOUT idempotency key (debounce check)...');
  const payload2 = {
    ...payload,
    idempotency_key: undefined,
  };
  delete (payload2 as any).idempotency_key;
  const debouncedResult = await simulatePost('/', payload2);
  console.log(`Debounce result status: ${debouncedResult.status}, ref_no: ${debouncedResult.body.ref_no}`);
  if (debouncedResult.body.id !== createdId) {
    throw new Error(`FAIL: Debounce did not return the existing NFA ID! Got ${debouncedResult.body.id}`);
  }
  console.log('PASS: Rapid duplicate blocked by server-side debounce!');

  // Test 3: Concurrent Submit to HOD calls on the same NFA
  console.log('\n[TEST 3] Concurrent POST /:id/submit calls (simulating rapid clicks on Submit to HOD)...');
  // Check budget before submit
  const deptBudgetBefore = store.data.department_budgets.find(b => b.department_id === deptId && b.budget_category_id === cat.id);
  const pendingBefore = deptBudgetBefore?.pending_amount || 0;

  const submitResults = await Promise.all([
    simulatePost(`/${createdId}/submit`, {}),
    simulatePost(`/${createdId}/submit`, {}),
    simulatePost(`/${createdId}/submit`, {}),
    simulatePost(`/${createdId}/submit`, {}),
    simulatePost(`/${createdId}/submit`, {}),
  ]);

  console.log(`Submit status codes: ${submitResults.map(r => r.status).join(', ')}`);
  const finalNfaState = store.data.nfas.find(n => n.id === createdId);
  console.log(`NFA final status: ${finalNfaState?.status}`);

  const deptBudgetAfter = store.data.department_budgets.find(b => b.department_id === deptId && b.budget_category_id === cat.id);
  const pendingAfter = deptBudgetAfter?.pending_amount || 0;
  const pendingDiff = pendingAfter - pendingBefore;
  console.log(`Budget pending reservation increase: ₹${pendingDiff} (Expected: ₹2200)`);

  if (Math.abs(pendingDiff - 2200) > 0.01) {
    throw new Error(`FAIL: Budget was reserved multiple times! Expected diff ₹2200, got ₹${pendingDiff}`);
  }
  console.log('PASS: Budget reserved exactly ONCE despite 5 concurrent submission hits!');

  // Test 4: Different proposal creation should still succeed
  console.log('\n[TEST 4] Subsequent different proposal creation...');
  const payload3 = {
    ...payload,
    title: 'Different Proposal ' + Date.now(),
    idempotency_key: 'different_key_' + Date.now(),
  };
  const diffResult = await simulatePost('/', payload3, { 'idempotency-key': payload3.idempotency_key });
  console.log(`Different proposal status: ${diffResult.status}, ID: ${diffResult.body.id}`);
  if (diffResult.body.id === createdId) {
    throw new Error('FAIL: Different proposal incorrectly blocked!');
  }
  console.log('PASS: Different proposal created independently!');

  console.log('\n--- ALL DUPLICATE PREVENTION & IDEMPOTENCY TESTS PASSED! ---');
}

runDuplicatePreventionTest().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
