import https from 'https';
import jwt from 'jsonwebtoken';

const LIVE_HOST = 'https://nfa-system.onrender.com';
const JWT_SECRET = process.env.JWT_SECRET || 'REPLACE_WITH_A_LONG_RANDOM_SECRET';

function httpGet(url: string, token?: string): Promise<{ status: number; headers: any; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: any = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.get(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 500,
            headers: res.headers,
            buffer: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
  });
}

async function verifyLive() {
  console.log('Testing live authenticated API on Render with Super Admin token...');
  const superAdminPayload = {
    id: 'super-admin-uuid',
    email: 'admin@christ.edu',
    name: 'Super Admin',
    role: 'super_admin',
    department_id: null,
  };
  const token = jwt.sign(superAdminPayload, JWT_SECRET, { expiresIn: '1h' });

  // 1. Summary Overview
  const summaryRes = await httpGet(`${LIVE_HOST}/api/reports/summary/overview?scope=department&id=ADSE`, token);
  console.log(`[Live Summary Overview] Status: ${summaryRes.status}`);
  if (summaryRes.status === 200) {
    const json = JSON.parse(summaryRes.buffer.toString('utf-8'));
    console.log(`  Org: ${json.org_name} (${json.org_code})`);
    console.log(`  Section 1 Total NFAs: ${json.metrics.total_nfas}`);
    console.log(`  Section 2 Submitted Sum: ${json.faculty_activity.reduce((s: number, f: any) => s + f.total_submitted, 0)}`);
    console.log(`  Section 3 Detailed Rows: ${json.detailed_nfas.length}`);
  }

  // 2. Summary PDF Export
  const pdfRes = await httpGet(`${LIVE_HOST}/api/reports/summary/export/pdf?scope=department&id=ADSE`, token);
  console.log(`[Live Summary PDF Export] Status: ${pdfRes.status}, Content-Type: ${pdfRes.headers['content-type']}, Size: ${pdfRes.buffer.length} bytes`);

  // 3. Summary Excel Export
  const excelRes = await httpGet(`${LIVE_HOST}/api/reports/summary/export/excel?scope=department&id=ADSE`, token);
  console.log(`[Live Summary Excel Export] Status: ${excelRes.status}, Content-Type: ${excelRes.headers['content-type']}, Size: ${excelRes.buffer.length} bytes`);

  // 4. Report data nfa_activity
  const nfaDataRes = await httpGet(`${LIVE_HOST}/api/reports/data/nfa_activity`, token);
  console.log(`[Live Report Data] Status: ${nfaDataRes.status}`);
  if (nfaDataRes.status === 200) {
    const json = JSON.parse(nfaDataRes.buffer.toString('utf-8'));
    console.log(`  NFA Activity Rows: ${json.total_records}`);
  }
}

verifyLive().catch(console.error);
