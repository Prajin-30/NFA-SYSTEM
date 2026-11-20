async function checkDeployedLogin() {
  const url = 'https://nfa-system.onrender.com/api/auth/login';
  console.log(`Testing POST ${url} with institutional user...`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CU-NFA-Audit'
      },
      body: JSON.stringify({
        email: 'maryanita.ea@christuniversity.in',
        password: 'Password@123'
      })
    });
    console.log(`Deployed Login Status: ${res.status}`);
    const body = await res.json();
    console.log('Deployed Login Response:');
    console.log(`  - Token Received: ${Boolean(body?.token)}`);
    console.log(`  - User: ${JSON.stringify(body?.user)}`);
    console.log(`  - Must Change Password: ${body?.must_change_password}`);
    if (res.status === 200) {
      console.log('🎉 DEPLOYED PRODUCTION LOGIN IS FULLY RESTORED AND VERIFIED!');
    } else {
      console.log(`Deployed response indicates: ${JSON.stringify(body)}`);
    }
  } catch (err: any) {
    console.error(`Error connecting to ${url}: ${err.message}`);
  }
}

checkDeployedLogin();
