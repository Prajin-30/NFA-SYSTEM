import { Router, type Response } from 'express';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { store } from '../store.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import type { Role, Department, Nfa, DepartmentBudget, BudgetCategory } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logoPath = path.join(__dirname, '..', '..', 'public', 'christ-logo.png');

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const CHRIST_BLUE = '#003D8F';
const TEXT_DARK = '#1E293B';
const BORDER_LIGHT = '#CBD5E1';
const ROW_BG_ALT = '#F8FAFC';

/**
 * Validates whether user is authorized to view reports for a specific department or school
 */
export function checkReportScopeAuthorization(
  user: { id: string; role: Role; department_id: string | null; authorized_centre_ids?: string[]; name?: string },
  scope: 'campus' | 'school' | 'department' | 'centre',
  targetId?: string
): boolean {
  if (['super_admin', 'director', 'finance', 'finance_head'].includes(user.role)) {
    return true;
  }

  if (scope === 'campus') {
    return false; // Only university-wide officers can view full campus reports
  }

  if (['dean', 'associate_dean', 'deans_office'].includes(user.role)) {
    if (scope === 'school') return true;
    if (scope === 'department' && targetId) {
      const dept = store.data.departments.find((d) => d.id === targetId);
      return Boolean(dept?.school_id); // Deans can view any department in their school
    }
    if (scope === 'centre') return true;
    return false;
  }

  if (user.role === 'hod') {
    if (scope === 'department') return user.department_id === targetId;
    return false;
  }

  if (user.role === 'faculty') {
    if (scope === 'department') return user.department_id === targetId;
    if (scope === 'centre') return Boolean(targetId && user.authorized_centre_ids?.includes(targetId));
    return false;
  }

  return false;
}

/**
 * Helper to compute summary metrics for a list of departments
 */
function computeDepartmentMetrics(deptIds: string[]) {
  const db = store.data;
  const deptSet = new Set(deptIds);

  const budgets = db.department_budgets.filter((b) => deptSet.has(b.department_id));
  const nfas = db.nfas.filter((n) => deptSet.has(n.department_id) || (n.centre_id && deptSet.has(n.centre_id)));
  const revenues = (db.event_revenues || []).filter((r) => r.department_id && deptSet.has(r.department_id));
  const invoices = (db.purchase_invoices || []).filter((i) => {
    const nfa = db.nfas.find((n) => n.id === i.nfa_id);
    return nfa && (deptSet.has(nfa.department_id) || (nfa.centre_id && deptSet.has(nfa.centre_id)));
  });

  const allocated = budgets.reduce((sum, b) => sum + (Number(b.allocated_amount) || 0), 0);
  const approved = budgets.reduce((sum, b) => sum + (Number(b.approved_amount) || 0), 0);
  const pending = budgets.reduce((sum, b) => sum + (Number(b.pending_amount) || 0), 0);
  const available = allocated - approved - pending;

  const totalRevenue = revenues.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const verifiedRevenue = revenues.filter((r) => r.status === 'verified').reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  const invoicesPaid = invoices.filter((i) => i.payment_status === 'paid').reduce((sum, i) => sum + (Number(i.invoice_amount) || 0), 0);
  const invoicesPending = invoices.filter((i) => i.payment_status !== 'paid').reduce((sum, i) => sum + (Number(i.invoice_amount) || 0), 0);

  return {
    allocated,
    approved,
    pending,
    available,
    total_revenue: totalRevenue,
    verified_revenue: verifiedRevenue,
    invoices_paid: invoicesPaid,
    invoices_pending: invoicesPending,
    total_nfas: nfas.length,
    approved_nfas: nfas.filter((n) => n.status === 'approved').length,
    pending_nfas: nfas.filter((n) => !['approved', 'rejected', 'draft'].includes(n.status)).length,
    rejected_nfas: nfas.filter((n) => n.status === 'rejected').length,
  };
}

// ==========================================
// 1. SUMMARY GENERATION ENDPOINTS
// ==========================================

/**
 * GET /api/reports/summary/campus
 */
