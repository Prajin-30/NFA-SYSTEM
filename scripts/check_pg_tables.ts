import { query, getDbPool } from '../src/db/pool.js';

async function check() {
  const pool = getDbPool();
  try {
    const res = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public';
    `);
    console.log('Tables in public schema:', res.rows.map(r => r.table_name));

    for (const row of res.rows) {
      try {
        const countRes = await query(`SELECT count(*) FROM "${row.table_name}";`);
        console.log(`- ${row.table_name}: ${countRes.rows[0].count} rows`);
      } catch (err: any) {
        console.log(`- ${row.table_name}: error (${err.message})`);
      }
    }
  } finally {
    await pool.end();
  }
}

check().catch(console.error);
