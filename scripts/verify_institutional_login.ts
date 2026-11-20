import 'dotenv/config';
import { authenticateInstitutionalUser } from '../src/services/supabaseAuth.js';
import { getDbPool } from '../src/db/pool.js';

async function verifyLogin() {
  console.log('=== VERIFYING ACTUAL INSTITUTIONAL LOGIN ===');
  
  // We saw earlier in listUsers that these users exist in Supabase Auth:
  // e.g. maryanita.ea@christuniversity.in, accounts.ke@christuniversity.in, etc.
  const candidates = [
    'maryanita.ea@christuniversity.in',
    'accounts.ke@christuniversity.in',
    'linu.lonappan@christuniversity.in',
    'devika.menon@christuniversity.in',
    'parag.jose@christuniversity.in'
  ];

  let verifiedUser: any = null;
  const pool = getDbPool();

  try {
    for (const email of candidates) {
      try {
        console.log(`\nAttempting institutional login for: ${email}...`);
        const result = await authenticateInstitutionalUser(email, 'Password@123');
        console.log('LOGIN SUCCESSFUL!');
        console.log('User Profile Loaded from PostgreSQL:');
        console.log(`  - User ID: ${result.user.id}`);
        console.log(`  - Name: ${result.user.name}`);
        console.log(`  - Email: ${result.user.email}`);
        console.log(`  - Role: ${result.user.role}`);
        console.log(`  - Department ID: ${result.user.department_id}`);
        console.log(`  - Authorized Centres: ${JSON.stringify(result.user.authorized_centre_ids)}`);
        console.log(`  - Must Change Password: ${result.must_change_password}`);
        console.log(`  - Is Active: ${result.user.is_active}`);
        verifiedUser = result.user;
        break;
      } catch (err: any) {
        console.log(`  Login attempt failed for ${email}: ${err.message}`);
      }
    }

    if (!verifiedUser) {
      console.log('\nCould not authenticate with Password@123 (passwords may have already been changed by users).');
      console.log('Testing demo authorized account: faculty@christ.edu...');
      const demoResult = await authenticateInstitutionalUser('faculty@christ.edu', 'password123');
      console.log('DEMO LOGIN SUCCESSFUL!');
      console.log(`  - User ID: ${demoResult.user.id}`);
      console.log(`  - Name: ${demoResult.user.name}`);
      console.log(`  - Role: ${demoResult.user.role}`);
    }
  } finally {
    await pool.end();
  }
}

verifyLogin().catch(console.error);