reportsRouter.get('/summary/campus', (req: AuthedRequest, res) => {
  if (!checkReportScopeAuthorization(req.user!, 'campus')) {
    return res.status(403).json({ error: 'Forbidden: Campus summary requires institutional executive role' });
  }

  const allDepts = store.data.departments;
  const academicDepts = allDepts.filter((d) => d.category !== 'coe' && !d.code.startsWith('COE-'));
  const centreDepts = allDepts.filter((d) => d.category === 'coe' || d.code.startsWith('COE-'));

  const overallMetrics = computeDepartmentMetrics(allDepts.map((d) => d.id));
  const academicMetrics = computeDepartmentMetrics(academicDepts.map((d) => d.id));
  const centreMetrics = computeDepartmentMetrics(centreDepts.map((d) => d.id));

  const schools = (store.data.schools || []).map((s) => {
    const sDepts = allDepts.filter((d) => d.school_id === s.id);
    return {
      ...s,
      departments_count: sDepts.length,
      metrics: computeDepartmentMetrics(sDepts.map((d) => d.id)),
    };
  });

  res.json({
    scope: 'campus',
    title: 'CHRIST University Campus Financial & Operational Summary',
    generated_at: new Date().toISOString(),
    metrics: overallMetrics,
    breakdown: {
      academic: academicMetrics,
      centres_offices: centreMetrics,
    },
    schools,
  });
});

/**
 * GET /api/reports/summary/school/:id
 */
reportsRouter.get('/summary/school/:id', (req: AuthedRequest, res) => {
  const { id } = req.params;
  const school = store.data.schools?.find((s) => s.id === id || s.code === id.toUpperCase());
  if (!school) {
    return res.status(404).json({ error: 'School not found' });
  }

  if (!checkReportScopeAuthorization(req.user!, 'school', school.id)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to view this school summary' });
  }

  const depts = store.data.departments.filter((d) => d.school_id === school.id);
  const metrics = computeDepartmentMetrics(depts.map((d) => d.id));

  const departmentBreakdown = depts.map((d) => ({
    id: d.id,
    name: d.name,
    code: d.code,
    metrics: computeDepartmentMetrics([d.id]),
  }));

  res.json({
    scope: 'school',
    school,
    metrics,
    departments: departmentBreakdown,
  });
});

/**
 * GET /api/reports/summary/department/:id
 */
reportsRouter.get('/summary/department/:id', (req: AuthedRequest, res) => {
  const { id } = req.params;
  const dept = store.data.departments.find((d) => d.id === id || d.code.toUpperCase() === id.toUpperCase());
  if (!dept) {
    return res.status(404).json({ error: 'Department not found' });
  }

  if (!checkReportScopeAuthorization(req.user!, 'department', dept.id)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to view this department summary' });
  }

  const metrics = computeDepartmentMetrics([dept.id]);
  const budgets = store.data.department_budgets.filter((b) => b.department_id === dept.id);
  const catMap = new Map(store.data.budget_categories.map((c) => [c.id, c.name]));

  const categories = budgets.map((b) => ({
    category_id: b.budget_category_id,
    category_name: catMap.get(b.budget_category_id) || 'Category',
    allocated: Number(b.allocated_amount) || 0,
    approved: Number(b.approved_amount) || 0,
    pending: Number(b.pending_amount) || 0,
    available: Number(b.allocated_amount) - Number(b.approved_amount) - Number(b.pending_amount),
  }));

  res.json({
    scope: 'department',
    department: dept,
    metrics,
    categories,
  });
});

/**
 * GET /api/reports/summary/centre/:id
 */
reportsRouter.get('/summary/centre/:id', (req: AuthedRequest, res) => {
  const { id } = req.params;
  const centre = store.data.departments.find(
    (d) => (d.category === 'coe' || d.code.startsWith('COE-')) && (d.id === id || d.code.toUpperCase() === id.toUpperCase())
  );
  if (!centre) {
    return res.status(404).json({ error: 'Centre / Office not found' });
  }

  if (!checkReportScopeAuthorization(req.user!, 'centre', centre.id)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to view this Centre / Office summary' });
  }

  const metrics = computeDepartmentMetrics([centre.id]);

  res.json({
    scope: 'centre',
    centre,
    metrics,
  });
});

// ==========================================
// 2. REPORT DATA ENGINE (14 REPORT TYPES)
// ==========================================

