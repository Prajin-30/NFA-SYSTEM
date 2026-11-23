import { getDbPool } from '../src/db/pool.js';

async function run() {
  const client = await getDbPool().connect();
  try {
    const revRes = await client.query('SELECT * FROM event_revenues');
    console.log('Revenues:', revRes.rows);
    if (revRes.rows.length > 0) {
      const nfaId = revRes.rows[0].nfa_id;
      const nfaRes = await client.query('SELECT id, ref_no, title, department_id, financial_year_id, will_generate_revenue, event_completion_status FROM nfas WHERE id = $1', [nfaId]);
      console.log('NFA for revenue:', nfaRes.rows);
    }
  } finally {
    client.release();
    process.exit(0);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
