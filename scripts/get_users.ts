import { query } from '../src/db/pool.js';

async function main() {
  const faculty = await query("SELECT email, role, name FROM user_profiles WHERE role = 'faculty' LIMIT 5");
  console.log('Faculty users:', faculty.rows);

  const dean = await query("SELECT email, role, name FROM user_profiles WHERE role = 'dean' LIMIT 5");
  console.log('Dean users:', dean.rows);

  const finance = await query("SELECT email, role, name FROM user_profiles WHERE role IN ('finance', 'finance_officer') LIMIT 5");
  console.log('Finance users:', finance.rows);

  process.exit(0);
}

main().catch(console.error);
