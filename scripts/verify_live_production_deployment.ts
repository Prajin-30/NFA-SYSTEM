async function main() {
  console.log('======================================================');
  console.log('--- VERIFYING LIVE RENDER PRODUCTION DEPLOYMENT ---');
  console.log('======================================================');
  const baseUrl = 'https://nfa-system.onrender.com';
  
  // 1. Check HTML
  console.log('\n[1/3] Checking deployed index.html frontend fix...');
  const htmlRes = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(15000) });
  const htmlText = await htmlRes.text();
  const hasFrontendFix = htmlText.includes('(sIdx + 1)');
  console.log(`  Frontend length: ${htmlText.length} bytes`);
  console.log(`  Contains (sIdx + 1) fix: ${hasFrontendFix ? '✅ YES' : '❌ NO'}`);

  // 2. Authenticate
  console.log('\n[2/3] Authenticating as active institutional user...');
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'accounts.ke@christuniversity.in',
      password: 'Password@123'
    }),
    signal: AbortSignal.timeout(15000)
  });
  const loginJson: any = await loginRes.json();
  if (loginRes.status !== 200 || !loginJson.token) {
    throw new Error(`Login failed with status ${loginRes.status}: ${JSON.stringify(loginJson)}`);
  }
  console.log(`  ✅ Successfully authenticated as ${loginJson.user?.name} (${loginJson.user?.email})`);
  console.log(`  Role: ${loginJson.user?.role}`);

  // 3. Query categories and subcategories
  console.log('\n[3/3] Querying live /api/budgets/categories...');
  const catRes = await fetch(`${baseUrl}/api/budgets/categories`, {
    headers: { 'Authorization': `Bearer ${loginJson.token}` },
    signal: AbortSignal.timeout(15000)
  });
  console.log(`  Categories API status: ${catRes.status}`);
  if (catRes.status !== 200) {
    const errText = await catRes.text();
    throw new Error(`Failed to fetch categories: ${catRes.status} ${errText}`);
  }

  const categories: any[] = await catRes.json();
  console.log(`  Total budget categories returned: ${categories.length}`);

  const allSubcats: any[] = [];
  for (const cat of categories) {
    if (cat.subcategories && Array.isArray(cat.subcategories)) {
      allSubcats.push(...cat.subcategories);
    }
  }
  console.log(`  Total subcategories loaded from Supabase PostgreSQL: ${allSubcats.length}`);

  // Check the exact sequence requested by user:
  // "9, 10, 11, 12, 13, 14, 15, 16, 40, 16, 17, 17, 18"
  console.log('\n--- VERIFYING THE EXACT USER SPECIFIED SEQUENCE (9, 10, 11, 12, 13, 14, 15, 16, 40, 16, 17, 17, 18) ---');
  const sequenceTestCases = [
    { name: 'Faculty Development Programme', expectedSl: '9' },
    { name: 'Seminar', expectedSl: '10' },
    { name: 'Workshops', expectedSl: '11' },
    { name: 'Conference', expectedSl: '12' },
    { name: 'Membership Reimbursement', expectedSl: '13' },
    { name: 'Travel & Conveyance - Conveyance', expectedSl: '14' },
    { name: 'Travel & Conveyance - Domestic Travel', expectedSl: '15' },
    { name: 'Travel & Conveyance - International Travel', expectedSl: '16' },
    { name: 'Faculty Training in Industry', expectedSl: '40' },
    { name: 'Out Bound Training', expectedSl: '16' },
    { name: 'Remuneration for Instructors for conducting Certification Courses', expectedSl: '17' },
    { name: 'Fee Concession', expectedSl: '18' }
  ];

  let allPassed = true;
  for (const tc of sequenceTestCases) {
    const found = allSubcats.find(s => s.name?.trim().toLowerCase() === tc.name.toLowerCase());
    if (!found) {
      console.log(`  ❌ MISSING: "${tc.name}"`);
      allPassed = false;
    } else {
      const actualSl = String(found.sl_no).trim();
      const match = actualSl === tc.expectedSl;
      console.log(`  ${match ? '✅ PASSED' : '❌ FAILED'}: sl_no="${found.sl_no}" (Expected "${tc.expectedSl}") -> "${found.name}"`);
      if (!match) allPassed = false;
    }
  }

  // Also verify unnumbered items have NULL/undefined sl_no
  const unnumbered = allSubcats.filter(s => s.sl_no === null || s.sl_no === undefined || s.sl_no === '');
  console.log(`\n  Unnumbered/Informational line items with NULL sl_no: ${unnumbered.length} items`);
  console.log(`  Sample unnumbered items: ${unnumbered.slice(0, 3).map(u => `"${u.name}"`).join(', ')}`);

  if (allPassed && hasFrontendFix) {
    console.log('\n=============================================================');
    console.log('🎉 ALL 12 EXACT TEST CASES PASSED ON LIVE PRODUCTION!');
    console.log('🎉 CU-NFA DEPLOYMENT COMPLETED — READY FOR USER TESTING.');
    console.log('=============================================================');
  } else {
    throw new Error('Verification did not fully pass.');
  }
}

main().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
