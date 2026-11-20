import { query, getDbPool } from '../src/db/pool.js';

async function main() {
  const pool = getDbPool();
  try {
    const res = await query('SELECT id, name, code FROM departments');
    console.log(res.rows);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
