import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDbPool, withTransaction } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, 'migrations');

export interface MigrationRecord {
  version: string;
  applied_at: string;
}

/**
 * Ensures the schema_migrations table exists before running migrations.
 */
async function ensureMigrationsTable(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/**
 * Get list of currently applied migration versions from database.
 */
export async function getAppliedMigrations(): Promise<string[]> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const res = await client.query('SELECT version FROM schema_migrations ORDER BY applied_at ASC;');
    return res.rows.map((r) => r.version);
  } finally {
    client.release();
  }
}

/**
 * Apply all pending migrations in alphabetical/version order.
 * Each migration runs within an isolated ACID transaction.
 */
export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  const appliedVersions = await getAppliedMigrations();
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = path.basename(file, '.sql');
    if (appliedVersions.includes(version)) {
      skipped.push(version);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    let sql = fs.readFileSync(filePath, 'utf-8');
    // Strip file-level BEGIN/COMMIT so withTransaction controls the atomic transaction boundary
    sql = sql.replace(/^\s*BEGIN\s*;/gim, '-- BEGIN;').replace(/^\s*COMMIT\s*;/gim, '-- COMMIT;');

    console.log(`[MIGRATION] Applying migration: ${version}...`);
    await withTransaction(async (client) => {
      await ensureMigrationsTable(client);
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW()) ON CONFLICT (version) DO NOTHING;',
        [version]
      );
    });

    applied.push(version);
    console.log(`[MIGRATION] Successfully applied: ${version}`);
  }

  return { applied, skipped };
}

/**
 * Roll back the most recently applied migration using its .down.sql file.
 * STRICT SAFETY GUARD: Forbidden in production environments.
 */
export async function rollbackLastMigration(): Promise<{ rolledBack?: string; message: string }> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Destructive rollbacks are strictly forbidden in production environments.');
  }

  const appliedVersions = await getAppliedMigrations();
  if (appliedVersions.length === 0) {
    return { message: 'No applied migrations to roll back.' };
  }

  const lastVersion = appliedVersions[appliedVersions.length - 1];
  const downFile = `${lastVersion}.down.sql`;
  const downFilePath = path.join(migrationsDir, downFile);

  if (!fs.existsSync(downFilePath)) {
    throw new Error(`Rollback script not found for version: ${lastVersion} (${downFile})`);
  }

  const sql = fs.readFileSync(downFilePath, 'utf-8');
  console.log(`[MIGRATION ROLLBACK] Rolling back migration: ${lastVersion}...`);

  await withTransaction(async (client) => {
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE version = $1;', [lastVersion]);
  });

  console.log(`[MIGRATION ROLLBACK] Successfully rolled back: ${lastVersion}`);
  return { rolledBack: lastVersion, message: `Rolled back ${lastVersion}` };
}