export function getReportDataset(reportType: string, user: { id: string; role: Role; department_id: string | null; authorized_centre_ids?: string[]; name?: string }, filters: any = {}) {
  const db = store.data;
  const deptMap = new Map(db.departments.map((d) => [d.id, d]));
  const catMap = new Map(db.budget_categories.map((c) => [c.id, c.name]));
  const userMap = new Map(db.users.map((u) => [u.id, u.name]));

  // Base scope filters for NFAs
  const isSenior = ['super_admin', 'director', 'finance', 'finance_head'].includes(user.role);
  const isDean = ['dean', 'associate_dean', 'deans_office'].includes(user.role);

  function nfaInScope(n: Nfa): boolean {
    if (isSenior) return true;
    if (isDean) {
      const dept = deptMap.get(n.department_id);
      return Boolean(dept?.school_id) || Boolean(n.centre_id);
    }
    if (user.role === 'hod') return n.department_id === user.department_id;
    if (n.centre_id && user.authorized_centre_ids?.includes(n.centre_id)) return true;
    return n.created_by === user.id;
  }

  switch (reportType) {
    case 'nfa_activity': {
      const list = db.nfas.filter(nfaInScope);
      return list.map((n, idx) => ({
        sl_no: idx + 1,
        ref_no: n.ref_no,
        date: n.date,
        title: n.title,
        department: deptMap.get(n.department_id)?.name || '',
        category: catMap.get(n.budget_category_id) || '',
        proposer: n.submitted_by_name || userMap.get(n.created_by) || 'Faculty',
        amount: Number(n.total_amount) || 0,
        status: n.status,
        type: n.nfa_type || 'event',
      }));
    }

    case 'department_budget': {
      let depts = db.departments;
      if (!isSenior && !isDean) {
        depts = depts.filter((d) => d.id === user.department_id);
      }
      const rows: any[] = [];
      let sl = 1;
      depts.forEach((d) => {
        const budgets = db.department_budgets.filter((b) => b.department_id === d.id);
        budgets.forEach((b) => {
          const alloc = Number(b.allocated_amount) || 0;
          const app = Number(b.approved_amount) || 0;
          const pend = Number(b.pending_amount) || 0;
          rows.push({
            sl_no: sl++,
            department_code: d.code,
            department_name: d.name,
            category: catMap.get(b.budget_category_id) || 'Category',
            allocated: alloc,
            approved: app,
            pending: pend,
            available: alloc - app - pend,
            utilization: alloc > 0 ? `${Math.round(((app + pend) / alloc) * 100)}%` : '0%',
          });
        });
      });
      return rows;
    }

    case 'school_budget': {
      const rows: any[] = [];
      let sl = 1;
      (db.schools || []).forEach((s) => {
        const sDepts = db.departments.filter((d) => d.school_id === s.id);
        const m = computeDepartmentMetrics(sDepts.map((d) => d.id));
        rows.push({
          sl_no: sl++,
          school_code: s.code,
          school_name: s.name,
          campus: s.campus,
          departments_count: sDepts.length,
          allocated: m.allocated,
          approved: m.approved,
          pending: m.pending,
          available: m.available,
          revenue_generated: m.total_revenue,
        });
      });
      return rows;
    }

    case 'campus_budget': {
      const overall = computeDepartmentMetrics(db.departments.map((d) => d.id));
      const academic = computeDepartmentMetrics(db.departments.filter((d) => d.category !== 'coe').map((d) => d.id));
      const coe = computeDepartmentMetrics(db.departments.filter((d) => d.category === 'coe').map((d) => d.id));
      return [
        { sl_no: 1, segment: 'Academic Schools & Departments', ...academic },
        { sl_no: 2, segment: 'Centres / Offices of Excellence', ...coe },
        { sl_no: 3, segment: 'TOTAL INSTITUTIONAL CAMPUS BUDGET', ...overall },
      ];
    }

    case 'capex': {
      const capexCat = db.budget_categories.filter((c) => {
        const bt = db.budget_types.find((t) => t.id === c.budget_type_id);
        return bt?.name.toLowerCase().includes('capex') || bt?.name.toLowerCase().includes('capital');
      });
      const capexCatIds = new Set(capexCat.map((c) => c.id));
      const capexNfas = db.nfas.filter((n) => capexCatIds.has(n.budget_category_id) && nfaInScope(n));
      return capexNfas.map((n, idx) => ({
        sl_no: idx + 1,
        ref_no: n.ref_no,
        date: n.date,
        department: deptMap.get(n.department_id)?.name || '',
        item_title: n.title,
        amount: Number(n.total_amount) || 0,
        status: n.status,
        vendor: (n.quotations && n.quotations[0]?.vendor_name) || 'Not Finalized',
      }));
    }

    case 'revenue_earnings': {
      const revs = (db.event_revenues || []).filter((r) => {
        const nfa = db.nfas.find((n) => n.id === r.nfa_id);
        return nfa && nfaInScope(nfa);
      });
      return revs.map((r, idx) => {
        const nfa = db.nfas.find((n) => n.id === r.nfa_id);
        return {
          sl_no: idx + 1,
          date: r.collection_date,
          nfa_ref: nfa?.ref_no || '',
          event_title: nfa?.title || '',
          department: r.department_id ? deptMap.get(r.department_id)?.code : '',
          source: r.revenue_source.replace(/_/g, ' ').toUpperCase(),
          description: r.description,
          amount: Number(r.amount) || 0,
          payment_method: r.payment_method || 'Online',
          status: r.status.toUpperCase(),
          verified_by: r.verified_by_name || '—',
        };
      });
    }

    case 'event_activity': {
      const events = db.nfas.filter((n) => n.nfa_type === 'event' && nfaInScope(n));
      return events.map((n, idx) => ({
        sl_no: idx + 1,
        ref_no: n.ref_no,
        date: n.date,
        event_title: n.title,
        department: deptMap.get(n.department_id)?.code || '',
        resource_person: n.event_details?.resource_person_name || '—',
        venue: n.event_details?.venue || 'Campus',
        amount: Number(n.total_amount) || 0,
        status: n.status,
        completion: (n.event_completion_status || 'not_started').toUpperCase(),
        revenue_enabled: n.will_generate_revenue ? 'YES' : 'NO',
      }));
    }

    case 'purchase_activity': {
      const purchases = db.nfas.filter((n) => (n.nfa_type === 'purchase' || n.purchase_details) && nfaInScope(n));
      return purchases.map((n, idx) => ({
        sl_no: idx + 1,
        ref_no: n.ref_no,
        date: n.date,
        item_title: n.title,
        department: deptMap.get(n.department_id)?.code || '',
        amount: Number(n.total_amount) || 0,
        status: n.status,
        quotations_count: n.quotations?.length || 0,
        vendor: (n.quotations && n.quotations[0]?.vendor_name) || '—',
      }));
    }

    case 'purchase_invoice': {
      const invoices = (db.purchase_invoices || []).filter((i) => {
        const nfa = db.nfas.find((n) => n.id === i.nfa_id);
        return nfa && nfaInScope(nfa);
      });
      return invoices.map((i, idx) => {
        const nfa = db.nfas.find((n) => n.id === i.nfa_id);
        return {
          sl_no: idx + 1,
          invoice_no: i.invoice_number,
          invoice_date: i.invoice_date,
          nfa_ref: nfa?.ref_no || '',
          vendor: i.vendor_name,
          invoice_amount: Number(i.invoice_amount) || 0,
          gst_amount: Number(i.gst_amount) || 0,
          verification: i.verification_status.toUpperCase(),
          payment_status: i.payment_status.toUpperCase(),
          paid_amount: Number(i.paid_amount) || 0,
        };
      });
    }

    case 'payment_status': {
      const rows: any[] = [];
      let sl = 1;
      // Invoices
      (db.purchase_invoices || []).forEach((i) => {
        const nfa = db.nfas.find((n) => n.id === i.nfa_id);
        if (nfa && nfaInScope(nfa)) {
          rows.push({
            sl_no: sl++,
            type: 'Purchase Invoice',
            ref_no: i.invoice_number,
            nfa_ref: nfa.ref_no,
            beneficiary: i.vendor_name,
            amount: Number(i.invoice_amount) || 0,
            status: i.payment_status.toUpperCase(),
            utr_ref: i.payment_ref_utr || '—',
            payment_date: i.payment_date || '—',
          });
        }
      });
      // Resource Persons
      (db.resource_person_bank_details || []).forEach((b) => {
        const nfa = db.nfas.find((n) => n.id === b.nfa_id);
        if (nfa && nfaInScope(nfa)) {
          rows.push({
            sl_no: sl++,
            type: 'Honorarium Payment',
            ref_no: b.resource_person_name,
            nfa_ref: nfa.ref_no,
            beneficiary: b.account_holder_name || b.resource_person_name,
            amount: Number(b.net_payable_amount || b.honorarium_amount) || 0,
            status: (b.tracking_status || 'details_submitted').toUpperCase(),
            utr_ref: b.payment_ref_utr || '—',
            payment_date: b.payment_date || '—',
          });
        }
      });
      return rows;
    }

    case 'financial_ledger': {
      const logs = db.audit_logs.filter((l) => {
        if (isSenior) return true;
        if (isDean) return true;
        if (user.role === 'hod') return l.department_id === user.department_id;
        return l.changed_by === user.name;
      });
      return logs.slice(0, 200).map((l, idx) => ({
        sl_no: idx + 1,
        timestamp: l.created_at,
        entity: l.entity_type.toUpperCase(),
        department: l.department_id,
        user: l.changed_by,
        role: l.role.toUpperCase(),
        action: l.approval_status,
        reason: l.reason,
        amount: l.new_amount !== null ? `₹${Number(l.new_amount).toLocaleString('en-IN')}` : '—',
      }));
    }

    case 'faculty_nfa': {
      const facultyList = db.users.filter((u) => u.role === 'faculty');
      const filteredFaculty = isSenior || isDean
        ? facultyList
        : facultyList.filter((f) => f.department_id === user.department_id);

      return filteredFaculty.map((f, idx) => {
        const fNfas = db.nfas.filter((n) => n.created_by === f.id);
        const approved = fNfas.filter((n) => n.status === 'approved');
        const requestedAmt = fNfas.reduce((sum, n) => sum + (Number(n.total_amount) || 0), 0);
        const approvedAmt = approved.reduce((sum, n) => sum + (Number(n.total_amount) || 0), 0);
        return {
          sl_no: idx + 1,
          faculty_name: f.name,
          email: f.email,
          department: f.department_id ? deptMap.get(f.department_id)?.code : '',
          total_submitted: fNfas.length,
          total_approved: approved.length,
          total_requested: requestedAmt,
          total_approved_amount: approvedAmt,
        };
      });
    }

    case 'centres_offices': {
      const coes = db.departments.filter((d) => d.category === 'coe' || d.code.startsWith('COE-'));
      return coes.map((c, idx) => {
        const m = computeDepartmentMetrics([c.id]);
        return {
          sl_no: idx + 1,
          centre_code: c.code,
          centre_name: c.name,
          allocated: m.allocated,
          approved: m.approved,
          pending: m.pending,
          available: m.available,
          nfas_count: m.total_nfas,
          revenue_generated: m.total_revenue,
        };
      });
    }

    case 'pending_approvals': {
      const inFlight = db.nfas.filter(
        (n) => !['draft', 'approved', 'rejected'].includes(n.status) && nfaInScope(n)
      );
      return inFlight.map((n, idx) => {
        const createdDate = new Date(n.created_at || n.date);
        const daysPending = Math.max(0, Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));
        return {
          sl_no: idx + 1,
          ref_no: n.ref_no,
          date: n.date,
          title: n.title,
          department: deptMap.get(n.department_id)?.code || '',
          amount: Number(n.total_amount) || 0,
          current_stage: n.status.replace(/_/g, ' ').toUpperCase(),
          days_in_review: daysPending,
          submitted_by: n.submitted_by_name || 'Faculty',
        };
      });
    }

    default:
      return [];
  }
}

