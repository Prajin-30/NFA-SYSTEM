import { runMigrations } from '../src/db/migrate.js';

async function main() {
  console.log('=== RUNNING PENDING DATABASE MIGRATIONS ON SUPABASE ===\n');
  const result = await runMigrations();
  console.log('\nMigration Result:');
  console.log('Applied:', result.applied);
  console.log('Skipped:', result.skipped);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
