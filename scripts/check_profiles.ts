import { query, getDbPool } from '../src/db/pool.js';

async function checkProfiles() {
  const pool = getDbPool();
  try {
    const res = await query('SELECT id, name, email, role, must_change_password FROM user_profiles WHERE must_change_password = false LIMIT 10;');
    console.log('Profiles with must_change_password = false:');
    console.log(res.rows);
  } finally {
    await pool.end();
  }
}

checkProfiles().catch(console.error);
