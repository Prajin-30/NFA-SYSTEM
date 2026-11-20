import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, getDbPool } from '../src/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function backupSupabaseData() {
  console.log('=== CREATING PRE-MIGRATION BACKUP OF SUPABASE DATA ===\n');
  const pool = getDbPool();
  try {
    const timestamp = Date.now();
    const backupFile = path.join(__dirname, '..', 'data', `supabase_backup_${timestamp}.json`);

    const tables = [
      'user_profiles',
      'departments',
      'financial_years',
      'budget_types',
      'budget_categories',
      'schema_migrations'
    ];

    const backupData: Record<string, any[]> = {};
    for (const table of tables) {
      try {
        const res = await query(`SELECT * FROM ${table};`);
        backupData[table] = res.rows;
        console.log(`✓ Backed up table ${table}: ${res.rows.length} rows`);
      } catch (err: any) {
        console.warn(`  Notice: table ${table} not present or empty: ${err.message}`);
        backupData[table] = [];
      }
    }

    fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2), 'utf8');
    console.log(`\n✓ Supabase backup successfully written to: ${backupFile}`);
    console.log(`  Total user profiles preserved: ${backupData.user_profiles?.length || 0}`);
  } finally {
    await pool.end();
  }
}

backupSupabaseData().catch((err) => {
  console.error('Fatal backup error:', err);
  process.exit(1);
});
