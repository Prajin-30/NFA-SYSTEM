async function test() {
  try {
    const loginRes = await fetch('https://nfa-system.onrender.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maryanita.ea@christuniversity.in', password: 'Password@123' }),
      signal: AbortSignal.timeout(15000)
    });
    const loginJson: any = await loginRes.json();
    console.log('Login Status:', loginRes.status);
    console.log('User Role:', loginJson.user?.role, 'Department:', loginJson.user?.department_id);
    const token = loginJson.token;
    
    const catRes = await fetch('https://nfa-system.onrender.com/api/budgets/categories', {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(15000)
    });
    console.log('Categories Status:', catRes.status);
    const text = await catRes.text();
    console.log('Categories Body:', text.slice(0, 300));
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}
test();
