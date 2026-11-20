import { query, getDbPool } from '../src/db/pool.js';

async function listAdseFaculty() {
  const pool = getDbPool();
  try {
    const res = await query(`
      SELECT u.id, u.name, u.email, u.role, u.department_id, d.name as dept_name, d.code as dept_code
      FROM user_profiles u
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.department_id = '330ada81-5246-4c92-9ca2-688eae0f28d4' OR lower(d.code) = 'adse';
    `);
    console.log('ADSE Faculty & HOD in PostgreSQL:');
    console.log(res.rows);
  } finally {
    await pool.end();
  }
}

listAdseFaculty().catch(console.error);
