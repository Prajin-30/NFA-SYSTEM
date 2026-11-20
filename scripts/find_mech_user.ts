import { query, getDbPool } from '../src/db/pool.js';

async function main() {
  const pool = getDbPool();
  try {
    const res = await query(`
      SELECT u.id, u.name, u.email, u.role, u.department_id, d.code, d.hod_name
      FROM user_profiles u
      JOIN departments d ON u.department_id = d.id
      WHERE d.code = 'CIVIL'
      LIMIT 5;
    `);
    console.log(res.rows);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
