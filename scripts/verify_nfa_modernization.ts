process.env.DATA_SOURCE = process.env.DATA_SOURCE || 'json';
process.env.NODE_ENV = 'test';

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import http from 'http';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { app } from '../src/server.js';
import { store } from '../src/store.js';
import { resolveUsernameToEmail, auditUsernameConflicts, getMockAuthUsers } from '../src/services/supabaseAuth.js';
import { decryptAccountNumber } from '../src/lib/encryption.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runModernizationVerification() {
  console.log('========================================================================');
  console.log('   CU-NFA: NFA Modernization & Username Authentication Verification');
  console.log('========================================================================\n');

  if (store.initPromise) {
    try {
      await store.initPromise;
    } catch (e: any) {
      console.log('Using local fallback dataset:', e.message);
    }
  }
  (store as any).isPostgres = false;

  const testPass = 'Password@123';
  const testHash = bcrypt.hashSync(testPass, 8);

  // Seed demo test users with known password for isolated testing
  const testUsers = [
    { email: 'faculty@christ.edu', role: 'faculty' },
    { email: 'hod@christ.edu', role: 'hod' },
    { email: 'finance@christ.edu', role: 'finance' },
  ];
  for (const tu of testUsers) {
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

  // Register mock auth user for institutional admin login in test mode
  getMockAuthUsers().set('admin@christ.edu', {
    id: 'usr-admin-test',
    email: 'admin@christ.edu',
    passwordHash: testHash,
    mustChangePassword: false,
    isActive: true,
  });

  // Ensure admin user profile exists in store
  let adminProfile = store.data.users.find((u) => u.email.toLowerCase() === 'admin@christ.edu');
  if (adminProfile) {
    adminProfile.password_hash = testHash;
    (adminProfile as any).is_active = true;
  } else {
    store.data.users.push({
      id: 'usr-admin-test',
      name: 'System Admin',
      email: 'admin@christ.edu',
      password_hash: testHash,
      role: 'super_admin',
      department_id: null,
      created_at: new Date().toISOString(),
      is_active: true,
    } as any);
  }

  // Spin up ephemeral test server
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let passed = 0;
  let failed = 0;

  function record(desc: string, ok: boolean, detail: string = '') {
    if (ok) {
      console.log(`  ✓ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${desc} ${detail ? '— ' + detail : ''}`);
      failed++;
    }
  }

  try {
    // ------------------------------------------------------------------------
    // TEST GROUP 1: Username-Based Authentication & Resolution
    // ------------------------------------------------------------------------
    console.log('--- TEST GROUP 1: Username Authentication Resolution ---');
    
    // 1.1 Direct username resolution
    const resolvedAdmin = await resolveUsernameToEmail('admin');
    record('Username "admin" resolves to "admin@christ.edu"', resolvedAdmin.email === 'admin@christ.edu');

    const resolvedFaculty = await resolveUsernameToEmail('faculty');
    record('Username "faculty" resolves to "faculty@christ.edu"', resolvedFaculty.email === 'faculty@christ.edu');

    const resolvedHod = await resolveUsernameToEmail('hod');
    record('Username "hod" resolves to "hod@christ.edu"', resolvedHod.email === 'hod@christ.edu');

    const resolvedArul = await resolveUsernameToEmail('arul.v');
    record('Username "arul.v" resolves to registered university email', resolvedArul.email.includes('arul.v'));

    const resolvedFull = await resolveUsernameToEmail('finance@christ.edu');
    record('Full email "finance@christ.edu" is preserved', resolvedFull.email === 'finance@christ.edu');

    // 1.2 Username conflict audit
    const conflictAudit = auditUsernameConflicts();
    record('Username conflict audit detects zero collisions across domains', conflictAudit.hasConflicts === false);

    // 1.3 Login using username via HTTP API
    const loginResFaculty = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'faculty', password: testPass })
    });
    const facultyData = await loginResFaculty.json();
    record('HTTP POST /api/auth/login succeeds using username "faculty"', loginResFaculty.status === 200 && Boolean(facultyData.token));

    const loginResHod = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'hod', password: testPass })
    });
    const hodData = await loginResHod.json();
    record('HTTP POST /api/auth/login succeeds using username "hod"', loginResHod.status === 200 && Boolean(hodData.token));

    const facultyToken = facultyData.token;
    const hodToken = hodData.token;

    // 1.4 Invalid username/password generic error
    const invalidLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unknown_faculty_user', password: 'WrongPassword@123' })
    });
    const invalidData = await invalidLoginRes.json();
    record('Invalid username returns 401 with generic error message', invalidLoginRes.status === 401 && String(invalidData.error).includes('Invalid'));

    // ------------------------------------------------------------------------
    // TEST GROUP 2: Dedicated NFA Creation Page & Asset Structure
    // ------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 2: Dedicated NFA Creation Page Assets ---');

    const htmlPath = path.join(__dirname, '..', 'public', 'nfa-create.html');
    record('public/nfa-create.html file exists on disk', fs.existsSync(htmlPath));

    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // Verify all 17 SDGs in full official names
    const expectedSdgs = [
      'SDG 1: No Poverty',
      'SDG 2: Zero Hunger',
      'SDG 3: Good Health and Well-being',
      'SDG 4: Quality Education',
      'SDG 5: Gender Equality',
      'SDG 6: Clean Water and Sanitation',
      'SDG 7: Affordable and Clean Energy',
      'SDG 8: Decent Work and Economic Growth',
      'SDG 9: Industry, Innovation and Infrastructure',
      'SDG 10: Reduced Inequalities',
      'SDG 11: Sustainable Cities and Communities',
      'SDG 12: Responsible Consumption and Production',
      'SDG 13: Climate Action',
      'SDG 14: Life Below Water',
      'SDG 15: Life on Land',
      'SDG 16: Peace, Justice and Strong Institutions',
      'SDG 17: Partnerships for the Goals'
    ];

    const allSdgsPresent = expectedSdgs.every(s => htmlContent.includes(s));
    record('All 17 UN Sustainable Development Goals present by full official name', allSdgsPresent);

    // Verify routing aliases
    const routeRes1 = await fetch(`${baseUrl}/nfa/new`);
    const route1Text = await routeRes1.text();
    record('Route GET /nfa/new returns HTTP 200 and serves creation page', routeRes1.status === 200 && route1Text.includes('Create Note for Approval (NFA)'));

    const routeRes2 = await fetch(`${baseUrl}/nfa-create`);
    const route2Text = await routeRes2.text();
    record('Route GET /nfa-create returns HTTP 200 and serves creation page', routeRes2.status === 200 && route2Text.includes('Create Note for Approval (NFA)'));

    const routeRes3 = await fetch(`${baseUrl}/nfa-create.html`);
    const route3Text = await routeRes3.text();
    record('Route GET /nfa-create.html returns HTTP 200', routeRes3.status === 200 && route3Text.includes('Create Note for Approval (NFA)'));

    // ------------------------------------------------------------------------
    // TEST GROUP 3: Multiple Resource Persons & Bank Details
    // ------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 3: Multiple Resource Persons & Encryption ---');

    // Admin login for bank details inspection
    const loginAdmin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin', password: testPass })
    });
    const adminData = await loginAdmin.json();
    const adminToken = adminData.token;
    record('Admin login succeeds using username "admin"', loginAdmin.status === 200 && Boolean(adminToken));

    const activeFy = store.data.financial_years.find(f => f.is_active) || store.data.financial_years[0];
    const dept = store.data.departments.find(d => d.id === '05fee8aa-7cd5-4168-bc21-3b20ea533f62' || d.category === 'academic') || store.data.departments[0];
    const cat = store.data.budget_categories[0];

    const multiRpPayload = {
      title: 'Automated QA: National AI Symposium with Multiple Resource Persons',
      organization_type: 'department',
      department_id: dept.id,
      financial_year_id: activeFy.id,
      budget_category_id: cat.id,
      nfa_type: 'event',
      point1: 'Conduct national symposium on artificial intelligence and neural computing systems.',
      point2: 'Organized at Central Auditorium with dedicated lab tracks and high speed connectivity.',
      point3: 'Directly addresses curriculum requirements and advances departmental accreditation benchmarks.',
      point4: 'The estimated expenditure details are attached as Annexure-I.',
      sdgs: 'SDG 4: Quality Education; SDG 9: Industry, Innovation and Infrastructure',
      items: [
        { particulars: 'Honorarium for Keynote Speakers', quantity: '2', rate: '5000', amount: 10000, justification: 'Institutional rate' },
        { particulars: 'Conference Kits & Materials', quantity: '100', rate: '100', amount: 10000, justification: 'Participant materials' }
      ],
      resource_person_bank_details: [
        {
          resource_person_name: 'Dr. Jane Smith',
          designation: 'Senior Principal Scientist',
          organization: 'National AI Laboratory',
          email: 'jane.smith@lab.res.in',
          mobile: '+91 9876543210',
          honorarium_amount: 5000,
          account_holder_name: 'Jane Smith',
          bank_name: 'State Bank of India',
          branch_name: 'IISc Branch',
          ifsc_code: 'SBIN0001234',
          account_number: '123456789012',
          confirm_account_number: '123456789012'
        },
        {
          resource_person_name: 'Prof. Alan Turing',
          designation: 'Chair Professor',
          organization: 'Institute of Advanced Studies',
          email: 'alan.turing@ias.edu',
          mobile: '+91 9123456789',
          honorarium_amount: 5000,
          account_holder_name: 'Alan Turing',
          bank_name: 'HDFC Bank',
          branch_name: 'MG Road Branch',
          ifsc_code: 'HDFC0001234',
          account_number: '987654321098',
          confirm_account_number: '987654321098'
        }
      ]
    };

    const createRes = await fetch(`${baseUrl}/api/nfas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${facultyToken}`
      },
      body: JSON.stringify(multiRpPayload)
    });

    record('Create Event NFA with multiple resource persons returns 201', createRes.status === 201);
    const createdNfa = await createRes.json();

    // Verify bank details stored and encrypted
    const storedBankDetails = (store.data.resource_person_bank_details || []).filter(d => d.nfa_id === createdNfa.id);
    record('Stored exactly 2 resource person records in backend database', storedBankDetails.length === 2);

    const rp1 = storedBankDetails.find(d => d.resource_person_name === 'Dr. Jane Smith');
    const rp2 = storedBankDetails.find(d => d.resource_person_name === 'Prof. Alan Turing');

    record('Resource Person 1 account number is encrypted with AES-256-GCM', Boolean(rp1 && rp1.encrypted_account_number && rp1.iv && rp1.auth_tag));
    record('Resource Person 1 plaintext account is NOT stored raw in record', rp1?.encrypted_account_number !== '123456789012');
    record('Resource Person 1 masked account number is formatted correctly', Boolean(rp1?.masked_account_number.endsWith('9012')));

    // Decryption verification
    if (rp1) {
      const decrypted1 = decryptAccountNumber(rp1.encrypted_account_number, rp1.iv, rp1.auth_tag);
      record('AES-256-GCM decryption reproduces original account number (123456789012)', decrypted1 === '123456789012');
    }

    // 3.4 Non-finance view masking test
    const getFacultyRes = await fetch(`${baseUrl}/api/nfas/${createdNfa.id}`, {
      headers: { 'Authorization': `Bearer ${facultyToken}` }
    });
    const facultyNfaView = await getFacultyRes.json();
    const facultyRps = facultyNfaView.resource_person_bank_details || [];
    record('Faculty view includes resource persons with masked accounts', facultyRps.length === 2 && Boolean(facultyRps[0].masked_account_number) && !facultyRps[0].account_number);
    record('Faculty view cannot reveal confidential bank accounts (can_reveal=false)', facultyRps.length > 0 && facultyRps[0].can_reveal === false);

    // 3.5 Submit proposal to advance from private draft to submitted review stage
    const submitRes = await fetch(`${baseUrl}/api/nfas/${createdNfa.id}/submit`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${facultyToken}` }
    });
    record('Submit NFA advances state from draft to submitted', submitRes.status === 200);

    // 3.6 Finance / Super Admin view reveal test
    const getAdminRes = await fetch(`${baseUrl}/api/nfas/${createdNfa.id}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const adminNfaView = await getAdminRes.json();
    const adminRps = adminNfaView.resource_person_bank_details || [];
    record('Super Admin / Finance view has decryption authorization (can_reveal=true)', adminRps.length > 0 && adminRps[0].can_reveal === true);

    if (rp1) {
      const revealRes = await fetch(`${baseUrl}/api/nfas/${createdNfa.id}/bank-details/${rp1.id}/reveal`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      const revealData = await revealRes.json();
      record('POST /reveal decrypts and audits confidential bank account successfully', revealRes.status === 200 && revealData.account_number === '123456789012');
    }

    // ------------------------------------------------------------------------
    // TEST GROUP 4: Complete SDGs & PDF Generation
    // ------------------------------------------------------------------------
    console.log('\n--- TEST GROUP 4: SDG Persistence & PDF Output ---');

    record('SDGs are persisted on NFA record', createdNfa.sdgs.includes('SDG 4: Quality Education') && createdNfa.sdgs.includes('SDG 9: Industry, Innovation and Infrastructure'));

    const pdfRes = await fetch(`${baseUrl}/api/nfas/${createdNfa.id}/pdf`, {
      headers: { 'Authorization': `Bearer ${facultyToken}` }
    });
    record('GET /api/nfas/:id/pdf renders successfully with HTTP 200', pdfRes.status === 200 && pdfRes.headers.get('content-type') === 'application/pdf');

    // Clean up created test NFA
    await store.transact((db) => {
      db.nfas = db.nfas.filter(n => n.id !== createdNfa.id);
      db.nfa_items = db.nfa_items.filter(i => i.nfa_id !== createdNfa.id);
      if (db.resource_person_bank_details) {
        db.resource_person_bank_details = db.resource_person_bank_details.filter(d => d.nfa_id !== createdNfa.id);
      }
    });
  } finally {
    server.close();
  }

  // ------------------------------------------------------------------------
  // SUMMARY
  // ------------------------------------------------------------------------
  console.log('\n========================================================================');
  console.log(`Modernization Verification Results: ${passed} passed, ${failed} failed`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runModernizationVerification().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
