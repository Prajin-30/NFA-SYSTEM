async function checkCurrentStatus() {
  const baseUrl = 'https://nfa-system.onrender.com';
  console.log('Logging in as Super Admin (admin@christ.edu)...');
  const adminRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@christ.edu', password: 'Password@123' })
  });
  const adminJson: any = await adminRes.json();
  console.log(`Admin login status: ${adminRes.status}, User: ${adminJson.user?.email} (${adminJson.user?.role})`);
  const adminToken = adminJson.token;
  
  const statusRes = await fetch(`${baseUrl}/api/admin/email-testing/status`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  console.log(`Current Email Testing Status on Render: ${statusRes.status}`);
  const statusData = await statusRes.json();
  console.log('Status Data from Render:', JSON.stringify(statusData, null, 2));

  console.log('\nTrying to trigger email testing on Render right now:');
  const sendRes = await fetch(`${baseUrl}/api/admin/email-testing/send`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
  });
  console.log(`Send Status on Render: ${sendRes.status}`);
  const sendData = await sendRes.json();
  console.log('Send Response:', JSON.stringify(sendData, null, 2));
}

checkCurrentStatus().catch(console.error);
