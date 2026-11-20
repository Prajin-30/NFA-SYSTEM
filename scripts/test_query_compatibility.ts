import 'dotenv/config';
import { query, getDbPool } from '../src/db/pool.js';

async function testCompatibility() {
  console.log('--- TESTING QUERY COMPATIBILITY WITH DATABASE ---');
  const pool = getDbPool();
  const testEmail = 'maryanita.ea@christuniversity.in';

  // 1. Test original query (with authorized_centre_ids)
  console.log('\n[1] Testing original query with authorized_centre_ids:');
  try {
    const res = await query(
      'SELECT id, name, email, role, department_id, authorized_centre_ids, must_change_password, is_active, temp_password_created_at, signature_image FROM user_profiles WHERE lower(email) = $1 LIMIT 1;',
      [testEmail]
    );
    console.log('Result:', res.rows[0]);
  } catch (err: any) {
    console.log(`CONFIRMED ERROR: Code=${err.code} | Message=${err.message}`);
  }

  // 2. Test schema-tolerant query (without authorized_centre_ids)
  console.log('\n[2] Testing schema-tolerant query:');
  try {
    const res2 = await query(
      'SELECT id, name, email, role, department_id, must_change_password, is_active, temp_password_created_at, signature_image FROM user_profiles WHERE lower(email) = $1 LIMIT 1;',
      [testEmail]
    );
    console.log('SUCCESS! Profile retrieved:');
    console.log({
      id: res2.rows[0].id,
      name: res2.rows[0].name,
      email: res2.rows[0].email,
      role: res2.rows[0].role,
      dept: res2.rows[0].department_id,
      is_active: res2.rows[0].is_active,
    });
  } catch (err: any) {
    console.log(`ERROR: ${err.message}`);
  }

  await pool.end();
}

testCompatibility().catch(console.error);
