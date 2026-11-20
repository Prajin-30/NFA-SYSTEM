import type pg from 'pg';
import type { DB } from '../types.js';

export async function loadAllFromPostgres(client: pg.PoolClient): Promise<DB> {
  const usersRes = await client.query('SELECT * FROM user_profiles ORDER BY name ASC');
  const deptsRes = await client.query('SELECT * FROM departments ORDER BY name ASC');
  const fyRes = await client.query('SELECT * FROM financial_years ORDER BY label ASC');
  const btRes = await client.query('SELECT * FROM budget_types ORDER BY name ASC');
  const bcRes = await client.query('SELECT * FROM budget_categories ORDER BY name ASC');
  const dbBudgetsRes = await client.query('SELECT * FROM department_budgets');
  const subcatRes = await client.query('SELECT * FROM budget_subcategories');
  const projRes = await client.query('SELECT * FROM projects');
  const nfasRes = await client.query('SELECT * FROM nfas ORDER BY created_at DESC');
  const nfaItemsRes = await client.query('SELECT * FROM nfa_items ORDER BY sl_no ASC');
  const approvalsRes = await client.query('SELECT * FROM approvals ORDER BY level ASC');
  const txRes = await client.query('SELECT * FROM budget_transactions ORDER BY created_at DESC');
  const auditRes = await client.query('SELECT * FROM audit_logs ORDER BY created_at DESC');
  const syncRes = await client.query('SELECT * FROM excel_sync_records');
  const uploadsRes = await client.query('SELECT * FROM budget_uploads');
  const changesRes = await client.query('SELECT * FROM budget_changes');
  const bankRes = await client.query('SELECT * FROM resource_person_bank_details');
  const invoicesRes = await client.query('SELECT * FROM purchase_invoices');
  const tokensRes = await client.query('SELECT * FROM revoked_tokens');

  return {
    users: usersRes.rows as any,
    departments: deptsRes.rows as any,
    financial_years: fyRes.rows as any,
    budget_types: btRes.rows as any,
    budget_categories: bcRes.rows as any,
    department_budgets: dbBudgetsRes.rows.map((b) => ({
      ...b,
      allocated_amount: Number(b.allocated_amount) || 0,
      approved_amount: Number(b.approved_amount) || 0,
      pending_amount: Number(b.pending_amount) || 0,
      revised_amount: Number(b.revised_amount) || 0,
    })) as any,
    budget_subcategories: subcatRes.rows.map((s) => ({
      ...s,
      allocated_amount: Number(s.allocated_amount) || 0,
      approved_amount: Number(s.approved_amount) || 0,
      pending_amount: Number(s.pending_amount) || 0,
    })) as any,
    projects: projRes.rows.map((p) => ({
      ...p,
      budget_amount: Number(p.budget_amount) || 0,
    })) as any,
    nfas: nfasRes.rows.map((n) => ({
      ...n,
      total_amount: Number(n.total_amount) || 0,
      date: n.date ? new Date(n.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    })) as any,
    nfa_items: nfaItemsRes.rows.map((i) => ({
      ...i,
      amount: Number(i.amount) || 0,
    })) as any,
    approvals: approvalsRes.rows as any,
    budget_transactions: txRes.rows.map((t) => ({
      ...t,
      old_amount: Number(t.old_amount) || 0,
      new_amount: Number(t.new_amount) || 0,
      difference: Number(t.difference) || 0,
    })) as any,
    audit_logs: auditRes.rows.map((l) => ({
      ...l,
      old_amount: l.old_amount !== null ? Number(l.old_amount) : null,
      new_amount: l.new_amount !== null ? Number(l.new_amount) : null,
      difference: l.difference !== null ? Number(l.difference) : null,
    })) as any,
    excel_sync_records: syncRes.rows as any,
    budget_uploads: uploadsRes.rows as any,
    budget_changes: changesRes.rows as any,
    resource_person_bank_details: bankRes.rows.map((b) => ({
      ...b,
      honorarium_amount: Number(b.honorarium_amount) || 0,
      approved_honorarium: b.approved_honorarium ? Number(b.approved_honorarium) : undefined,
      deductions: b.deductions ? Number(b.deductions) : undefined,
      net_payable_amount: b.net_payable_amount ? Number(b.net_payable_amount) : undefined,
    })) as any,
    purchase_invoices: invoicesRes.rows.map((i) => ({
      ...i,
      invoice_amount: Number(i.invoice_amount) || 0,
      gst_amount: Number(i.gst_amount) || 0,
      paid_amount: Number(i.paid_amount) || 0,
      invoice_date: i.invoice_date ? new Date(i.invoice_date).toISOString().slice(0, 10) : '',
      payment_date: i.payment_date ? new Date(i.payment_date).toISOString().slice(0, 10) : undefined,
    })) as any,
    revoked_tokens: tokensRes.rows.map((t) => ({
      token_hash: t.token_hash,
      expires_at: new Date(t.expires_at).getTime(),
    })) as any,
  };
}

export async function persistDiffToPostgres(client: pg.PoolClient, before: DB, after: DB): Promise<void> {
  // 1. Department Budgets
  const beforeBudgets = new Map((before.department_budgets || []).map((b) => [b.id, JSON.stringify(b)]));
  for (const b of after.department_budgets || []) {
    const prev = beforeBudgets.get(b.id);
    if (!prev || prev !== JSON.stringify(b)) {
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
        b.id, b.department_id, b.financial_year_id, b.budget_category_id,
        Number(b.allocated_amount) || 0, Number(b.approved_amount) || 0,
        Number(b.pending_amount) || 0, Number(b.revised_amount) || 0,
        b.cell_mapping ? JSON.stringify(b.cell_mapping) : null
      ]);
    }
  }

  // 2. Budget Subcategories
  const beforeSubcats = new Map((before.budget_subcategories || []).map((s) => [s.id, JSON.stringify(s)]));
  for (const s of after.budget_subcategories || []) {
    const prev = beforeSubcats.get(s.id);
    if (!prev || prev !== JSON.stringify(s)) {
      await client.query(`
        INSERT INTO budget_subcategories (id, budget_category_id, department_id, name, allocated_amount, approved_amount, pending_amount, cell_mapping)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          allocated_amount = EXCLUDED.allocated_amount,
          approved_amount = EXCLUDED.approved_amount,
          pending_amount = EXCLUDED.pending_amount,
          cell_mapping = EXCLUDED.cell_mapping;
      `, [
        s.id, s.budget_category_id, s.department_id || null, s.name,
        Number(s.allocated_amount) || 0, Number(s.approved_amount) || 0,
        Number(s.pending_amount) || 0, s.cell_mapping ? JSON.stringify(s.cell_mapping) : null
      ]);
    }
  }

  // 3. Projects
  const beforeProjects = new Map((before.projects || []).map((p) => [p.id, JSON.stringify(p)]));
  for (const p of after.projects || []) {
    const prev = beforeProjects.get(p.id);
    if (!prev || prev !== JSON.stringify(p)) {
      await client.query(`
        INSERT INTO projects (id, name, department_id, financial_year_id, budget_category_id, created_by, status, budget_amount, description, remarks)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          budget_amount = EXCLUDED.budget_amount;
      `, [
        p.id, p.name, p.department_id, p.financial_year_id, p.budget_category_id,
        p.created_by, p.status || 'active', Number(p.budget_amount) || 0,
        p.description || '', p.remarks || ''
      ]);
    }
  }

  // 4. NFAs
  const beforeNfas = new Map((before.nfas || []).map((n) => [n.id, JSON.stringify(n)]));
  for (const n of after.nfas || []) {
    const prev = beforeNfas.get(n.id);
    if (!prev || prev !== JSON.stringify(n)) {
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
          total_amount = EXCLUDED.total_amount,
          title = EXCLUDED.title,
          purpose = EXCLUDED.purpose,
          description = EXCLUDED.description,
          justification = EXCLUDED.justification,
          sdgs = EXCLUDED.sdgs,
          requirements = EXCLUDED.requirements,
          event_details = EXCLUDED.event_details,
          purchase_details = EXCLUDED.purchase_details,
          quotations = EXCLUDED.quotations,
          comparative_statement = EXCLUDED.comparative_statement,
          proposer_signature = EXCLUDED.proposer_signature,
          updated_at = NOW();
      `, [
        n.id, n.ref_no, n.project_id || null, n.department_id, n.centre_id || null,
        n.organization_type || 'department', n.workflow_type || 'department',
        n.financial_year_id, n.budget_type_id || null, n.budget_category_id,
        n.budget_subcategory_id || null, n.budget_subcategory_name || '',
        n.title || n.purpose || `Note for Approval (${n.ref_no})`, n.purpose || '',
        n.description || '', n.justification || '', n.sdgs || '', n.requirements || '',
        Number(n.total_amount) || 0, n.status, n.created_by,
        n.submitted_by_name || 'Faculty', n.submitted_by_designation || 'Faculty',
        n.hod_name || '', n.date || new Date().toISOString().slice(0, 10),
        n.point1 || '', n.point2 || '', n.point3 || '', n.point4 || '',
        n.nfa_type || 'event',
        n.event_details ? JSON.stringify(n.event_details) : null,
        n.purchase_details ? JSON.stringify(n.purchase_details) : null,
        n.quotations ? JSON.stringify(n.quotations) : '[]',
        n.comparative_statement ? JSON.stringify(n.comparative_statement) : null,
        n.proposer_signature || null
      ]);
    }
  }

  // Handle NFA Deletions if any
  const afterNfaIds = new Set((after.nfas || []).map((n) => n.id));
  for (const n of before.nfas || []) {
    if (!afterNfaIds.has(n.id)) {
      await client.query('DELETE FROM nfas WHERE id = $1', [n.id]);
    }
  }

  // 5. NFA Items
  const beforeItems = new Map((before.nfa_items || []).map((i) => [i.id, JSON.stringify(i)]));
  for (const item of after.nfa_items || []) {
    const prev = beforeItems.get(item.id);
    if (!prev || prev !== JSON.stringify(item)) {
      await client.query(`
        INSERT INTO nfa_items (id, nfa_id, sl_no, particulars, quantity, rate, amount, comments, justification, basis_of_budget, item_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET
          particulars = EXCLUDED.particulars,
          quantity = EXCLUDED.quantity,
          rate = EXCLUDED.rate,
          amount = EXCLUDED.amount,
          comments = EXCLUDED.comments,
          justification = EXCLUDED.justification;
      `, [
        item.id, item.nfa_id, item.sl_no || 1, item.particulars || 'Item',
        String(item.quantity || ''), String(item.rate || ''), Number(item.amount) || 0,
        item.comments || '', item.justification || '', item.basis_of_budget || '',
        item.item_type || 'custom'
      ]);
    }
  }

  // 6. Approvals
  const beforeApprovals = new Set((before.approvals || []).map((a) => a.id));
  for (const app of after.approvals || []) {
    if (!beforeApprovals.has(app.id)) {
      await client.query(`
        INSERT INTO approvals (id, nfa_id, approver_role, approver_id, approver_name, decision, comments, level, signature_image)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING;
      `, [
        app.id, app.nfa_id, app.approver_role, app.approver_id, app.approver_name || 'Approver',
        app.decision, app.comments || '', app.level || 1, app.signature_image || null
      ]);
    }
  }

  // 7. Budget Transactions
  const beforeTxs = new Set((before.budget_transactions || []).map((t) => t.id));
  for (const tx of after.budget_transactions || []) {
    if (!beforeTxs.has(tx.id)) {
      await client.query(`
        INSERT INTO budget_transactions (id, nfa_id, project_id, department_budget_id, type, old_amount, new_amount, difference, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING;
      `, [
        tx.id, tx.nfa_id || null, tx.project_id || null, tx.department_budget_id,
        tx.type || 'new', Number(tx.old_amount) || 0, Number(tx.new_amount) || 0,
        Number(tx.difference) || 0, tx.created_by
      ]);
    }
  }

  // 8. Audit Logs
  const beforeLogs = new Set((before.audit_logs || []).map((l) => l.id));
  for (const log of after.audit_logs || []) {
    if (!beforeLogs.has(log.id)) {
      await client.query(`
        INSERT INTO audit_logs (id, entity_type, entity_id, department_id, old_amount, new_amount, difference, changed_by, role, reason, source, approval_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO NOTHING;
      `, [
        log.id, log.entity_type || 'nfa', String(log.entity_id || ''), String(log.department_id || 'ALL'),
        log.old_amount !== null && log.old_amount !== undefined ? Number(log.old_amount) : null,
        log.new_amount !== null && log.new_amount !== undefined ? Number(log.new_amount) : null,
        log.difference !== null && log.difference !== undefined ? Number(log.difference) : null,
        log.changed_by, log.role || 'faculty', log.reason || '', log.source || 'portal',
        log.approval_status || 'submitted'
      ]);
    }
  }

  // 9. Purchase Invoices
  const beforeInvoices = new Map((before.purchase_invoices || []).map((i) => [i.id, JSON.stringify(i)]));
  for (const inv of after.purchase_invoices || []) {
    const prev = beforeInvoices.get(inv.id);
    if (!prev || prev !== JSON.stringify(inv)) {
      await client.query(`
        INSERT INTO purchase_invoices (
          id, nfa_id, invoice_number, vendor_name, invoice_amount, gst_amount, invoice_date,
          file_id, original_filename, file_path, file_size, mime_type,
          uploaded_by, uploaded_at, verification_status, verified_by, verified_at,
          return_reason, payment_status, paid_amount, payment_date, payment_ref_utr, payment_remarks
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
        ON CONFLICT (id) DO UPDATE SET
          verification_status = EXCLUDED.verification_status,
          verified_by = EXCLUDED.verified_by,
          verified_at = EXCLUDED.verified_at,
          return_reason = EXCLUDED.return_reason,
          payment_status = EXCLUDED.payment_status,
          paid_amount = EXCLUDED.paid_amount,
          payment_date = EXCLUDED.payment_date,
          payment_ref_utr = EXCLUDED.payment_ref_utr,
          payment_remarks = EXCLUDED.payment_remarks,
          updated_at = NOW();
      `, [
        inv.id, inv.nfa_id, inv.invoice_number, inv.vendor_name,
        Number(inv.invoice_amount), Number(inv.gst_amount) || 0, inv.invoice_date,
        inv.file_id || null, inv.original_filename || null, inv.file_path,
        inv.file_size || null, inv.mime_type || 'application/pdf',
        inv.uploaded_by, inv.uploaded_at || new Date().toISOString(),
        inv.verification_status || 'pending_verification', inv.verified_by || null, inv.verified_at || null,
        inv.return_reason || null, inv.payment_status || 'unpaid', Number(inv.paid_amount) || 0,
        inv.payment_date || null, inv.payment_ref_utr || null, inv.payment_remarks || null
      ]);
    }
  }

  // 10. Resource Person Bank Details
  const beforeBanks = new Map((before.resource_person_bank_details || []).map((b) => [b.id, JSON.stringify(b)]));
  for (const b of after.resource_person_bank_details || []) {
    const prev = beforeBanks.get(b.id);
    if (!prev || prev !== JSON.stringify(b)) {
      await client.query(`
        INSERT INTO resource_person_bank_details (
          id, nfa_id, resource_person_name, designation, organization, email, mobile, honorarium_amount,
          account_holder_name, bank_name, encrypted_account_number, iv, auth_tag, masked_account_number,
          ifsc_code, branch_name, remarks, tracking_status, approved_honorarium, deductions,
          net_payable_amount, payment_date, payment_ref_utr, payment_remarks
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
        ON CONFLICT (id) DO UPDATE SET
          tracking_status = EXCLUDED.tracking_status,
          approved_honorarium = EXCLUDED.approved_honorarium,
          deductions = EXCLUDED.deductions,
          net_payable_amount = EXCLUDED.net_payable_amount,
          payment_date = EXCLUDED.payment_date,
          payment_ref_utr = EXCLUDED.payment_ref_utr,
          payment_remarks = EXCLUDED.payment_remarks,
          updated_at = NOW();
      `, [
        b.id, b.nfa_id, b.resource_person_name, b.designation || null, b.organization || null,
        b.email || null, b.mobile || null, Number(b.honorarium_amount) || 0,
        b.account_holder_name, b.bank_name, b.encrypted_account_number, b.iv, b.auth_tag,
        b.masked_account_number, b.ifsc_code, b.branch_name || null, b.remarks || null,
        b.tracking_status || 'details_submitted',
        b.approved_honorarium !== undefined ? Number(b.approved_honorarium) : null,
        b.deductions !== undefined ? Number(b.deductions) : 0,
        b.net_payable_amount !== undefined ? Number(b.net_payable_amount) : null,
        b.payment_date || null, b.payment_ref_utr || null, b.payment_remarks || null
      ]);
    }
  }

  // 11. Revoked Tokens
  const beforeTokens = new Set((before.revoked_tokens || []).map((t) => t.token_hash));
  for (const t of after.revoked_tokens || []) {
    if (!beforeTokens.has(t.token_hash)) {
      await client.query(`
        INSERT INTO revoked_tokens (token_hash, expires_at)
        VALUES ($1, $2)
        ON CONFLICT (token_hash) DO NOTHING;
      `, [t.token_hash, typeof t.expires_at === 'number' ? new Date(t.expires_at).toISOString() : t.expires_at]);
    }
  }
}
