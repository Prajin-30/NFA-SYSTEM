import { query, getDbPool } from '../src/db/pool.js';

async function main() {
  const pool = getDbPool();
  try {
    const res = await query(`
      SELECT id, name, email, role, department_id 
      FROM user_profiles 
      WHERE email ILIKE '%admin%' 
         OR email ILIKE '%arul%' 
         OR email ILIKE '%moses%' 
         OR email ILIKE '%dean%' 
         OR email ILIKE '%director%' 
         OR email ILIKE '%accounts%' 
         OR email ILIKE '%office%'
         OR role IN ('super_admin', 'director', 'dean', 'associate_dean', 'deans_office', 'finance', 'finance_head', 'hod')
      ORDER BY role, email;
    `);
    console.log(`Found ${res.rows.length} key users:`);
    for (const r of res.rows) {
      console.log(`- ${r.role.padEnd(16)} | ${r.email.padEnd(45)} | ${r.name.padEnd(30)} | ${r.id}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
