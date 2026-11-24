import https from 'https';

function checkLive() {
  console.log('Checking live production deployment at https://nfa-system.onrender.com...');

  https.get('https://nfa-system.onrender.com/favicon.ico', (res) => {
    console.log(`[Favicon] HTTP Status: ${res.statusCode}, Content-Type: ${res.headers['content-type']}`);
  });

  https.get('https://nfa-system.onrender.com', (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      console.log(`[Homepage] HTTP Status: ${res.statusCode}`);
      console.log(`[Check 1] Contains "Email ID": ${body.includes('Email ID')}`);
      console.log(`[Check 2] Contains "loginForm": ${body.includes('id="loginForm"')}`);
      console.log(`[Check 3] Contains "mobileReportSelector": ${body.includes('mobileReportSelector')}`);
      console.log(`[Check 4] Contains "report-catalogue-sidebar": ${body.includes('report-catalogue-sidebar')}`);
      console.log(`[Check 5] Contains commit 30d2e27 tokens (--page-padding-x): ${body.includes('--page-padding-x')}`);
      process.exit(body.includes('--page-padding-x') ? 0 : 2);
    });
  }).on('error', (e) => {
    console.error('Error fetching live site:', e.message);
    process.exit(1);
  });
}

checkLive();
