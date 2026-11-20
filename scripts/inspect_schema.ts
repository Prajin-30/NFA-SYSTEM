import 'dotenv/config';
import { query, inspectConnectionUrl, getDbPool } from '../src/db/pool.js';
import { getSupabaseAdmin, isLiveSupabaseAuthConfigured } from '../src/services/supabaseAuth.js';

async function inspectSchema() {
  console.log('=== DATABASE & SCHEMA INSPECTION ===');
  const connInfo = inspectConnectionUrl();
  console.log(`Target Host: ${connInfo.host}:${connInfo.port}`);
  console.log(`Target Database: ${connInfo.database}`);
  console.log(`Pooler Mode: ${connInfo.poolerMode} (isPooler: ${connInfo.isPooler})`);

  const pool = getDbPool();
  try {
    // 1. Check schema_migrations
    console.log('\n--- 1. SCHEMA MIGRATIONS TABLE ---');
    try {
      const migRes = await query('SELECT version, applied_at FROM schema_migrations ORDER BY applied_at ASC;');
      console.log('Applied migrations:');
      for (const row of migRes.rows) {
        console.log(`  - ${row.version} (applied at ${row.applied_at})`);
      }
      if (migRes.rows.length === 0) {
        console.log('  (schema_migrations exists but has 0 records)');
      }
    } catch (migErr: any) {
      console.log(`  Error querying schema_migrations: ${migErr.message} (Code: ${migErr.code})`);
    }

    // 2. Check user_profiles columns
    console.log('\n--- 2. USER_PROFILES COLUMNS ---');
    try {
      const colRes = await query(`
        SELECT column_name, data_type, udt_name, is_nullable, column_default 
        FROM information_schema.columns 
        WHERE table_name = 'user_profiles' 
        ORDER BY ordinal_position;
      `);
      console.log(`Found ${colRes.rows.length} columns in user_profiles:`);
      for (const col of colRes.rows) {
        console.log(`  - ${col.column_name}: ${col.data_type} (${col.udt_name}) | default: ${col.column_default} | nullable: ${col.is_nullable}`);
      }
      const hasAuthCentreIds = colRes.rows.some((r) => r.column_name === 'authorized_centre_ids');
      console.log(`\n  >> 'authorized_centre_ids' exists: ${hasAuthCentreIds}`);
    } catch (colErr: any) {
      console.log(`  Error inspecting columns of user_profiles: ${colErr.message} (Code: ${colErr.code})`);
    }

    // 3. Check nfas columns
    console.log('\n--- 3. NFAS COLUMNS ---');
    try {
      const nfaColRes = await query(`
        SELECT column_name, data_type, udt_name, is_nullable 
        FROM information_schema.columns 
        WHERE table_name = 'nfas' 
        ORDER BY ordinal_position;
      `);
      console.log(`Found ${nfaColRes.rows.length} columns in nfas:`);
      const nfaCols = nfaColRes.rows.map((r) => r.column_name);
      console.log(`  - has organization_type: ${nfaCols.includes('organization_type')}`);
      console.log(`  - has workflow_type: ${nfaCols.includes('workflow_type')}`);
      console.log(`  - has centre_id: ${nfaCols.includes('centre_id')}`);
    } catch (nfaColErr: any) {
      console.log(`  Error inspecting columns of nfas: ${nfaColErr.message} (Code: ${nfaColErr.code})`);
    }

    // 4. Check user_profiles constraints
    console.log('\n--- 4. USER_PROFILES ROLE CONSTRAINT ---');
    try {
      const consRes = await query(`
        SELECT conname, pg_get_constraintdef(c.oid) as def
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE conrelid = 'user_profiles'::regclass;
      `);
      for (const row of consRes.rows) {
        console.log(`  - ${row.conname}: ${row.def}`);
      }
    } catch (consErr: any) {
      console.log(`  Error inspecting constraints: ${consErr.message} (Code: ${consErr.code})`);
    }

    // 5. Check user_profiles count & sample records
    console.log('\n--- 5. USER_PROFILES RECORDS ---');
    try {
      const countRes = await query('SELECT COUNT(*) as total FROM user_profiles;');
      console.log(`Total records in user_profiles: ${countRes.rows[0].total}`);

      const userSample = await query('SELECT id, name, email, role, department_id, is_active FROM user_profiles LIMIT 15;');
      console.log('Sample profiles in database:');
      for (const u of userSample.rows) {
        console.log(`  - ID: ${u.id} | Email: ${u.email} | Role: ${u.role} | Dept: ${u.department_id} | Active: ${u.is_active}`);
      }
    } catch (uErr: any) {
      console.log(`  Error inspecting user_profiles records: ${uErr.message} (Code: ${uErr.code})`);
    }

    // 6. Check Supabase Auth Users
    console.log('\n--- 6. SUPABASE AUTH USERS (READ-ONLY) ---');
    if (isLiveSupabaseAuthConfigured()) {
      const supabase = getSupabaseAdmin();
      if (supabase) {
        try {
          const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 20 });
          if (error) {
            console.log(`  Supabase auth.admin.listUsers error: ${error.message}`);
          } else {
            console.log(`Total Supabase Auth users found: ${data.users.length}`);
            for (const u of data.users) {
              console.log(`  - Supabase User ID: ${u.id} | Email: ${u.email} | Confirmed: ${u.email_confirmed_at ? 'Yes' : 'No'}`);
            }
          }
        } catch (supErr: any) {
          console.log(`  Supabase Auth exception: ${supErr.message}`);
        }
      }
    } else {
      console.log('  Live Supabase Auth is not configured or in test mode.');
    }

  } finally {
    await pool.end();
  }
}

inspectSchema().catch((err) => {
  console.error('Fatal inspection error:', err);
  process.exit(1);
});
