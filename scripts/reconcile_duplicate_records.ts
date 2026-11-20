/**
 * RECONCILIATION SCRIPT: Duplicate NFAs 0024-0027 & ₹8,800 Budget Release
 * 
 * Target Department: Department of AI & Data Science Engineering (ADSE)
 * Target Financial Year: 2026-27
 * 
 * CANONICAL ORIGINAL PRESERVED:
 * - NFA/ADSE/2026-27/0023 (ID: b051be71-cfbe-426b-87ee-848cf69a23d0)
 *   Status: pending_hod_review, Reservation: ₹2,200
 * 
 * DUPLICATE RECORDS TO BE RECONCILED:
 * - NFA/ADSE/2026-27/0024 (ID: 7d7cb992-fa33-4f9e-beee-06bb5047b856) -> Release ₹2,200
 * - NFA/ADSE/2026-27/0025 (ID: a9b9b008-0bf1-4775-9271-91a18c64115e) -> Release ₹2,200
 * - NFA/ADSE/2026-27/0026 (ID: 3f8ad866-9818-49d7-84bc-2f96e1a4980a) -> Release ₹2,200
 * - NFA/ADSE/2026-27/0027 (ID: c4844321-df1c-43f1-93e1-7ca8339485df) -> Release ₹2,200
 * 
 * TOTAL RESTORATION TO ADSE AVAILABLE BUDGET: EXACTLY ₹8,800.00
 * 
 * NOTE: RUNS IN DRY-RUN MODE BY DEFAULT.
 * Pass --execute flag only when user gives explicit authorization.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { store } from '../src/store.js';
import { releaseNfaReservation } from '../src/lib/budgetEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isExecute = process.argv.includes('--execute');

export async function previewOrExecuteCleanup(execute: boolean = false) {
  console.log(`=== DUPLICATE NFA 0024-0027 RECONCILIATION (${execute ? 'EXECUTION MODE' : 'DRY-RUN AUDIT MODE'}) ===\n`);

  const deptId = '330ada81-5246-4c92-9ca2-688eae0f28d4'; // ADSE
  const duplicateRefs = ['0024', '0025', '0026', '0027'];
  const originalRef = '0023';

  const nfas = store.data.nfas || [];
  const deptBudget = store.data.department_budgets.find(b => b.department_id === deptId);

  const originalNfa = nfas.find(n => n.ref_no && n.ref_no.includes(originalRef) && !n.is_deleted);
  const duplicateNfas = nfas.filter(n => n.ref_no && duplicateRefs.some(r => n.ref_no.includes(r)) && !n.is_deleted);

  console.log('1. PRESERVED ORIGINAL NFA:');
  if (originalNfa) {
    console.log(`   - Ref: ${originalNfa.ref_no} | ID: ${originalNfa.id} | Amount: ₹${originalNfa.total_amount} | Status: ${originalNfa.status}`);
  } else {
    console.log(`   - Note: Original 0023 not in current active dataset.`);
  }

  console.log(`\n2. IDENTIFIED DUPLICATE RECORDS (${duplicateNfas.length} records):`);
  let totalDuplicateAmount = 0;
  for (const dup of duplicateNfas) {
    console.log(`   - Ref: ${dup.ref_no} | ID: ${dup.id} | Amount: ₹${dup.total_amount} | Status: ${dup.status}`);
    totalDuplicateAmount += dup.total_amount || 0;
  }

  console.log(`\n3. FINANCIAL IMPACT ANALYSIS:`);
  console.log(`   - Current ADSE Allocated: ₹${deptBudget?.allocated_amount?.toLocaleString('en-IN')}`);
  console.log(`   - Current ADSE Approved:  ₹${deptBudget?.approved_amount?.toLocaleString('en-IN')}`);
  console.log(`   - Current ADSE Pending:   ₹${deptBudget?.pending_amount?.toLocaleString('en-IN')}`);
  console.log(`   - Total Duplicate Reservation to Release: ₹${totalDuplicateAmount.toLocaleString('en-IN')} (Target: ₹8,800)`);
  console.log(`   - Expected ADSE Pending After Cleanup:   ₹${Math.max(0, (deptBudget?.pending_amount || 0) - totalDuplicateAmount).toLocaleString('en-IN')}`);
  console.log(`   - Exact ₹8,800 Match: ${totalDuplicateAmount === 8800 ? 'YES' : 'RESERVATION ALREADY RESTORED OR CLEAN'}`);

  if (!execute) {
    console.log('\n[DRY RUN COMPLETE] Zero records deleted. Zero funds modified.');
    console.log('To execute cleanup after authorization, run: npx tsx scripts/reconcile_duplicate_records.ts --execute');
    return;
  }

  // EXECUTION PATH (REQUIRES EXPLICIT --execute)
  console.log('\n[EXECUTING RECONCILIATION]...');
  const backupPath = path.join(__dirname, '..', 'data', `db.json.pre_reconciliation_backup_${Date.now()}`);
  fs.copyFileSync(path.join(__dirname, '..', 'data', 'db.json'), backupPath);
  console.log(`✓ Safety backup created: ${backupPath}`);

  await store.transact((db) => {
    for (const dup of duplicateNfas) {
      // Release pending reservation
      releaseNfaReservation(db, dup, {
        changed_by: 'system_reconciliation',
        role: 'super_admin',
        reason: `Releasing duplicate reservation from rapid submission (Original preserved: ${originalRef})`
      });

      // Soft delete duplicate record to maintain relational integrity
      dup.is_deleted = true;
      (dup as any).deleted_at = new Date().toISOString();
      (dup as any).deletion_reason = `Consolidated duplicate rapid submission into ${originalRef}`;
    }
  });

  console.log(`✓ Successfully released ₹${totalDuplicateAmount.toLocaleString('en-IN')} and marked duplicates as deleted.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  previewOrExecuteCleanup(isExecute).catch(console.error);
}
