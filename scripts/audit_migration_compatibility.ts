import 'dotenv/config';
import { query, getDbPool } from '../src/db/pool.js';

async function auditMigrationCompatibility() {
  console.log('=== AUDITING MIGRATION 002 & 003 COMPATIBILITY ===');
  const pool = getDbPool();

  try {
    // 1. Audit user_profiles roles
    console.log('\n--- 1. CURRENT ROLES IN user_profiles ---');
    const rolesRes = await query('SELECT role, count(*) as count FROM user_profiles GROUP BY role ORDER BY count DESC;');
    for (const row of rolesRes.rows) {
      console.log(`  - Role '${row.role}': ${row.count} users`);
    }

    // 2. Audit nfas count and statuses
    console.log('\n--- 2. CURRENT NFAS IN DATABASE ---');
    const nfaCount = await query('SELECT count(*) as total FROM nfas;');
    console.log(`  Total NFAs in PostgreSQL: ${nfaCount.rows[0].total}`);
    if (parseInt(nfaCount.rows[0].total, 10) > 0) {
      const statusRes = await query('SELECT status, count(*) as count FROM nfas GROUP BY status;');
      for (const row of statusRes.rows) {
        console.log(`  - Status '${row.status}': ${row.count}`);
      }
    }

    // 3. Audit departments vs centres
    console.log('\n--- 3. DEPARTMENTS & CENTRES IN DATABASE ---');
    const deptCount = await query('SELECT count(*) as total FROM departments;');
    console.log(`  Total departments in PostgreSQL: ${deptCount.rows[0].total}`);

    // 4. Check for any conflicting constraints
    console.log('\n--- 4. CONSTRAINTS VERIFICATION ---');
    const userConstraints = await query(`
      SELECT conname, pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c
      WHERE conrelid = 'user_profiles'::regclass;
    `);
    console.log('  user_profiles constraints:');
    for (const c of userConstraints.rows) {
      console.log(`    * ${c.conname}: ${c.def}`);
    }

    const nfaConstraints = await query(`
      SELECT conname, pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c
      WHERE conrelid = 'nfas'::regclass;
    `);
    console.log('  nfas constraints:');
    for (const c of nfaConstraints.rows) {
      console.log(`    * ${c.conname}: ${c.def}`);
    }

    console.log('\n=== AUDIT COMPLETE: ALL CHECKS FINISHED ===');
  } finally {
    await pool.end();
  }
}

auditMigrationCompatibility().catch(console.error);
