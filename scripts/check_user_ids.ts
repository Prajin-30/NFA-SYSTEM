import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, getDbPool } from '../src/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'db.json'), 'utf8'));
  const pool = getDbPool();
  try {
    const res = await query('SELECT id, name, email, role FROM user_profiles');
    console.log('PostgreSQL Users count:', res.rows.length);
    const pgEmails = new Map(res.rows.map(u => [u.email.toLowerCase(), u]));
    const pgIds = new Set(res.rows.map(u => u.id));
    
    console.log('\nMatching db.json users against PostgreSQL:');
    for (const u of db.users) {
      const match = pgEmails.get(u.email.toLowerCase());
      console.log(`JSON user: ${u.email.padEnd(30)} ID: ${u.id} | In PG by ID: ${pgIds.has(u.id)} | In PG by email: ${Boolean(match)} ${match ? `(${match.id})` : ''}`);
    }
  } finally {
    await pool.end();
  }
}

run().catch(console.error);
