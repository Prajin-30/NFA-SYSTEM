import { store } from '../src/store.js';

async function main() {
  console.log('=== VERIFYING NFA RECORDS 0023 - 0027 ===\n');

  const targetRefs = ['0023', '0024', '0025', '0026', '0027'];
  const matched = store.data.nfas.filter(n => n.ref_no && targetRefs.some(t => n.ref_no.includes(t)));

  console.log(`Found ${matched.length} matching NFAs in local store:`);
  for (const n of matched) {
    const items = store.data.nfa_items.filter(i => i.nfa_id === n.id);
    const approvals = store.data.approvals.filter(a => a.nfa_id === n.id);
    console.log({
      id: n.id,
      ref_no: n.ref_no,
      title: n.title,
      created_by: n.created_by,
      submitted_by_name: n.submitted_by_name,
      department_id: n.department_id,
      total_amount: n.total_amount,
      status: n.status,
      created_at: n.created_at,
      items_count: items.length,
      items_particulars: items.map(i => `${i.particulars}: ₹${i.amount}`).join(', '),
      approvals_count: approvals.length,
      approvals: approvals.map(a => `${a.approver_role}:${a.decision}`)
    });
  }

  // Check budget reservations for the department
  const deptId = matched[0]?.department_id || '330ada81-5246-4c92-9ca2-688eae0f28d4';
  const deptBudget = store.data.department_budgets.find(b => b.department_id === deptId);
  const subcats = (store.data.budget_subcategories || []).filter(s => s.department_id === deptId);

  console.log('\n--- DEPARTMENT BUDGET RESERVATION STATUS ---');
  console.log('Department ID:', deptId);
  console.log('Dept Allocated:', deptBudget?.allocated_amount, 'Approved:', deptBudget?.approved_amount, 'Pending Reserved:', deptBudget?.pending_amount);
  console.log('Matching Subcategories:');
  subcats.forEach(s => {
    if (s.pending_amount > 0 || s.approved_amount > 0) {
      console.log(`- ${s.name} (${s.id}): Allocated=₹${s.allocated_amount}, Approved=₹${s.approved_amount}, Pending=₹${s.pending_amount}`);
    }
  });

  // Calculate reservation release
  const duplicates = matched.filter(n => n.ref_no.includes('0024') || n.ref_no.includes('0025') || n.ref_no.includes('0026') || n.ref_no.includes('0027'));
  const original = matched.find(n => n.ref_no.includes('0023'));

  console.log('\n--- CONFIRMATION ANALYSIS ---');
  console.log('Original candidate (0023):', original?.ref_no, 'ID:', original?.id, 'Status:', original?.status, 'Amount:', original?.total_amount);
  console.log(`Duplicates count: ${duplicates.length}`);
  const duplicateTotal = duplicates.reduce((sum, d) => sum + (d.total_amount || 0), 0);
  console.log(`Total amount reserved by duplicates: ₹${duplicateTotal}`);
  console.log(`Expected release: ₹8,800. Matches: ${duplicateTotal === 8800 ? 'YES (EXACT MATCH)' : 'NO'}`);
}

main().catch(console.error);
