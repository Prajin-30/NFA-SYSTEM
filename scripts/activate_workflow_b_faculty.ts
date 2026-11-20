import { query, getDbPool } from '../src/db/pool.js';

async function main() {
  const pool = getDbPool();
  try {
    await query("UPDATE user_profiles SET must_change_password = false WHERE id = '3450e702-304e-43ec-856b-6283c8fad4a5';");
    console.log('✓ Dr. Shibu K Mani initialized for Workflow B verification.');
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
