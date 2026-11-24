import { store } from '../src/store.js';

async function main() {
  console.log('=== INVESTIGATING ADSE SUMMARY NFA COUNT INCONSISTENCY ===');
  await store.loadFromPostgres();
  const db = store.data;

  const adse = db.departments.find((d) => d.code === 'ADSE');
  console.log('ADSE Department:', adse?.name, 'ID:', adse?.id);

  // Active FY
  const activeFy = db.financial_years.find((f) => f.is_active) || db.financial_years[0];
  console.log('Active FY:', activeFy?.label, 'ID:', activeFy?.id);

  // 1. All NFAs belonging to ADSE in active FY
  const adseNfasInFy = db.nfas.filter(
    (n) => (n.department_id === adse?.id || n.centre_id === adse?.id) && n.status !== 'draft' && n.financial_year_id === activeFy?.id
  );
  console.log('\n[Section 1 & 3 Basis] Non-draft NFAs charged to ADSE in Active FY:', adseNfasInFy.length);
  const byStatus: Record<string, number> = {};
  adseNfasInFy.forEach((n) => {
    byStatus[n.status] = (byStatus[n.status] || 0) + 1;
  });
  console.log('  By Status:', byStatus);
  const eventsCompletedCount = adseNfasInFy.filter(
    (n) => n.nfa_type === 'event' && n.event_completion_status === 'completed'
  ).length;
  console.log('  Events Completed:', eventsCompletedCount);

  // 2. All NFAs belonging to ADSE across ALL FYs
  const adseNfasAllFy = db.nfas.filter(
    (n) => (n.department_id === adse?.id || n.centre_id === adse?.id) && n.status !== 'draft'
  );
  console.log('\nNon-draft NFAs charged to ADSE across ALL FYs:', adseNfasAllFy.length);

  // 3. Faculty belonging to ADSE
  const adseFaculty = db.users.filter((u) => u.department_id === adse?.id);
  console.log(`\nUsers affiliated with ADSE: ${adseFaculty.length}`);
  adseFaculty.forEach((u) => {
    console.log(`  User: ${u.name} | Role: ${u.role} | ID: ${u.id}`);
  });

  // 4. Section 2 current logic vs true department-scoped faculty logic
  console.log('\n[Section 2 Current Logic: All non-draft NFAs created by ADSE faculty, WITHOUT dept check]:');
  let sec2TotalSubmitted = 0;
  let sec2TotalApproved = 0;
  let sec2TotalPending = 0;
  let sec2EventsCompleted = 0;

  for (const f of adseFaculty) {
    if (f.role !== 'faculty') continue;
    // Current query in reports.ts line 393:
    // const fNfas = db.nfas.filter((n) => n.created_by === f.id && n.status !== 'draft' && n.financial_year_id === fyId);
    const fNfas = db.nfas.filter(
      (n) => n.created_by === f.id && n.status !== 'draft' && n.financial_year_id === activeFy?.id
    );
    const approved = fNfas.filter((n) => n.status === 'approved').length;
    const pending = fNfas.filter((n) => !['approved', 'rejected', 'draft'].includes(n.status)).length;
    const completed = fNfas.filter(
      (n) => n.nfa_type === 'event' && n.event_completion_status === 'completed'
    ).length;

    console.log(
      `  Faculty: ${f.name} -> Total: ${fNfas.length}, App: ${approved}, Pend: ${pending}, EvtDone: ${completed}`
    );

    fNfas.forEach((n) => {
      const isChargedToAdse = n.department_id === adse?.id || n.centre_id === adse?.id;
      if (!isChargedToAdse) {
        console.log(
          `    ⚠️ NFA ${n.ref_no} (${n.title}) created by ${f.name} is charged to DEPT ${n.department_id} / CENTRE ${n.centre_id}, NOT ADSE!`
        );
      }
    });

    sec2TotalSubmitted += fNfas.length;
    sec2TotalApproved += approved;
    sec2TotalPending += pending;
    sec2EventsCompleted += completed;
  }
  console.log(
    `  Section 2 Current Sums -> Submitted: ${sec2TotalSubmitted}, Approved: ${sec2TotalApproved}, Pending: ${sec2TotalPending}, EventsCompleted: ${sec2EventsCompleted}`
  );

  // 5. Check if some ADSE NFAs were created by non-faculty (e.g. HOD or Admin)
  console.log('\nChecking creators of the 21 ADSE NFAs:');
  adseNfasInFy.forEach((n) => {
    const creator = db.users.find((u) => u.id === n.created_by);
    console.log(
      `  NFA ${n.ref_no} | Status: ${n.status} | Creator: ${creator?.name} | Role: ${creator?.role} | CreatorDept: ${creator?.department_id}`
    );
  });
}

main().catch((err) => console.error(err));