/**
 * GET /api/reports/data/:reportType
 * Returns structured data for the table preview
 */
reportsRouter.get('/data/:reportType', (req: AuthedRequest, res) => {
  const { reportType } = req.params;
  const data = getReportDataset(reportType, req.user!);
  res.json({
    report_type: reportType,
    total_records: data.length,
    data,
  });
});

/**
 * POST /api/reports/export/:reportType/pdf
 * Official CHRIST University Report PDF Generation
 */
reportsRouter.post('/export/:reportType/pdf', (req: AuthedRequest, res: Response) => {
  const { reportType } = req.params;
  const user = req.user!;
  const data = getReportDataset(reportType, user, req.body);

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 36, bottom: 36, left: 36, right: 36 },
    bufferPages: true,
  });

  const filename = `CU_Report_${reportType}_${Date.now()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  doc.pipe(res);

  // Render Official CHRIST University Header
  const topY = 36;
  if (fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 36, topY, { fit: [60, 60] });
    } catch {}
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(CHRIST_BLUE)
    .text('CHRIST (Deemed to be University)', 110, topY + 2);

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(TEXT_DARK)
    .text('Bangalore Kengeri Campus | Note for Approval & Budget Management System', 110, topY + 22)
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor(CHRIST_BLUE)
    .text(`OFFICIAL INSTITUTIONAL REPORT: ${reportType.replace(/_/g, ' ').toUpperCase()}`, 110, topY + 36);

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#64748B')
    .text(`Generated By: ${user.name} (${user.role.toUpperCase()}) | Date: ${new Date().toLocaleString()}`, 36, topY + 68);

  doc.moveTo(36, topY + 80).lineTo(806, topY + 80).strokeColor(CHRIST_BLUE).lineWidth(1.5).stroke();

  // Table rendering
  let curY = topY + 92;
  if (data.length === 0) {
    doc.font('Helvetica').fontSize(11).fillColor(TEXT_DARK).text('No records found for the requested criteria.', 36, curY);
  } else {
    const keys = Object.keys(data[0]);
    const colCount = keys.length;
    const tableWidth = 770;
    const colWidth = Math.floor(tableWidth / colCount);

    // Header
    doc.rect(36, curY, tableWidth, 20).fillColor(CHRIST_BLUE).fill();
    let colX = 36;
    keys.forEach((k) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor('#FFFFFF')
        .text(k.replace(/_/g, ' ').toUpperCase(), colX + 4, curY + 6, {
          width: colWidth - 8,
          align: 'left',
          ellipsis: true,
        });
      colX += colWidth;
    });

    curY += 20;

    // Rows
    data.slice(0, 150).forEach((row: any, rIdx) => {
      if (curY > 520) {
        doc.addPage();
        curY = 40;
      }

      if (rIdx % 2 === 1) {
        doc.rect(36, curY, tableWidth, 18).fillColor(ROW_BG_ALT).fill();
      }

      colX = 36;
      keys.forEach((k) => {
        let val = row[k];
        if (typeof val === 'number') {
          val = val.toLocaleString('en-IN');
        }
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(TEXT_DARK)
          .text(String(val ?? '—'), colX + 4, curY + 5, {
            width: colWidth - 8,
            align: 'left',
            ellipsis: true,
          });
        colX += colWidth;
      });

      doc.moveTo(36, curY + 18).lineTo(806, curY + 18).strokeColor(BORDER_LIGHT).lineWidth(0.5).stroke();
      curY += 18;
    });
  }

  // Footer on all pages
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i++) {
    doc.switchToPage(i);
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor('#94A3B8')
      .text(
        `CHRIST (Deemed to be University) — Institutional Confidential Document | Page ${i + 1} of ${pageRange.count}`,
        36,
        560,
        { align: 'center', width: 770 }
      );
  }

  doc.end();
});

/**
 * POST /api/reports/export/:reportType/excel
 * Excel Workbook Generation using ExcelJS
 */
reportsRouter.post('/export/:reportType/excel', async (req: AuthedRequest, res: Response) => {
  const { reportType } = req.params;
  const user = req.user!;
  const data = getReportDataset(reportType, user, req.body);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CHRIST (Deemed to be University) NFA System';
  wb.created = new Date();

  const ws = wb.addWorksheet(reportType.replace(/_/g, ' ').slice(0, 30));

  if (data.length > 0) {
    const keys = Object.keys(data[0]);
    ws.columns = keys.map((k) => ({
      header: k.replace(/_/g, ' ').toUpperCase(),
      key: k,
      width: Math.max(16, k.length + 6),
    }));

    // Header styling
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF003D8F' }, // Official CHRIST Blue
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    data.forEach((row: any) => {
      ws.addRow(row);
    });

    // Alternate row styling
    ws.eachRow((r, rowNumber) => {
      if (rowNumber > 1 && rowNumber % 2 === 0) {
        r.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8FAFC' },
        };
      }
    });
  }

  const filename = `CU_Report_${reportType}_${Date.now()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
});
