async function inspectDeployedNfas() {
  console.log('Connecting to https://nfa-system.onrender.com/api/auth/login...');
  const loginRes = await fetch('https://nfa-system.onrender.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'maryanita.ea@christuniversity.in',
      password: 'Password@123'
    })
  });

  const loginData = await loginRes.json();
  const token = loginData.token;
  if (!token) {
    console.error('Failed to get token:', loginData);
    return;
  }

  console.log('Fetching GET /api/nfas from deployed Render...');
  const nfasRes = await fetch('https://nfa-system.onrender.com/api/nfas', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const nfas = await nfasRes.json();
  console.log(`Total NFAs on Render: ${nfas.length}`);

  const testNfas = nfas.filter((n: any) => 
    (n.ref_no && (n.ref_no.includes('0023') || n.ref_no.includes('0024') || n.ref_no.includes('0025') || n.ref_no.includes('0026') || n.ref_no.includes('0027'))) ||
    n.title === 'test' ||
    n.total_amount === 2200
  );

  console.log('Matching test NFAs found on Render:');
  console.log(JSON.stringify(testNfas.map((n: any) => ({
    id: n.id,
    ref_no: n.ref_no,
    title: n.title,
    department_id: n.department_id,
    total_amount: n.total_amount,
    status: n.status,
    created_at: n.created_at,
    created_by: n.created_by
  })), null, 2));
}

inspectDeployedNfas().catch(console.error);
