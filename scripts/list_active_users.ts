import { query, getDbPool } from '../src/db/pool.js';

async function main() {
  const pool = getDbPool();
  try {
    const res = await query('SELECT id, name, email, role, department_id, must_change_password FROM user_profiles WHERE must_change_password = false;');
    console.log(res.rows);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
