async function checkArulNfas() {
  console.log('Logging in as arul.v@christuniversity.in...');
  const loginRes = await fetch('https://nfa-system.onrender.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'arul.v@christuniversity.in',
      password: 'Password@123'
    })
  });

  const loginData = await loginRes.json();
  console.log('Login status:', loginRes.status, 'must_change_password:', loginData.must_change_password);
  const token = loginData.token;
  if (!token) return;

  const nfasRes = await fetch('https://nfa-system.onrender.com/api/nfas', {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log('NFAs HTTP status:', nfasRes.status);
  const nfas = await nfasRes.json();
  if (Array.isArray(nfas)) {
    console.log(`Total NFAs visible: ${nfas.length}`);
    const matched = nfas.filter((n: any) => 
      (n.ref_no && (n.ref_no.includes('0023') || n.ref_no.includes('0024') || n.ref_no.includes('0025') || n.ref_no.includes('0026') || n.ref_no.includes('0027'))) ||
      n.title === 'test' ||
      n.total_amount === 2200
    );
    console.log('Matched NFAs on Render:');
    console.log(JSON.stringify(matched, null, 2));
  } else {
    console.log('Response:', nfas);
  }
}

checkArulNfas().catch(console.error);
