import { store } from '../src/store.js';
import { getExecutiveSummaryData } from '../src/routes/reports.js';

async function testReconciliation() {
  await store.loadFromPostgres();
  const db = store.data;
  const adse = db.departments.find((d) => d.code === 'ADSE');

  const admin = db.users.find((u) => u.role === 'super_admin');

  console.log('--- TESTING EXECUTIVE SUMMARY RECONCILIATION FOR ADSE ---');
  const summary = getExecutiveSummaryData(admin!, {
    scope: 'department',
    id: adse?.id,
    include_all_faculty: 'false',
  });

  const sec1 = summary.metrics;
  const sec2 = summary.faculty_activity;
  const sec3 = summary.detailed_nfas;

  const sec2Submitted = sec2.reduce((s, f) => s + f.total_submitted, 0);
  const sec2Approved = sec2.reduce((s, f) => s + f.total_approved, 0);
  const sec2Pending = sec2.reduce((s, f) => s + f.total_pending, 0);
  const sec2Rejected = sec2.reduce((s, f) => s + f.total_rejected, 0);
  const sec2Events = sec2.reduce((s, f) => s + f.events_completed, 0);

  console.log('Section 1 Metrics:');
  console.log('  Total NFAs:', sec1.total_nfas);
  console.log('  Approved:', sec1.approved_nfas);
  console.log('  Pending:', sec1.pending_nfas);
  console.log('  Rejected:', sec1.rejected_nfas);
  console.log('  Events Completed:', sec1.events_completed_count);

  console.log('\nSection 2 Aggregated Sums:');
  console.log('  Total Submitted:', sec2Submitted);
  console.log('  Approved:', sec2Approved);
  console.log('  Pending:', sec2Pending);
  console.log('  Rejected:', sec2Rejected);
  console.log('  Events Completed:', sec2Events);

  console.log('\nSection 3 Records Count:', sec3.length);

  const matched = (
    sec1.total_nfas === sec2Submitted &&
    sec1.total_nfas === sec3.length &&
    sec1.approved_nfas === sec2Approved &&
    sec1.pending_nfas === sec2Pending &&
    sec1.rejected_nfas === sec2Rejected &&
    sec1.events_completed_count === sec2Events
  );

  console.log(`\nReconciliation Result: ${matched ? '✅ PERFECT 100% RECONCILED!' : '❌ DISCREPANCY DETECTED'}`);
}

testReconciliation().catch(console.error);
