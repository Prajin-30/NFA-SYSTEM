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
  const schoolsRes = await client.query('SELECT * FROM schools ORDER BY code ASC');
  const revRes = await client.query('SELECT * FROM event_revenues ORDER BY created_at DESC');
  const revRemRes = await client.query('SELECT * FROM event_revenue_reminders ORDER BY sent_at DESC');

  let mfaRes: any = { rows: [] };
  let secAuditRes: any = { rows: [] };
  let secAlertsRes: any = { rows: [] };
  let emRes: any = { rows: [] };
  try { mfaRes = await client.query('SELECT * FROM user_mfa_settings'); } catch {}
  try { secAuditRes = await client.query('SELECT * FROM security_audit_logs ORDER BY created_at DESC LIMIT 500'); } catch {}
  try { secAlertsRes = await client.query('SELECT * FROM security_alerts ORDER BY created_at DESC LIMIT 100'); } catch {}
  try { emRes = await client.query('SELECT * FROM emergency_mode_state WHERE id = $1', ['current_state']); } catch {}

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
      sl_no: s.sl_no !== undefined && s.sl_no !== null ? s.sl_no : s.cell_mapping?.sl_no,
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
      will_generate_revenue: Boolean(n.will_generate_revenue),
      event_completion_status: n.event_completion_status || 'not_started',
      event_completion_date: n.event_completion_date ? new Date(n.event_completion_date).toISOString().slice(0, 10) : undefined,
      event_completion_remarks: n.event_completion_remarks || '',
      event_completed_by: n.event_completed_by || undefined,
      event_completed_at: n.event_completed_at || undefined,
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
    schools: schoolsRes.rows as any,
    event_revenues: revRes.rows.map((r) => ({
      ...r,
      amount: Number(r.amount) || 0,
      collection_date: r.collection_date ? new Date(r.collection_date).toISOString().slice(0, 10) : '',
    })) as any,
    event_revenue_reminders: revRemRes.rows as any,
    user_mfa_settings: mfaRes.rows as any,
    security_audit_logs: secAuditRes.rows as any,
    security_alerts: secAlertsRes.rows as any,
    emergency_mode_state: emRes.rows[0] || { id: 'current_state', is_active: false, reason: 'Normal operation', updated_at: new Date().toISOString() },
  };
}

