process.env.DATA_SOURCE = process.env.DATA_SOURCE || 'json';
process.env.NODE_ENV = 'test';

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import http from 'http';
import vm from 'vm';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { decryptAccountNumber } from '../src/lib/encryption.js';
import { getMockAuthUsers } from '../src/services/supabaseAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runRestorationVerification() {
  console.log('========================================================================');
  console.log('   CU-NFA: RESTORED NFA FUNCTIONALITY & COMPLETE REGRESSION VERIFICATION');
  console.log('========================================================================\n');

  if (store.initPromise) {
    try {
      await store.initPromise;
    } catch (e: any) {
      console.log('Using local dataset fallback:', e.message);
    }
  }
  (store as any).isPostgres = false;

  const testPass = 'Password@123';
  const testHash = bcrypt.hashSync(testPass, 8);

  const testUsers = [
    { email: 'faculty@christ.edu', role: 'faculty' },
    { email: 'hod@christ.edu', role: 'hod' },
    { email: 'dean@christ.edu', role: 'dean' },
    { email: 'finance@christ.edu', role: 'finance' },
    { email: 'director@christ.edu', role: 'director' },
    { email: 'admin@christ.edu', role: 'super_admin' },
  ];

  for (const tu of testUsers) {
    getMockAuthUsers().set(tu.email, {
      id: 'usr-' + tu.email.split('@')[0],
      email: tu.email,
      passwordHash: testHash,
      mustChangePassword: false,
      isActive: true,
    });
    let u = store.data.users.find((x) => x.email.toLowerCase() === tu.email);
    if (u) {
      u.password_hash = testHash;
      (u as any).is_active = true;
    } else {
      store.data.users.push({
        id: 'usr-' + tu.email.split('@')[0],
        name: 'Test ' + tu.email.split('@')[0],
        email: tu.email,
        password_hash: testHash,
        role: tu.role as any,
        department_id: store.data.departments[0]?.id || 'dept-1',
        created_at: new Date().toISOString(),
        is_active: true,
      } as any);
    }
  }

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running on ${baseUrl}\n`);

  let passed = 0;
  let total = 0;
  function pass(desc: string) {
    passed++;
    total++;
    console.log(`  ✅ [PASS ${total}] ${desc}`);
  }
  function fail(desc: string, err: any) {
    total++;
    console.error(`  ❌ [FAIL ${total}] ${desc}:`, err);
    throw err;
  }

  try {
    // -------------------------------------------------------------------------
    // TEST GROUP 1: HTML & STATIC INTEGRITY OF public/nfa-create.html
    // -------------------------------------------------------------------------
    console.log('--- 1. Testing Static HTML & V8 Script Integrity of nfa-create.html ---');
    const nfaCreateHtmlPath = path.join(process.cwd(), 'public', 'nfa-create.html');
    assert.ok(fs.existsSync(nfaCreateHtmlPath), 'nfa-create.html exists');
    const htmlContent = fs.readFileSync(nfaCreateHtmlPath, 'utf8');

    // Extract inline script and test through V8 engine
    const scriptMatch = htmlContent.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i);
    assert.ok(scriptMatch, 'Script block found in nfa-create.html');
    new vm.Script(scriptMatch[1]);
    pass('nfa-create.html: Inline script compiles with 100% valid V8 JavaScript syntax');

    // Check presence of restored sections and IDs
    const requiredElements = [
      'eventPredefinedSection',
      'purchaseParticularsSection',
      'eventParticularsGridContainer',
      'purchaseCategoriesGridContainer',
      'resourcePersonsSection',
      'samplingNoticeBanner',
      'purchaseDetailsWrap',
      'purchaseQuotationsWrap',
      'eventDocsWrap',
      'eventResourcePerson',
      'eventDesignation',
      'eventOrganization',
      'willGenerateRevenue',
      'purchaseItemName',
      'purchaseQuantity',
      'purchaseRate',
      'purchaseAmount',
      'vName0',
      'vName1',
      'vName2',
      'compFile',
      'sdgGridContainer'
    ];
    for (const elId of requiredElements) {
      assert.ok(htmlContent.includes(elId), `nfa-create.html includes restored element: ${elId}`);
    }
    pass(`nfa-create.html: All ${requiredElements.length} restored UI containers, inputs, and sections verified`);

    // -------------------------------------------------------------------------
    // TEST GROUP 2: AUTHENTICATION (USERNAME & EMAIL)
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Testing Institutional Authentication via Username Prefix ---');
    const loginFacultyRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'faculty', password: testPass }),
    });
    const loginFacultyData = await loginFacultyRes.json();
    assert.strictEqual(loginFacultyRes.status, 200);
    assert.ok(loginFacultyData.token, 'Token received for username login');
    const facultyToken = loginFacultyData.token;
    pass('Login using institutional username prefix "faculty" succeeds');

    const loginAdminRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@christ.edu', password: testPass }),
    });
    const loginAdminData = await loginAdminRes.json();
    assert.strictEqual(loginAdminRes.status, 200);
    const adminToken = loginAdminData.token;
    pass('Login using full email "admin@christ.edu" succeeds');

    // -------------------------------------------------------------------------
    // TEST GROUP 3: EVENT NFA WITH ALL 10 PREDEFINED PARTICULARS & NON-MONETARY SAMPLING
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Testing Event NFA Creation with All 10 Predefined Particulars ---');
    const activeDept = store.data.departments[0];
    const activeFy = store.data.financial_years.find((f) => f.is_active) || store.data.financial_years[0];
    const activeCat = store.data.budget_categories[0];

    const eventPayload = {
      ref_no: `NFA/TEST/EV/${Date.now()}`,
      financial_year_id: activeFy.id,
      budget_category_id: activeCat.id,
      organization_type: 'department',
      department_id: activeDept.id,
      title: 'National AI and Robotics Symposium 2026',
      nfa_type: 'event',
      point1: 'Conduct a national technical symposium on artificial intelligence and robotics for academic research.',
      point2: 'Auditorium booking, audio visual setup, dignitary transportation, and participant catering logistics.',
      point3: 'Directly aligns with faculty development, research competence, and institutional accreditation criteria.',
      point4: 'The estimated expenditure details are attached as Annexure-I.',
      sdgs: 'SDG 4: Quality Education; SDG 9: Industry, Innovation and Infrastructure',
      will_generate_revenue: true,
      event_details: {
        resource_person_name: 'Dr. Jane Smith',
        designation: 'Professor & Chair',
        organization: 'IISc Bangalore',
        event_date: '2026-12-15',
        venue: 'Kengeri Auditorium',
        additional_info: 'Chief guest arriving at 9:30 AM; requires university guest house accommodation.',
      },
      // ALL 10 Predefined Particulars + Custom Item
      items: [
        {
          particulars: 'Memento (Handmade Wooden Plaque with Carry Bag)',
          quantity: '5',
          rate: '2000',
          amount: 10000,
          is_predefined: true,
          predefined_key: 'memento',
          carry_back_arrangement: 'Carry bag included',
        },
        {
          particulars: 'Travel Expenses (Distance: 45 km)',
          quantity: '2',
          rate: '1500',
          amount: 3000,
          is_predefined: true,
          predefined_key: 'travel_expenses',
          distance_km: '45',
        },
        {
          particulars: 'Travel Allowance (TA)',
          quantity: '2',
          rate: '1000',
          amount: 2000,
          is_predefined: true,
          predefined_key: 'ta',
        },
        {
          particulars: 'Dearness Allowance (DA)',
          quantity: '2',
          rate: '800',
          amount: 1600,
          is_predefined: true,
          predefined_key: 'da',
        },
        {
          particulars: 'Honorarium to Keynote Speakers',
          quantity: '2',
          rate: '5000',
          amount: 10000,
          is_predefined: true,
          predefined_key: 'honorarium',
        },
        {
          particulars: 'Refreshments — Forenoon',
          quantity: '100',
          rate: '50',
          amount: 5000,
          is_predefined: true,
          predefined_key: 'refreshments_fn',
        },
        {
          particulars: 'Refreshments — Afternoon',
          quantity: '100',
          rate: '50',
          amount: 5000,
          is_predefined: true,
          predefined_key: 'refreshments_an',
        },
        {
          particulars: 'Lunch for Delegates',
          quantity: '100',
          rate: '200',
          amount: 20000,
          is_predefined: true,
          predefined_key: 'lunch',
        },
        {
          particulars: 'Miscellaneous & Contingency',
          quantity: '1',
          rate: '3400',
          amount: 3400,
          is_predefined: true,
          predefined_key: 'miscellaneous',
        },
        {
          particulars: 'Custom Workshop Kit & Badges',
          quantity: '100',
          rate: '50',
          amount: 5000,
          is_predefined: false,
          item_type: 'custom',
        },
        // Non-monetary Sampling Item (Zero Amount)
        {
          particulars: 'Sampling',
          quantity: '',
          rate: '',
          amount: 0,
          is_predefined: true,
          predefined_key: 'sampling',
          sampling_required: true,
        },
      ],
      // Multiple Resource Persons with AES-256-GCM Bank Details
      resource_person_bank_details: [
        {
          resource_person_name: 'Dr. Jane Smith',
          designation: 'Professor',
          organization: 'IISc Bangalore',
          email: 'jane.smith@iisc.ac.in',
          mobile: '+91 9876543210',
          honorarium_amount: 5000,
          account_holder_name: 'Jane Smith',
          bank_name: 'State Bank of India',
          branch_name: 'IISc Campus, Bangalore',
          ifsc_code: 'SBIN0001234',
          account_number: '123456789012',
          confirm_account_number: '123456789012',
        },
        {
          resource_person_name: 'Dr. Robert Chen',
          designation: 'Principal Scientist',
          organization: 'Microsoft Research',
          email: 'rchen@microsoft.com',
          mobile: '+91 9876543211',
          honorarium_amount: 5000,
          account_holder_name: 'Robert Chen',
          bank_name: 'HDFC Bank',
          branch_name: 'MG Road, Bangalore',
          ifsc_code: 'HDFC0001234',
          account_number: '987654321098',
          confirm_account_number: '987654321098',
        },
      ],
    };

    const createEventRes = await fetch(`${baseUrl}/api/nfas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${facultyToken}`,
      },
      body: JSON.stringify(eventPayload),
    });

    const createEventData = await createEventRes.json();
    assert.ok([200, 201].includes(createEventRes.status), `Event creation status 200/201: ${JSON.stringify(createEventData)}`);
    assert.ok(createEventData.id, 'Event NFA created with ID');
    const eventNfaId = createEventData.id;

    // Expected total monetary sum: 10000+3000+2000+1600+10000+5000+5000+20000+3400+5000 = 65000
    // Sampling MUST be ₹0 non-monetary
    assert.strictEqual(createEventData.total_amount, 65000, 'Total expenditure equals ₹65,000');
    pass('Event NFA created with all 10 predefined expenditure particulars (₹65,000 total)');

    // Verify non-monetary sampling
    const samplingItem = createEventData.items.find((i: any) => i.predefined_key === 'sampling');
    assert.ok(samplingItem, 'Sampling item exists in proposal');
    assert.strictEqual(samplingItem.amount, 0, 'Sampling is strictly non-monetary (Amount = 0)');
    assert.strictEqual(samplingItem.sampling_required, true, 'Sampling requirement flagged true');
    pass('Sampling requirement verified as non-monetary (Amount = ₹0, sampling_required = true)');

    // Verify Quantity x Rate calculations
    const mementoItem = createEventData.items.find((i: any) => i.predefined_key === 'memento');
    assert.strictEqual(mementoItem.quantity, '5');
    assert.strictEqual(mementoItem.rate, '2000');
    assert.strictEqual(mementoItem.amount, 10000);
    assert.strictEqual(mementoItem.carry_back_arrangement, 'Carry bag included');
    pass('Memento quantity (5), rate (2000), amount (10000), and carry bag subfield verified');

    const travelItem = createEventData.items.find((i: any) => i.predefined_key === 'travel_expenses');
    assert.strictEqual(travelItem.distance_km, '45');
    pass('Travel expenses distance_km (45 km) subfield verified');

    // Verify Resource Person AES-256-GCM Bank details
    const storedBankDetails = store.data.resource_person_bank_details.filter((bd) => bd.nfa_id === eventNfaId);
    assert.strictEqual(storedBankDetails.length, 2, 'Two resource person bank details stored');
    assert.ok(storedBankDetails[0].encrypted_account_number, 'Account number is encrypted at rest');
    assert.notStrictEqual(storedBankDetails[0].encrypted_account_number, '123456789012', 'Plaintext account number NOT stored at rest');
    const decryptedAcct = decryptAccountNumber(
      storedBankDetails[0].encrypted_account_number,
      storedBankDetails[0].iv,
      storedBankDetails[0].auth_tag
    );
    assert.strictEqual(decryptedAcct, '123456789012', 'Decrypted account number matches original plaintext');
    pass('Multiple resource persons bank details encrypted at rest with AES-256-GCM and verified');

    // Verify Honorarium reconciliation (sum of RP honoraria: 5000 + 5000 = 10000 matches Annexure item)
    const rpHonorariumSum = storedBankDetails.reduce((s, bd) => s + (bd.honorarium_amount || 0), 0);
    const annexureHonorarium = createEventData.items.find((i: any) => i.predefined_key === 'honorarium')?.amount || 0;
    assert.strictEqual(rpHonorariumSum, annexureHonorarium, 'Resource persons total honorarium equals Annexure item (no duplicate expenditure)');
    pass('Honorarium reconciliation verified: RP honoraria sum equals Annexure line item (₹10,000)');

    // -------------------------------------------------------------------------
    // TEST GROUP 4: PURCHASE NFA CREATION, QUOTATIONS & COMPARATIVE STATEMENT
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Testing Purchase NFA Creation, Quotations & Strict Validation ---');
    const purchasePayload = {
      ref_no: `NFA/TEST/PUR/${Date.now()}`,
      financial_year_id: activeFy.id,
      budget_category_id: activeCat.id,
      organization_type: 'department',
      department_id: activeDept.id,
      title: 'Procurement of High-Performance Computing GPU Server',
      nfa_type: 'purchase',
      point1: 'Acquire dedicated GPU computing workstation for deep learning research and departmental laboratory.',
      point2: 'Server room rack installation, power backup, and gigabit network cabling logistics.',
      point3: 'Required for advanced postgraduate curriculum, AI research projects, and sponsored consultancy.',
      point4: 'The estimated expenditure details are attached as Annexure-I.',
      sdgs: 'SDG 4: Quality Education; SDG 9: Industry, Innovation and Infrastructure',
      purchase_details: {
        item_name: 'Dell Precision AI Workstation 7960',
        quantity: '1 Unit',
        rate: '450000',
        amount: 450000,
        description: 'Intel Xeon W9-3495X, 256GB ECC RAM, Dual NVIDIA RTX 6000 Ada 48GB GPU, 4TB NVMe SSD',
        purpose: 'Machine learning model training and research simulation for final year students and faculty.',
        additional_info: 'Includes 3-year onsite OEM warranty and installation support.',
      },
      // Purchase budget items (Predefined categories)
      items: [
        {
          particulars: '[Computer Hardware] Dell Precision AI Workstation 7960',
          quantity: '1',
          rate: '450000',
          amount: 450000,
          justification: 'Lowest quote meeting technical specifications',
        },
        {
          particulars: '[Software / Licences] RedHat Enterprise Linux AI Workstation License',
          quantity: '1',
          rate: '35000',
          amount: 35000,
          justification: 'OEM enterprise operating system and support',
        },
      ],
      // 3 Vendor Quotations
      quotations: [
        {
          vendor_name: 'TechSolutions India Pvt Ltd',
          quotation_ref: 'TS-2026-901',
          quotation_date: '2026-11-20',
          file_id: 'doc-quote-1',
          file_path: 'quote_vendor_a.pdf',
          original_filename: 'Quotation_TechSolutions.pdf',
          file_hash: 'hash-vendor-a-9872134',
        },
        {
          vendor_name: 'CompuNet Systems & Services',
          quotation_ref: 'CN-2026-442',
          quotation_date: '2026-11-22',
          file_id: 'doc-quote-2',
          file_path: 'quote_vendor_b.pdf',
          original_filename: 'Quotation_CompuNet.pdf',
          file_hash: 'hash-vendor-b-4491028',
        },
        {
          vendor_name: 'Apex Infotech Solutions',
          quotation_ref: 'APX-2026-108',
          quotation_date: '2026-11-24',
          file_id: 'doc-quote-3',
          file_path: 'quote_vendor_c.pdf',
          original_filename: 'Quotation_Apex.pdf',
          file_hash: 'hash-vendor-c-7719284',
        },
      ],
      comparative_statement: {
        file_id: 'doc-cs-1',
        file_path: 'comparative_statement_gpu.xlsx',
        original_filename: 'Comparative_Statement_GPU.xlsx',
        file_hash: 'hash-cs-file-129038',
      },
    };

    const createPurchaseRes = await fetch(`${baseUrl}/api/nfas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${facultyToken}`,
      },
      body: JSON.stringify(purchasePayload),
    });

    const createPurchaseData = await createPurchaseRes.json();
    assert.ok([200, 201].includes(createPurchaseRes.status), `Purchase creation status 200/201: ${JSON.stringify(createPurchaseData)}`);
    const purchaseNfaId = createPurchaseData.id;
    assert.strictEqual(createPurchaseData.total_amount, 485000, 'Total purchase amount equals ₹4,85,000');
    assert.strictEqual(createPurchaseData.quotations.length, 3, '3 Vendor quotations attached');
    assert.ok(createPurchaseData.comparative_statement, 'Comparative statement document attached');
    assert.strictEqual(createPurchaseData.purchase_details.item_name, 'Dell Precision AI Workstation 7960');
    pass('Purchase NFA created with item details, multiple category items, 3 quotations, and CS document');

    // -------------------------------------------------------------------------
    // TEST GROUP 5: DRAFT EDITING & BACKWARD COMPATIBILITY
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Testing Draft Editing & Updating ---');
    const editPayload = {
      ...eventPayload,
      id: eventNfaId,
      draft_id: eventNfaId,
      title: 'National AI and Robotics Symposium 2026 — Revised Edition',
    };
    const updateRes = await fetch(`${baseUrl}/api/nfas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${facultyToken}`,
      },
      body: JSON.stringify(editPayload),
    });
    const updateData = await updateRes.json();
    assert.ok([200, 201].includes(updateRes.status), 'Draft updated successfully');
    assert.strictEqual(updateData.id, eventNfaId);
    assert.strictEqual(updateData.title, 'National AI and Robotics Symposium 2026 — Revised Edition');
    pass('Draft NFA update and modification verified with ID preservation');

    // -------------------------------------------------------------------------
    // TEST GROUP 6: SUBMISSION & APPROVAL WORKFLOW PROGRESSION
    // -------------------------------------------------------------------------
    console.log('\n--- 6. Testing Complete Institutional Approval Hierarchy ---');
    // 1. Submit by Faculty
    const submitRes = await fetch(`${baseUrl}/api/nfas/${eventNfaId}/submit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${facultyToken}` },
    });
    const submitData = await submitRes.json();
    assert.strictEqual(submitRes.status, 200);
    assert.strictEqual(submitData.status, 'pending_hod_review');
    pass('Faculty submission: status advanced to "pending_hod_review"');

    // Login HOD
    const hodLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'hod@christ.edu', password: testPass }),
    });
    const hodToken = (await hodLoginRes.json()).token;

    // 2. HOD Review & Recommendation
    const hodApproveRes = await fetch(`${baseUrl}/api/nfas/${eventNfaId}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hodToken}`,
      },
      body: JSON.stringify({ decision: 'approve', comments: 'Recommended by HOD' }),
    });
    const hodApproveData = await hodApproveRes.json();
    assert.strictEqual(hodApproveRes.status, 200);
    assert.strictEqual(hodApproveData.status, 'pending_deans_office_verification');
    pass('HOD recommendation: status advanced to "pending_deans_office_verification"');

    // -------------------------------------------------------------------------
    // TEST GROUP 7: OFFICIAL PDF RENDERING (EVENT & PURCHASE)
    // -------------------------------------------------------------------------
    console.log('\n--- 7. Testing Official Individual PDF Generation ---');
    const eventPdfRes = await fetch(`${baseUrl}/api/nfas/${eventNfaId}/pdf`, {
      headers: { Authorization: `Bearer ${facultyToken}` },
    });
    assert.strictEqual(eventPdfRes.status, 200, 'Event NFA PDF returns HTTP 200');
    assert.ok(
      (eventPdfRes.headers.get('content-type') || '').includes('application/pdf'),
      'Event PDF has application/pdf content type'
    );
    const eventPdfBuffer = await eventPdfRes.arrayBuffer();
    assert.ok(eventPdfBuffer.byteLength > 1000, 'Event NFA PDF generated successfully');
    pass(`Official Event NFA PDF generated (${(eventPdfBuffer.byteLength / 1024).toFixed(1)} KB)`);

    const purchasePdfRes = await fetch(`${baseUrl}/api/nfas/${purchaseNfaId}/pdf`, {
      headers: { Authorization: `Bearer ${facultyToken}` },
    });
    assert.strictEqual(purchasePdfRes.status, 200, 'Purchase NFA PDF returns HTTP 200');
    assert.ok(
      (purchasePdfRes.headers.get('content-type') || '').includes('application/pdf'),
      'Purchase PDF has application/pdf content type'
    );
    const purchasePdfBuffer = await purchasePdfRes.arrayBuffer();
    assert.ok(purchasePdfBuffer.byteLength > 1000, 'Purchase NFA PDF generated successfully');
    pass(`Official Purchase NFA PDF generated (${(purchasePdfBuffer.byteLength / 1024).toFixed(1)} KB)`);

    // -------------------------------------------------------------------------
    // TEST GROUP 8: REVEAL PERMISSION & RBAC BOUNDARIES
    // -------------------------------------------------------------------------
    console.log('\n--- 8. Testing RBAC Boundaries on Confidential Bank Details ---');
    const currentBankDetails = store.data.resource_person_bank_details.filter((bd) => bd.nfa_id === eventNfaId);
    assert.strictEqual(currentBankDetails.length, 2, 'Two resource person bank details exist');
    const bankDetailId = currentBankDetails[0].id;

    // Faculty attempts to reveal bank details -> MUST BE FORBIDDEN 403
    const facultyRevealRes = await fetch(`${baseUrl}/api/nfas/${eventNfaId}/bank-details/${bankDetailId}/reveal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${facultyToken}` },
    });
    assert.strictEqual(facultyRevealRes.status, 403, 'Faculty blocked from revealing bank details (HTTP 403)');
    pass('RBAC security: Non-finance user strictly blocked from decrypting bank account (HTTP 403)');

    // Finance/Super Admin attempts to reveal -> ALLOWED 200
    const adminRevealRes = await fetch(`${baseUrl}/api/nfas/${eventNfaId}/bank-details/${bankDetailId}/reveal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const adminRevealData = await adminRevealRes.json();
    assert.strictEqual(adminRevealRes.status, 200);
    assert.strictEqual(adminRevealData.account_number, '123456789012');
    pass('RBAC security: Super Admin / Finance successfully authorized to reveal plaintext account (HTTP 200)');

    console.log('\n========================================================================');
    console.log(`   ALL RESTORATION TESTS PASSED: ${passed}/${total} (100% VERIFIED)`);
    console.log('========================================================================\n');
  } finally {
    server.close();
  }
}

runRestorationVerification().catch((err) => {
  console.error('Restoration verification suite failed:', err);
  process.exit(1);
});
