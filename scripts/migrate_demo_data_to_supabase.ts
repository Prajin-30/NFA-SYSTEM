import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { query, getDbPool, withTransaction } from '../src/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function toValidUuid(str: string): string {
  if (!str) return '00000000-0000-0000-0000-000000000000';
  if (uuidRe.test(str)) return str;
  const hash = crypto.createHash('md5').update('cu-nfa-' + str).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// Department ID translations to match the authoritative UUIDs in migration 001/002
const deptIdMap: Record<string, string> = {
  '11111111-m1m1-4004-8004-000000000004': '11111111-d1d1-4004-8004-000000000004',
  '11111111-s1h1-4005-8005-000000000005': '11111111-3181-4005-8005-000000000005',
  '22222222-r444-4004-8004-000000000004': '22222222-2444-4004-8004-000000000004',
};

function mapDeptId(id?: string | null): string {
  if (!id) return 'b5643609-22d9-4b21-9ce0-2f6eb5b9d04e'; // fallback to CSE
  if (deptIdMap[id]) return deptIdMap[id];
  return id;
}

async function main() {
  console.log('=== MIGRATING DEMO DATA TO SUPABASE POSTGRESQL ===\n');

  const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'db.json'), 'utf8'));
  const pool = getDbPool();

  try {
    // 1. Fetch available user profiles in PostgreSQL for foreign key mapping
    const usersRes = await query('SELECT id, name, email, role FROM user_profiles');
    const pgUsers = usersRes.rows;
    console.log(`✓ Located ${pgUsers.length} active user profiles in Supabase`);

    const adminUser = pgUsers.find(u => u.role === 'super_admin' || u.email.includes('admin')) || pgUsers[0];
    const arulUser = pgUsers.find(u => u.email.includes('arul.v')) || adminUser;
    const mosesUser = pgUsers.find(u => u.email.includes('michael.moses')) || adminUser;
    const deansOfficeUser = pgUsers.find(u => u.email.includes('office.dean')) || adminUser;
    const assocDeanUser = pgUsers.find(u => u.email.includes('associatedean')) || adminUser;
    const deanUser = pgUsers.find(u => u.email.includes('dean.engineering')) || adminUser;
    const financeUser = pgUsers.find(u => u.email.includes('asst.director')) || adminUser;
    const directorUser = pgUsers.find(u => u.email.includes('director.engineering')) || adminUser;
    const financeHeadUser = pgUsers.find(u => u.email.includes('accounts.ke')) || adminUser;

    const userMap: Record<string, string> = {
      '05fee8aa-7cd5-4168-bc21-3b20ea533f62': arulUser.id,
      'faculty@christ.edu': arulUser.id,
      '53709076-c3be-46eb-a123-0be426a086ee': mosesUser.id,
      'hod@christ.edu': mosesUser.id,
      '3db93f9d-d4b9-4534-a700-cdba8df2d6a0': financeUser.id,
      'finance@christ.edu': financeUser.id,
      '1e282899-d6f6-4c1a-9494-63753d80ee60': adminUser.id,
      'admin@christ.edu': adminUser.id,
      '7a91c842-15f3-4e89-a2e1-456987410231': deanUser.id,
      'dean@christ.edu': deanUser.id,
      '8b92d953-26a4-4f90-b3f2-567890123456': directorUser.id,
      'director@christ.edu': directorUser.id,
      'test-associate-dean-id': assocDeanUser.id,
      'associate_dean@christ.edu': assocDeanUser.id,
      'deans-office-user-id': deansOfficeUser.id,
      'deansoffice@christ.edu': deansOfficeUser.id,
      'finance-head-user-id': financeHeadUser.id,
      'financehead@christ.edu': financeHeadUser.id,
      'mech-fac-1': arulUser.id,
      'mech-hod-1': mosesUser.id,
      'faculty-user-id': arulUser.id,
      'faculty-user-b': arulUser.id,
      'faculty-c': arulUser.id,
      'hod-user': mosesUser.id,
      'director-user-id': directorUser.id,
      'director-id': directorUser.id,
      'super_admin': adminUser.id,
    };

    function mapUserId(id?: string | null): string {
      if (!id) return adminUser.id;
      if (userMap[id]) return userMap[id];
      const match = pgUsers.find(u => u.id === id);
      return match ? match.id : adminUser.id;
    }

    // ID translation caches
    const nfaIdMap: Record<string, string> = {};
    const projectIdMap: Record<string, string> = {};

    for (const p of db.projects || []) {
      projectIdMap[p.id] = toValidUuid(p.id);
    }
    for (const n of db.nfas || []) {
      nfaIdMap[n.id] = toValidUuid(n.id);
    }

    await withTransaction(async (client) => {
      // Step A: Update Roles in user_profiles
      console.log('\n--- Step A: Updating Specialized Roles in user_profiles ---');
      await client.query("UPDATE user_profiles SET role = 'deans_office' WHERE id = $1", [deansOfficeUser.id]);
      await client.query("UPDATE user_profiles SET role = 'associate_dean' WHERE id = $1", [assocDeanUser.id]);
      await client.query("UPDATE user_profiles SET role = 'finance_head' WHERE id = $1", [financeHeadUser.id]);
      await client.query("UPDATE user_profiles SET role = 'hod' WHERE id = $1", [mosesUser.id]);
      console.log('✓ Roles updated for Dean\'s Office, Associate Dean, Finance Head, and HOD');

      // Step B: Upsert Departments
      console.log('\n--- Step B: Upserting Departments & Centres of Excellence ---');
      for (const d of db.departments || []) {
        const canonicalId = mapDeptId(d.id);
        await client.query(`
          INSERT INTO departments (id, name, code, category, is_active, hod_name, dean_name, faculty_name, associate_dean_name, director_name, finance_officer_name)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            code = EXCLUDED.code,
            category = EXCLUDED.category,
            is_active = EXCLUDED.is_active,
            hod_name = EXCLUDED.hod_name,
            dean_name = EXCLUDED.dean_name,
            faculty_name = EXCLUDED.faculty_name,
            associate_dean_name = EXCLUDED.associate_dean_name,
            director_name = EXCLUDED.director_name,
            finance_officer_name = EXCLUDED.finance_officer_name;
        `, [
          canonicalId, d.name, d.code, d.category || 'academic', d.is_active !== false,
          d.hod_name || '', d.dean_name || '', d.faculty_name || '',
          d.associate_dean_name || '', d.director_name || '', d.finance_officer_name || ''
        ]);
      }
      console.log(`✓ Upserted ${(db.departments || []).length} departments`);

      // Step C: Upsert Financial Years
      console.log('\n--- Step C: Upserting Financial Years ---');
      for (const fy of db.financial_years || []) {
        await client.query(`
          INSERT INTO financial_years (id, label, is_active)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE SET
            label = EXCLUDED.label,
            is_active = EXCLUDED.is_active;
        `, [fy.id, fy.label, Boolean(fy.is_active)]);
      }
      console.log(`✓ Upserted ${(db.financial_years || []).length} financial years`);

      // Step D: Upsert Budget Types & Categories
      console.log('\n--- Step D: Upserting Budget Types & Categories ---');
      for (const bt of db.budget_types || []) {
        await client.query(`
          INSERT INTO budget_types (id, name)
          VALUES ($1, $2)
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
        `, [bt.id, bt.name]);
      }
      for (const bc of db.budget_categories || []) {
        await client.query(`
          INSERT INTO budget_categories (id, budget_type_id, name)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE SET
            budget_type_id = EXCLUDED.budget_type_id,
            name = EXCLUDED.name;
        `, [bc.id, bc.budget_type_id, bc.name]);
      }
      console.log(`✓ Upserted ${(db.budget_categories || []).length} categories`);

      // Step E: Upsert Department Budgets
      console.log('\n--- Step E: Upserting Department Master Budgets ---');
      for (const b of db.department_budgets || []) {
        const deptId = mapDeptId(b.department_id);
        await client.query(`
          INSERT INTO department_budgets (id, department_id, financial_year_id, budget_category_id, allocated_amount, approved_amount, pending_amount, revised_amount, cell_mapping)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (department_id, financial_year_id, budget_category_id) DO UPDATE SET
            allocated_amount = EXCLUDED.allocated_amount,
            approved_amount = EXCLUDED.approved_amount,
            pending_amount = EXCLUDED.pending_amount,
            revised_amount = EXCLUDED.revised_amount,
            cell_mapping = EXCLUDED.cell_mapping;
        `, [
          b.id, deptId, b.financial_year_id, b.budget_category_id,
          Number(b.allocated_amount) || 0, Number(b.approved_amount) || 0,
          Number(b.pending_amount) || 0, Number(b.revised_amount) || 0,
          b.cell_mapping ? JSON.stringify(b.cell_mapping) : null
        ]);
      }
      console.log(`✓ Upserted ${(db.department_budgets || []).length} department budget lines`);

      // Step F: Upsert Budget Subcategories
      console.log('\n--- Step F: Upserting Budget Subcategories ---');
      for (const sub of db.budget_subcategories || []) {
        const deptId = sub.department_id ? mapDeptId(sub.department_id) : null;
        await client.query(`
          INSERT INTO budget_subcategories (id, budget_category_id, department_id, name, allocated_amount, approved_amount, pending_amount, cell_mapping)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO UPDATE SET
            allocated_amount = EXCLUDED.allocated_amount,
            approved_amount = EXCLUDED.approved_amount,
            pending_amount = EXCLUDED.pending_amount,
            cell_mapping = EXCLUDED.cell_mapping;
        `, [
          sub.id, sub.budget_category_id, deptId, sub.name,
          Number(sub.allocated_amount) || 0, Number(sub.approved_amount) || 0,
          Number(sub.pending_amount) || 0, sub.cell_mapping ? JSON.stringify(sub.cell_mapping) : null
        ]);
      }
      console.log(`✓ Upserted ${(db.budget_subcategories || []).length} budget subcategories`);

      // Step G: Upsert Projects
      console.log('\n--- Step G: Upserting Projects ---');
      for (const p of db.projects || []) {
        const projId = projectIdMap[p.id] || toValidUuid(p.id);
        const deptId = mapDeptId(p.department_id);
        const creatorId = mapUserId(p.created_by);
        await client.query(`
          INSERT INTO projects (id, name, department_id, financial_year_id, budget_category_id, created_by, status, budget_amount, description, remarks)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO NOTHING;
        `, [
          projId, p.name, deptId, p.financial_year_id, p.budget_category_id,
          creatorId, p.status || 'active', Number(p.budget_amount) || 0,
          p.description || '', p.remarks || ''
        ]);
      }
      console.log(`✓ Upserted ${(db.projects || []).length} projects`);

      // Step H: Upsert Canonical NFAs
      console.log('\n--- Step H: Upserting Canonical NFAs ---');
      const seenRefNos = new Set<string>();
      for (const n of db.nfas || []) {
        const nfaId = nfaIdMap[n.id] || toValidUuid(n.id);
        const deptId = mapDeptId(n.department_id);
        const centreId = n.centre_id ? mapDeptId(n.centre_id) : null;
        const creatorId = mapUserId(n.created_by);
        const validProjectId = n.project_id && projectIdMap[n.project_id] ? projectIdMap[n.project_id] : null;
        const validSubcatId = n.budget_subcategory_id && (db.budget_subcategories || []).some(s => s.id === n.budget_subcategory_id) ? n.budget_subcategory_id : null;

        let uniqueRefNo = n.ref_no;
        if (seenRefNos.has(uniqueRefNo)) {
          let c = 2;
          while (seenRefNos.has(`${n.ref_no}-D${c}`)) {
            c++;
          }
          uniqueRefNo = `${n.ref_no}-D${c}`;
        }
        seenRefNos.add(uniqueRefNo);

        await client.query(`
          INSERT INTO nfas (
            id, ref_no, project_id, department_id, centre_id, organization_type, workflow_type,
            financial_year_id, budget_type_id, budget_category_id, budget_subcategory_id,
            budget_subcategory_name, title, purpose, description, justification, sdgs, requirements,
            total_amount, status, created_by, submitted_by_name, submitted_by_designation, hod_name,
            date, point1, point2, point3, point4, nfa_type, event_details, purchase_details,
            quotations, comparative_statement, proposer_signature
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            total_amount = EXCLUDED.total_amount;
        `, [
          nfaId, uniqueRefNo, validProjectId, deptId, centreId,
          n.organization_type || 'department', n.workflow_type || 'department',
          n.financial_year_id, n.budget_type_id || null, n.budget_category_id,
          validSubcatId, n.budget_subcategory_name || '',
          n.title || n.purpose || `Note for Approval (${uniqueRefNo})`, n.purpose || '', n.description || '', n.justification || '',
          n.sdgs || '', n.requirements || '', Number(n.total_amount) || 0,
          n.status, creatorId, n.submitted_by_name || 'Faculty',
          n.submitted_by_designation || 'Faculty', n.hod_name || '',
          n.date || new Date().toISOString().slice(0, 10),
          n.point1 || '', n.point2 || '', n.point3 || '', n.point4 || '',
          n.nfa_type || 'event',
          n.event_details ? JSON.stringify(n.event_details) : null,
          n.purchase_details ? JSON.stringify(n.purchase_details) : null,
          n.quotations ? JSON.stringify(n.quotations) : '[]',
          n.comparative_statement ? JSON.stringify(n.comparative_statement) : null,
          n.proposer_signature || null
        ]);
      }
      console.log(`✓ Upserted ${(db.nfas || []).length} canonical NFAs`);

      // Step I: Upsert NFA Line Items
      console.log('\n--- Step I: Upserting NFA Items ---');
      for (const item of db.nfa_items || []) {
        const nfaId = nfaIdMap[item.nfa_id] || toValidUuid(item.nfa_id);
        const itemId = toValidUuid(item.id);
        await client.query(`
          INSERT INTO nfa_items (id, nfa_id, sl_no, particulars, quantity, rate, amount, comments, justification, basis_of_budget, item_type)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO NOTHING;
        `, [
          itemId, nfaId, item.sl_no || 1, item.particulars || 'Item',
          String(item.quantity || ''), String(item.rate || ''), Number(item.amount) || 0,
          item.comments || '', item.justification || '', item.basis_of_budget || '',
          item.item_type || 'custom'
        ]);
      }
      console.log(`✓ Upserted ${(db.nfa_items || []).length} NFA items`);

      // Step J: Upsert Approvals
      console.log('\n--- Step J: Upserting Approvals ---');
      for (const app of db.approvals || []) {
        const nfaId = nfaIdMap[app.nfa_id] || toValidUuid(app.nfa_id);
        const appId = toValidUuid(app.id);
        const approverId = mapUserId(app.approver_id);
        await client.query(`
          INSERT INTO approvals (id, nfa_id, approver_role, approver_id, approver_name, decision, comments, level, signature_image)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO NOTHING;
        `, [
          appId, nfaId, app.approver_role, approverId, app.approver_name || 'Approver',
          app.decision, app.comments || '', app.level || 1, app.signature_image || null
        ]);
      }
      console.log(`✓ Upserted ${(db.approvals || []).length} approvals`);

      // Step K: Upsert Budget Transactions
      console.log('\n--- Step K: Upserting Budget Transactions ---');
      const validBudgetIds = new Set((db.department_budgets || []).map(b => b.id));
      for (const tx of db.budget_transactions || []) {
        if (!validBudgetIds.has(tx.department_budget_id)) {
          continue;
        }
        const txId = toValidUuid(tx.id);
        const nfaId = tx.nfa_id && nfaIdMap[tx.nfa_id] ? nfaIdMap[tx.nfa_id] : null;
        const projId = tx.project_id && projectIdMap[tx.project_id] ? projectIdMap[tx.project_id] : null;
        const createdBy = mapUserId(tx.created_by);
        await client.query(`
          INSERT INTO budget_transactions (id, nfa_id, project_id, department_budget_id, type, old_amount, new_amount, difference, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO NOTHING;
        `, [
          txId, nfaId, projId, tx.department_budget_id,
          tx.type || 'new', Number(tx.old_amount) || 0, Number(tx.new_amount) || 0,
          Number(tx.difference) || 0, createdBy
        ]);
      }
      console.log(`✓ Upserted ${(db.budget_transactions || []).length} budget transactions`);

      // Step L: Upsert Audit Logs
      console.log('\n--- Step L: Upserting Audit Logs ---');
      for (const log of db.audit_logs || []) {
        const logId = toValidUuid(log.id);
        const changedBy = mapUserId(log.changed_by);
        const deptId = log.department_id ? mapDeptId(log.department_id) : 'ALL';
        await client.query(`
          INSERT INTO audit_logs (id, entity_type, entity_id, department_id, old_amount, new_amount, difference, changed_by, role, reason, source, approval_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO NOTHING;
        `, [
          logId, log.entity_type || 'nfa', String(log.entity_id || ''), deptId,
          Number(log.old_amount) || 0, Number(log.new_amount) || 0, Number(log.difference) || 0,
          changedBy, log.role || 'faculty', log.reason || '', log.source || 'portal',
          log.approval_status || 'submitted'
        ]);
      }
      console.log(`✓ Upserted ${(db.audit_logs || []).length} audit logs`);

      // Step M: Upsert Purchase Invoices if any
      if (db.purchase_invoices && db.purchase_invoices.length > 0) {
        console.log('\n--- Step M: Upserting Purchase Invoices ---');
        for (const inv of db.purchase_invoices) {
          const invId = toValidUuid(inv.id);
          const nfaId = nfaIdMap[inv.nfa_id] || toValidUuid(inv.nfa_id);
          const uploadedBy = mapUserId(inv.uploaded_by);
          const verifiedBy = inv.verified_by ? mapUserId(inv.verified_by) : null;
          await client.query(`
            INSERT INTO purchase_invoices (
              id, nfa_id, invoice_number, vendor_name, invoice_amount, invoice_date,
              original_filename, stored_filename, file_size_bytes, mime_type, file_sha256,
              verification_status, payment_status, payment_date, payment_reference,
              notes, rejection_reason, uploaded_by, verified_by, verified_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            ON CONFLICT (id) DO NOTHING;
          `, [
            invId, nfaId, inv.invoice_number, inv.vendor_name, Number(inv.invoice_amount),
            inv.invoice_date, inv.original_filename, inv.stored_filename,
            inv.file_size_bytes || 0, inv.mime_type || 'application/pdf', inv.file_sha256 || '',
            inv.verification_status || 'pending', inv.payment_status || 'unpaid',
            inv.payment_date || null, inv.payment_reference || null, inv.notes || '',
            inv.rejection_reason || null, uploadedBy, verifiedBy, inv.verified_at || null
          ]);
        }
        console.log(`✓ Upserted ${db.purchase_invoices.length} purchase invoices`);
      }

      // Step N: Upsert Resource Person Bank Details if any
      if (db.resource_person_bank_details && db.resource_person_bank_details.length > 0) {
        console.log('\n--- Step N: Upserting Resource Person Bank Details ---');
        for (const bank of db.resource_person_bank_details) {
          const bankId = toValidUuid(bank.id);
          const nfaId = nfaIdMap[bank.nfa_id] || toValidUuid(bank.nfa_id);
          const createdBy = mapUserId(bank.created_by);
          await client.query(`
            INSERT INTO resource_person_bank_details (
              id, nfa_id, item_id, account_holder_name, account_number_encrypted,
              ifsc_code_encrypted, bank_name_encrypted, branch_name_encrypted,
              account_number_masked, ifsc_code_masked, pan_number_masked,
              is_verified, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (id) DO NOTHING;
          `, [
            bankId, nfaId, bank.item_id || null, bank.account_holder_name,
            bank.account_number_encrypted, bank.ifsc_code_encrypted,
            bank.bank_name_encrypted || null, bank.branch_name_encrypted || null,
            bank.account_number_masked, bank.ifsc_code_masked,
            bank.pan_number_masked || null, bank.is_verified || false, createdBy
          ]);
        }
        console.log(`✓ Upserted ${db.resource_person_bank_details.length} resource person bank records`);
      }
    });

    console.log('\n=== ALL DEMO DATA COMMITTED TO SUPABASE POSTGRESQL ATOMICALLY & SUCCESSFULLY! ===\n');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal data migration error:', err);
  process.exit(1);
});