export async function persistDiffToPostgres(client: pg.PoolClient, before: DB, after: DB): Promise<void> {
  // 0a. Departments
  const beforeDepts = new Map((before.departments || []).map((d) => [d.id, JSON.stringify(d)]));
  for (const d of after.departments || []) {
    const prev = beforeDepts.get(d.id);
    if (!prev || prev !== JSON.stringify(d)) {
      await client.query(`
        INSERT INTO departments (id, name, code, category, school_id, is_active)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          code = EXCLUDED.code,
          category = EXCLUDED.category,
          school_id = EXCLUDED.school_id,
          is_active = EXCLUDED.is_active;
      `, [d.id, d.name, d.code, d.category || 'academic', d.school_id || null, d.is_active ?? true]);
    }
  }

  // 0b. Financial Years
  const beforeFys = new Map((before.financial_years || []).map((f) => [f.id, JSON.stringify(f)]));
  for (const f of after.financial_years || []) {
    const prev = beforeFys.get(f.id);
    if (!prev || prev !== JSON.stringify(f)) {
      await client.query(`
        INSERT INTO financial_years (id, label, is_active)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label,
          is_active = EXCLUDED.is_active;
      `, [f.id, f.label, f.is_active ?? false]);
    }
  }

  // 0c. Budget Types
  const beforeTypes = new Map((before.budget_types || []).map((t) => [t.id, JSON.stringify(t)]));
  for (const t of after.budget_types || []) {
    const prev = beforeTypes.get(t.id);
    if (!prev || prev !== JSON.stringify(t)) {
      await client.query(`
        INSERT INTO budget_types (id, name)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
      `, [t.id, t.name]);
    }
  }

  // 0d. Budget Categories
  const beforeCategories = new Map((before.budget_categories || []).map((c) => [c.id, JSON.stringify(c)]));
  for (const c of after.budget_categories || []) {
    const prev = beforeCategories.get(c.id);
    if (!prev || prev !== JSON.stringify(c)) {
      await client.query(`
        INSERT INTO budget_categories (id, budget_type_id, name)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET
          budget_type_id = EXCLUDED.budget_type_id,
          name = EXCLUDED.name;
      `, [c.id, c.budget_type_id, c.name]);
    }
  }

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
      const slValue = s.sl_no !== undefined && s.sl_no !== null ? String(s.sl_no) : (s.cell_mapping?.sl_no ? String(s.cell_mapping.sl_no) : null);
      await client.query(`
        INSERT INTO budget_subcategories (id, budget_category_id, department_id, name, allocated_amount, approved_amount, pending_amount, cell_mapping, sl_no)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          allocated_amount = EXCLUDED.allocated_amount,
          approved_amount = EXCLUDED.approved_amount,
          pending_amount = EXCLUDED.pending_amount,
          cell_mapping = EXCLUDED.cell_mapping,
          sl_no = EXCLUDED.sl_no;
      `, [
        s.id, s.budget_category_id, s.department_id || null, s.name,
        Number(s.allocated_amount) || 0, Number(s.approved_amount) || 0,
        Number(s.pending_amount) || 0, s.cell_mapping ? JSON.stringify(s.cell_mapping) : null,
        slValue
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
          quotations, comparative_statement, proposer_signature,
          will_generate_revenue, event_completion_status, event_completion_date,
          event_completion_remarks, event_completed_by, event_completed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41)
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
          will_generate_revenue = EXCLUDED.will_generate_revenue,
          event_completion_status = EXCLUDED.event_completion_status,
          event_completion_date = EXCLUDED.event_completion_date,
          event_completion_remarks = EXCLUDED.event_completion_remarks,
          event_completed_by = EXCLUDED.event_completed_by,
          event_completed_at = EXCLUDED.event_completed_at,
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
        n.proposer_signature || null,
        Boolean(n.will_generate_revenue),
        n.event_completion_status || 'not_started',
        n.event_completion_date || null,
        n.event_completion_remarks || null,
        n.event_completed_by || null,
        n.event_completed_at || null
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
      const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const changerId = validUuid.test(log.changed_by) ? log.changed_by : (after.users[0]?.id || null);
      await client.query(`
        INSERT INTO audit_logs (id, entity_type, entity_id, department_id, old_amount, new_amount, difference, changed_by, role, reason, source, approval_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO NOTHING;
      `, [
        log.id, log.entity_type || 'nfa', String(log.entity_id || ''), String(log.department_id || 'ALL'),
        log.old_amount !== null && log.old_amount !== undefined ? Number(log.old_amount) : null,
        log.new_amount !== null && log.new_amount !== undefined ? Number(log.new_amount) : null,
        log.difference !== null && log.difference !== undefined ? Number(log.difference) : null,
        changerId, log.role || 'faculty', log.reason || '', log.source || 'portal',
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

  // 12. Event Revenues
  const beforeRevs = new Map((before.event_revenues || []).map((r) => [r.id, JSON.stringify(r)]));
  for (const rev of after.event_revenues || []) {
    const prev = beforeRevs.get(rev.id);
    if (!prev || prev !== JSON.stringify(rev)) {
      await client.query(`
        INSERT INTO event_revenues (
          id, nfa_id, department_id, revenue_source, description, amount,
          collection_date, payment_method, receipt_url, receipt_filename,
          remarks, submitted_by, submitted_by_name, status,
          verified_by, verified_by_name, verified_at, verification_remarks
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (id) DO UPDATE SET
          revenue_source = EXCLUDED.revenue_source,
          description = EXCLUDED.description,
          amount = EXCLUDED.amount,
          collection_date = EXCLUDED.collection_date,
          payment_method = EXCLUDED.payment_method,
          receipt_url = EXCLUDED.receipt_url,
          receipt_filename = EXCLUDED.receipt_filename,
          remarks = EXCLUDED.remarks,
          status = EXCLUDED.status,
          verified_by = EXCLUDED.verified_by,
          verified_by_name = EXCLUDED.verified_by_name,
          verified_at = EXCLUDED.verified_at,
          verification_remarks = EXCLUDED.verification_remarks,
          updated_at = NOW();
      `, [
        rev.id, rev.nfa_id, rev.department_id || null, rev.revenue_source, rev.description,
        Number(rev.amount), rev.collection_date, rev.payment_method || 'online',
        rev.receipt_url || null, rev.receipt_filename || null, rev.remarks || null,
        rev.submitted_by, rev.submitted_by_name || 'Faculty', rev.status || 'submitted',
        rev.verified_by || null, rev.verified_by_name || null, rev.verified_at || null,
        rev.verification_remarks || null
      ]);
    }
  }

  // Handle Event Revenue Deletions if any
  const afterRevIds = new Set((after.event_revenues || []).map((r) => r.id));
  for (const r of before.event_revenues || []) {
    if (!afterRevIds.has(r.id)) {
      await client.query('DELETE FROM event_revenues WHERE id = $1', [r.id]);
    }
  }

  // 13. Event Revenue Reminders
  const beforeReminders = new Set((before.event_revenue_reminders || []).map((rem) => rem.id));
  for (const rem of after.event_revenue_reminders || []) {
    if (!beforeReminders.has(rem.id)) {
      await client.query(`
        INSERT INTO event_revenue_reminders (id, nfa_id, sent_to, sent_to_email, sent_at, status, error_message)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO NOTHING;
      `, [
        rem.id, rem.nfa_id, rem.sent_to, rem.sent_to_email, rem.sent_at, rem.status || 'mock_delivered', rem.error_message || null
      ]);
    }
  }

  // 14. Security Audit Logs (Append-only)
  const beforeSecLogs = new Set((before.security_audit_logs || []).map((l) => l.id));
  for (const log of after.security_audit_logs || []) {
    if (!beforeSecLogs.has(log.id)) {
      try {
        await client.query(`
          INSERT INTO security_audit_logs (id, event_type, severity, user_id, user_role, ip_address, user_agent, resource, action, status, details, request_id, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (id) DO NOTHING;
        `, [
          log.id, log.event_type, log.severity, log.user_id || null, log.user_role || null,
          log.ip_address || null, log.user_agent || null, log.resource || null, log.action || null,
          log.status, JSON.stringify(log.details || {}), log.request_id || null, log.created_at
        ]);
      } catch {}
    }
  }

  // 15. Security Alerts
  const beforeSecAlerts = new Map((before.security_alerts || []).map((a) => [a.id, JSON.stringify(a)]));
  for (const alert of after.security_alerts || []) {
    const prev = beforeSecAlerts.get(alert.id);
    if (!prev || prev !== JSON.stringify(alert)) {
      try {
        await client.query(`
          INSERT INTO security_alerts (id, incident_ref, alert_type, severity, affected_component, description, action_taken, recommended_action, status, acknowledged_by, acknowledged_at, resolved_by, resolved_at, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            acknowledged_by = EXCLUDED.acknowledged_by,
            acknowledged_at = EXCLUDED.acknowledged_at,
            resolved_by = EXCLUDED.resolved_by,
            resolved_at = EXCLUDED.resolved_at,
            updated_at = EXCLUDED.updated_at;
        `, [
          alert.id, alert.incident_ref, alert.alert_type, alert.severity, alert.affected_component,
          alert.description, alert.action_taken, alert.recommended_action, alert.status,
          alert.acknowledged_by || null, alert.acknowledged_at || null, alert.resolved_by || null,
          alert.resolved_at || null, alert.created_at, alert.updated_at
        ]);
      } catch {}
    }
  }

  // 16. User MFA Settings
  const beforeMfa = new Map((before.user_mfa_settings || []).map((m) => [m.user_id, JSON.stringify(m)]));
  for (const mfa of after.user_mfa_settings || []) {
    const prev = beforeMfa.get(mfa.user_id);
    if (!prev || prev !== JSON.stringify(mfa)) {
      try {
        await client.query(`
          INSERT INTO user_mfa_settings (user_id, mfa_enabled, secret, recovery_codes, enrolled_at, last_verified_at, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (user_id) DO UPDATE SET
            mfa_enabled = EXCLUDED.mfa_enabled,
            secret = EXCLUDED.secret,
            recovery_codes = EXCLUDED.recovery_codes,
            enrolled_at = EXCLUDED.enrolled_at,
            last_verified_at = EXCLUDED.last_verified_at,
            updated_at = EXCLUDED.updated_at;
        `, [
          mfa.user_id, mfa.mfa_enabled, mfa.secret || null, mfa.recovery_codes || [],
          mfa.enrolled_at || null, mfa.last_verified_at || null, mfa.created_at, mfa.updated_at
        ]);
      } catch {}
    }
  }

  // 17. Emergency Mode State
  if (after.emergency_mode_state) {
    try {
      await client.query(`
        INSERT INTO emergency_mode_state (id, is_active, activated_by, activated_at, reason, restrictions, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          is_active = EXCLUDED.is_active,
          activated_by = EXCLUDED.activated_by,
          activated_at = EXCLUDED.activated_at,
          reason = EXCLUDED.reason,
          restrictions = EXCLUDED.restrictions,
          updated_at = EXCLUDED.updated_at;
      `, [
        'current_state', after.emergency_mode_state.is_active,
        after.emergency_mode_state.activated_by || null,
        after.emergency_mode_state.activated_at || null,
        after.emergency_mode_state.reason || 'Normal operation',
        JSON.stringify(after.emergency_mode_state.restrictions || {}),
        after.emergency_mode_state.updated_at || new Date().toISOString()
      ]);
    } catch {}
  }
}
