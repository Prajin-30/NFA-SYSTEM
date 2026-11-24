import { Router, type Response } from 'express';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { store } from '../store.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import type { Role, Department, Nfa, DepartmentBudget, BudgetCategory } from '../types.js';
import { registerUnicodeFonts, formatPdfCurrency, type RegisteredPdfFonts } from '../lib/fontResolver.js';

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

export interface ScopeResolution {
  scope: 'campus' | 'school' | 'department' | 'centre';
  targetDeptIds: Set<string>;
  financialYear: { id: string; label: string; is_active?: boolean };
  isSpecificFilter: boolean;
  selectedSchool?: { id: string; code: string; name: string };
  selectedDept?: Department;
  selectedCentre?: Department;
  includeAllFaculty: boolean;
}

/**
 * Resolves authorized organization scope and academic year based on user role and request filters.
 * Guarantees strict isolation: selecting Automation will NOT include ARDC or E-Mobility;
 * selecting a department will NOT include other departments' records or faculty.
 */
export function resolveAuthorizedScope(
  user: { id: string; role: Role; department_id: string | null; authorized_centre_ids?: string[]; name?: string },
  filters: any = {}
): ScopeResolution {
  const db = store.data;
  const isSenior = ['super_admin', 'director', 'finance', 'finance_head'].includes(user.role);
  const isDean = ['dean', 'associate_dean', 'deans_office'].includes(user.role);

  // 1. Resolve Financial Year
  const requestedFyId = filters.financial_year_id || filters.fy_id;
  const activeFy = (db.financial_years || []).find((f) => f.id === requestedFyId)
    || (db.financial_years || []).find((f) => f.is_active)
    || (db.financial_years && db.financial_years[0])
    || { id: 'default-fy', label: '2026-27', is_active: true };

  const includeAllFaculty = filters.include_all_faculty === true || filters.include_all_faculty === 'true' || filters.include_all_faculty === '1';

  // 2. Identify requested parameters
  const requestedTargetId = filters.id || filters.targetId;
  const requestedDeptId = filters.department_id || filters.dept_id || (filters.scope === 'department' ? requestedTargetId : undefined);
  const requestedCentreId = filters.centre_id || filters.centre || (filters.scope === 'centre' ? requestedTargetId : undefined);
  const requestedSchoolId = filters.school_id || filters.school || (filters.scope === 'school' ? requestedTargetId : undefined);
  const requestedScope = filters.scope as ('campus' | 'school' | 'department' | 'centre' | undefined);

  // 3. Department-level filter
  if (requestedDeptId) {
    const dept = db.departments.find((d) => d.id === requestedDeptId || d.code.toUpperCase() === String(requestedDeptId).toUpperCase());
    if (dept) {
      const isCoe = dept.category === 'coe' || dept.code.startsWith('COE-');
      // Authorization check
      if (isSenior || isDean || (user.role === 'hod' && user.department_id === dept.id) || (user.role === 'faculty' && user.department_id === dept.id)) {
        return {
          scope: isCoe ? 'centre' : 'department',
          targetDeptIds: new Set([dept.id]),
          financialYear: activeFy,
          isSpecificFilter: true,
          selectedDept: !isCoe ? dept : undefined,
          selectedCentre: isCoe ? dept : undefined,
          includeAllFaculty,
        };
      }
    }
  }

  // 4. Centre-level filter
  if (requestedCentreId) {
    const centre = db.departments.find(
      (d) => (d.category === 'coe' || d.code.startsWith('COE-')) && (d.id === requestedCentreId || d.code.toUpperCase() === String(requestedCentreId).toUpperCase())
    );
    if (centre) {
      if (isSenior || isDean || (user.authorized_centre_ids && user.authorized_centre_ids.includes(centre.id))) {
        return {
          scope: 'centre',
          targetDeptIds: new Set([centre.id]),
          financialYear: activeFy,
          isSpecificFilter: true,
          selectedCentre: centre,
          includeAllFaculty,
        };
      }
    }
  }

  // 5. School-level filter
  if (requestedSchoolId || requestedScope === 'school') {
    const legacySchoolCodeMap: Record<string, string> = {
      '11111111-0000-0000-0000-000000000001': 'SOET',
      '11111111-0000-0000-0000-000000000002': 'SOA',
      '11111111-0000-0000-0000-000000000003': 'SBM',
      '11111111-0000-0000-0000-000000000004': 'SPS',
    };
    const targetSchoolId = requestedSchoolId || 'SOET';
    const mappedCode = legacySchoolCodeMap[String(targetSchoolId)] || String(targetSchoolId).toUpperCase();
    const school = (db.schools || []).find((s) => s.id === targetSchoolId || s.code.toUpperCase() === String(targetSchoolId).toUpperCase() || s.code.toUpperCase() === mappedCode)
      || (requestedSchoolId ? { id: requestedSchoolId, code: mappedCode, name: `School (${mappedCode})`, campus: 'Bengaluru Central Campus' } : (db.schools && db.schools[0]));
    if (school && (isSenior || isDean)) {
      const schoolDepts = db.departments.filter((d) => d.school_id === school.id || (!d.school_id && school.code === 'SOET' && d.category === 'academic'));
      return {
        scope: 'school',
        targetDeptIds: new Set(schoolDepts.map((d) => d.id)),
        financialYear: activeFy,
        isSpecificFilter: true,
        selectedSchool: school,
        includeAllFaculty,
      };
    }
  }

  // 5b. Fallback: Check if requestedTargetId matches a department, centre or school directly
  if (requestedTargetId) {
    const dept = db.departments.find((d) => d.id === requestedTargetId || d.code.toUpperCase() === String(requestedTargetId).toUpperCase());
    if (dept) {
      const isCoe = dept.category === 'coe' || dept.code.startsWith('COE-');
      if (isSenior || isDean || (user.role === 'hod' && user.department_id === dept.id) || (user.role === 'faculty' && user.department_id === dept.id)) {
        return {
          scope: isCoe ? 'centre' : 'department',
          targetDeptIds: new Set([dept.id]),
          financialYear: activeFy,
          isSpecificFilter: true,
          selectedDept: !isCoe ? dept : undefined,
          selectedCentre: isCoe ? dept : undefined,
          includeAllFaculty,
        };
      }
    }

    const legacySchoolCodeMap: Record<string, string> = {
      '11111111-0000-0000-0000-000000000001': 'SOET',
      '11111111-0000-0000-0000-000000000002': 'SOA',
      '11111111-0000-0000-0000-000000000003': 'SBM',
      '11111111-0000-0000-0000-000000000004': 'SPS',
    };
    const mappedCode = legacySchoolCodeMap[String(requestedTargetId)] || String(requestedTargetId).toUpperCase();
    const school = (db.schools || []).find((s) => s.id === requestedTargetId || s.code.toUpperCase() === String(requestedTargetId).toUpperCase() || s.code.toUpperCase() === mappedCode);
    if (school && (isSenior || isDean)) {
      const schoolDepts = db.departments.filter((d) => d.school_id === school.id || (!d.school_id && school.code === 'SOET' && d.category === 'academic'));
      return {
        scope: 'school',
        targetDeptIds: new Set(schoolDepts.map((d) => d.id)),
        financialYear: activeFy,
        isSpecificFilter: true,
        selectedSchool: school,
        includeAllFaculty,
      };
    }
  }

  // 6. Centre scope (all centres)
  if (requestedScope === 'centre') {
    const centres = db.departments.filter((d) => d.category === 'coe' || d.code.startsWith('COE-'));
    let allowedCentres = centres;
    if (!isSenior && !isDean) {
      allowedCentres = centres.filter((c) => user.authorized_centre_ids?.includes(c.id));
    }
    return {
      scope: 'centre',
      targetDeptIds: new Set(allowedCentres.map((c) => c.id)),
      financialYear: activeFy,
      isSpecificFilter: false,
      includeAllFaculty,
    };
  }

  // 7. Role-based fallback scope
  if (user.role === 'hod' && user.department_id) {
    const dept = db.departments.find((d) => d.id === user.department_id);
    return {
      scope: 'department',
      targetDeptIds: new Set([user.department_id]),
      financialYear: activeFy,
      isSpecificFilter: true,
      selectedDept: dept,
      includeAllFaculty,
    };
  }

  if (user.role === 'faculty') {
    const targetIds: string[] = [];
    if (user.department_id) targetIds.push(user.department_id);
    if (user.authorized_centre_ids) targetIds.push(...user.authorized_centre_ids);
    const dept = user.department_id ? db.departments.find((d) => d.id === user.department_id) : undefined;
    return {
      scope: 'department',
      targetDeptIds: new Set(targetIds),
      financialYear: activeFy,
      isSpecificFilter: true,
      selectedDept: dept,
      includeAllFaculty,
    };
  }

  if (isDean) {
    const school = (db.schools && db.schools[0]) || { id: 'soet', code: 'SOET', name: 'School of Engineering and Technology' };
    const schoolDepts = db.departments.filter((d) => d.school_id === school.id || (!d.school_id && d.category === 'academic'));
    return {
      scope: 'school',
      targetDeptIds: new Set(schoolDepts.map((d) => d.id)),
      financialYear: activeFy,
      isSpecificFilter: false,
      selectedSchool: school,
      includeAllFaculty,
    };
  }

  // Senior Admin Campus Scope
  return {
    scope: 'campus',
    targetDeptIds: new Set(db.departments.map((d) => d.id)),
    financialYear: activeFy,
    isSpecificFilter: false,
    includeAllFaculty,
  };
}

/**
 * Computes financial and operational summary metrics for a list of department IDs within a financial year
 */
export function computeDepartmentMetrics(deptIds: string[], fyId?: string) {
  const db = store.data;
  const deptSet = new Set(deptIds);

  const nfaMap = new Map<string, (typeof db.nfas)[0]>();
  for (const n of db.nfas) {
    nfaMap.set(n.id, n);
  }

  const budgets = db.department_budgets.filter(
    (b) => deptSet.has(b.department_id) && (!fyId || b.financial_year_id === fyId)
  );

  const nfas = db.nfas.filter(
    (n) => (deptSet.has(n.department_id) || (n.centre_id && deptSet.has(n.centre_id))) && (!fyId || n.financial_year_id === fyId)
  );

  const revenues = (db.event_revenues || []).filter((r) => {
    const parentNfa = r.nfa_id ? nfaMap.get(r.nfa_id) : undefined;
    const deptId = r.department_id || parentNfa?.department_id || parentNfa?.centre_id;
    if (!deptId || !deptSet.has(deptId)) return false;
    if (fyId && parentNfa && parentNfa.financial_year_id !== fyId) return false;
    return true;
  });

  const invoices = (db.purchase_invoices || []).filter((i) => {
    const nfa = nfaMap.get(i.nfa_id);
    if (!nfa) return false;
    if (fyId && nfa.financial_year_id !== fyId) return false;
    return deptSet.has(nfa.department_id) || (nfa.centre_id && deptSet.has(nfa.centre_id));
  });

  const allocated = budgets.reduce((sum, b) => sum + (Number(b.allocated_amount) || 0), 0);
  const approved = budgets.reduce((sum, b) => sum + (Number(b.approved_amount) || 0), 0);
  const pending = budgets.reduce((sum, b) => sum + (Number(b.pending_amount) || 0), 0);
  const available = allocated - approved - pending;

  const totalRevenue = revenues.filter((r) => r.status !== 'returned').reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const verifiedRevenue = revenues.filter((r) => r.status === 'verified').reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const pendingRevenue = revenues.filter((r) => r.status === 'submitted').reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const returnedRevenue = revenues.filter((r) => r.status === 'returned').reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  const invoicesPaid = invoices.filter((i) => i.payment_status === 'paid').reduce((sum, i) => sum + (Number(i.invoice_amount) || 0), 0);
  const invoicesPending = invoices.filter((i) => i.payment_status !== 'paid').reduce((sum, i) => sum + (Number(i.invoice_amount) || 0), 0);

  const submittedNfas = nfas.filter((n) => n.status !== 'draft');
  const eventNfas = submittedNfas.filter((n) => n.nfa_type === 'event');
  const purchaseNfas = submittedNfas.filter((n) => n.nfa_type === 'purchase');
  const completedEvents = eventNfas.filter((n) => n.event_completion_status === 'completed');

  return {
    allocated,
    approved,
    pending,
    available,
    total_revenue: totalRevenue,
    verified_revenue: verifiedRevenue,
    pending_revenue: pendingRevenue,
    returned_revenue: returnedRevenue,
    invoices_paid: invoicesPaid,
    invoices_pending: invoicesPending,
    total_nfas: submittedNfas.length,
    approved_nfas: submittedNfas.filter((n) => n.status === 'approved').length,
    pending_nfas: submittedNfas.filter((n) => !['approved', 'rejected', 'draft'].includes(n.status)).length,
    rejected_nfas: submittedNfas.filter((n) => n.status === 'rejected').length,
    event_nfas_count: eventNfas.length,
    purchase_nfas_count: purchaseNfas.length,
    events_completed_count: completedEvents.length,
  };
}

/**
 * Builds the complete 3-section executive summary payload:
 * Section 1: Executive KPI Overview (Expenditures, Commitments, Revenues, Invoices, NFAs)
 * Section 2: Faculty-wise NFA Activity Table (with optional zero-activity filtering)
 * Section 3: Detailed NFA Activity Table
 */
export function getExecutiveSummaryData(
  user: { id: string; role: Role; department_id: string | null; authorized_centre_ids?: string[]; name?: string },
  filters: any = {}
) {
  const db = store.data;
  const resolution = resolveAuthorizedScope(user, filters);
  const targetDeptIds = resolution.targetDeptIds;
  const fyId = resolution.financialYear.id;
  const fyLabel = resolution.financialYear.label;

  const deptMap = new Map(db.departments.map((d) => [d.id, d]));
  const catMap = new Map(db.budget_categories.map((c) => [c.id, c.name]));
  const userMap = new Map(db.users.map((u) => [u.id, u.name]));

  // 1. Executive Metrics
  const metrics = computeDepartmentMetrics(Array.from(targetDeptIds), fyId);

  // 2. Budget Category Breakdown (for Department or Centre)
  const budgets = db.department_budgets.filter((b) => targetDeptIds.has(b.department_id) && b.financial_year_id === fyId);
  const categories = budgets.map((b) => {
    const alloc = Number(b.allocated_amount) || 0;
    const app = Number(b.approved_amount) || 0;
    const pend = Number(b.pending_amount) || 0;
    return {
      category_id: b.budget_category_id,
      category_name: catMap.get(b.budget_category_id) || 'Category Allocation',
      allocated: alloc,
      approved: app,
      pending: pend,
      available: alloc - app - pend,
      utilization: alloc > 0 ? `${Math.round(((app + pend) / alloc) * 100)}%` : '0%',
    };
  });

  // 3. Faculty-wise Activity Table
  const facultyList = db.users.filter((u) => u.role === 'faculty' && u.department_id && targetDeptIds.has(u.department_id));
  const facultyActivity: any[] = [];
  let facSl = 1;

  facultyList.forEach((f) => {
    const fNfas = db.nfas.filter((n) => n.created_by === f.id && n.status !== 'draft' && n.financial_year_id === fyId);
    if (!resolution.includeAllFaculty && fNfas.length === 0) {
      return; // Exclude zero-activity faculty unless explicitly requested
    }
    const approved = fNfas.filter((n) => n.status === 'approved');
    const pending = fNfas.filter((n) => !['approved', 'rejected', 'draft'].includes(n.status));
    const rejected = fNfas.filter((n) => n.status === 'rejected');
    const requestedAmt = fNfas.reduce((sum, n) => sum + (Number(n.total_amount) || 0), 0);
    const approvedAmt = approved.reduce((sum, n) => sum + (Number(n.total_amount) || 0), 0);
    const eventsCompleted = fNfas.filter((n) => n.nfa_type === 'event' && n.event_completion_status === 'completed').length;

    facultyActivity.push({
      sl_no: facSl++,
      faculty_name: f.name,
      email: f.email,
      department: f.department_id ? (deptMap.get(f.department_id)?.code || '') : '',
      total_submitted: fNfas.length,
      total_approved: approved.length,
      total_pending: pending.length,
      total_rejected: rejected.length,
      total_requested: requestedAmt,
      total_approved_amount: approvedAmt,
      events_completed: eventsCompleted,
    });
  });

  // 4. Detailed NFA Activity Table
  const detailedNfas = db.nfas
    .filter((n) => (targetDeptIds.has(n.department_id) || (n.centre_id && targetDeptIds.has(n.centre_id))) && n.status !== 'draft' && n.financial_year_id === fyId)
    .map((n, idx) => ({
      sl_no: idx + 1,
      ref_no: n.ref_no,
      date: n.date,
      proposer: n.submitted_by_name || userMap.get(n.created_by) || 'Faculty',
      department: deptMap.get(n.department_id)?.code || '',
      title: n.title,
      type: (n.nfa_type || 'event').toUpperCase(),
      requested_amount: Number(n.total_amount) || 0,
      approved_amount: n.status === 'approved' ? (Number(n.total_amount) || 0) : 0,
      status: n.status.toUpperCase(),
      completion_status: n.nfa_type === 'event' ? (n.event_completion_status || 'scheduled').toUpperCase() : 'N/A',
      will_generate_revenue: n.will_generate_revenue ? 'YES' : 'NO',
    }));

  // Organization name & title resolution
  let orgName = 'CHRIST (Deemed to be University)';
  let orgCode = 'CAMPUS';
  if (resolution.scope === 'school' && resolution.selectedSchool) {
    orgName = resolution.selectedSchool.name;
    orgCode = resolution.selectedSchool.code;
  } else if (resolution.scope === 'department' && resolution.selectedDept) {
    orgName = resolution.selectedDept.name;
    orgCode = resolution.selectedDept.code;
  } else if (resolution.scope === 'centre' && resolution.selectedCentre) {
    orgName = resolution.selectedCentre.name;
    orgCode = resolution.selectedCentre.code;
  }

  // School departments breakdown if scope is school
  let departmentsBreakdown: any[] | undefined;
  if (resolution.scope === 'school') {
    const depts = db.departments.filter((d) => targetDeptIds.has(d.id));
    departmentsBreakdown = depts.map((d) => ({
      id: d.id,
      name: d.name,
      code: d.code,
      metrics: computeDepartmentMetrics([d.id], fyId),
    }));
  }

  return {
    scope: resolution.scope,
    org_name: orgName,
    org_code: orgCode,
    financial_year: fyLabel,
    financial_year_id: fyId,
    include_all_faculty: resolution.includeAllFaculty,
    metrics,
    categories,
    faculty_activity: facultyActivity,
    detailed_nfas: detailedNfas,
    departments: departmentsBreakdown,
  };
}

// ==========================================
// 1. SUMMARY GENERATION ENDPOINTS
// ==========================================

/**
 * GET /api/reports/summary/overview
 * Unified executive summary endpoint serving complete 3-section institutional reports
 */
reportsRouter.get('/summary/overview', (req: AuthedRequest, res) => {
  const data = getExecutiveSummaryData(req.user!, req.query);
  res.json(data);
});

/**
 * GET /api/reports/summary/campus
 */
reportsRouter.get('/summary/campus', (req: AuthedRequest, res) => {
  if (!checkReportScopeAuthorization(req.user!, 'campus')) {
    return res.status(403).json({ error: 'Forbidden: Campus summary requires institutional executive role' });
  }

  const fyId = (req.query.financial_year_id as string) || (req.query.fy_id as string);
  const allDepts = store.data.departments;
  const academicDepts = allDepts.filter((d) => d.category !== 'coe' && !d.code.startsWith('COE-'));
  const centreDepts = allDepts.filter((d) => d.category === 'coe' || d.code.startsWith('COE-'));

  const overallMetrics = computeDepartmentMetrics(allDepts.map((d) => d.id), fyId);
  const academicMetrics = computeDepartmentMetrics(academicDepts.map((d) => d.id), fyId);
  const centreMetrics = computeDepartmentMetrics(centreDepts.map((d) => d.id), fyId);

  const schools = (store.data.schools || []).map((s) => {
    const sDepts = allDepts.filter((d) => d.school_id === s.id);
    return {
      ...s,
      departments_count: sDepts.length,
      metrics: computeDepartmentMetrics(sDepts.map((d) => d.id), fyId),
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

  const fyId = (req.query.financial_year_id as string) || (req.query.fy_id as string);
  const depts = store.data.departments.filter((d) => d.school_id === school.id);
  const metrics = computeDepartmentMetrics(depts.map((d) => d.id), fyId);

  const departmentBreakdown = depts.map((d) => ({
    id: d.id,
    name: d.name,
    code: d.code,
    metrics: computeDepartmentMetrics([d.id], fyId),
  }));

  res.json({
    scope: 'school',
    school,
    school_name: school.name,
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

  const fyId = (req.query.financial_year_id as string) || (req.query.fy_id as string);
  const metrics = computeDepartmentMetrics([dept.id], fyId);
  const budgets = store.data.department_budgets.filter((b) => b.department_id === dept.id && (!fyId || b.financial_year_id === fyId));
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

  const fyId = (req.query.financial_year_id as string) || (req.query.fy_id as string);
  const metrics = computeDepartmentMetrics([centre.id], fyId);

  res.json({
    scope: 'centre',
    centre,
    metrics,
  });
});

// ==========================================
// 2. SCHOOL COMPREHENSIVE BUNDLE HELPER
// ==========================================

export function getSchoolReportBundle(schoolCodeOrId: string = 'SOET', _user: any, fyId?: string) {
  const db = store.data;
  const targetCode = String(schoolCodeOrId || 'SOET').toUpperCase();
  let school = (db.schools || []).find((s) => s.id === schoolCodeOrId || s.code.toUpperCase() === targetCode);
  if (!school && (!schoolCodeOrId || targetCode === 'SOET')) {
    school = (db.schools && db.schools[0]) || { id: 'soet', code: 'SOET', name: 'School of Engineering & Technology', campus: 'Bengaluru – Kengeri Campus' };
  } else if (!school) {
    school = { id: schoolCodeOrId, code: targetCode, name: `School (${targetCode})`, campus: 'Bengaluru – Kengeri Campus' };
  }

  const deptMap = new Map(db.departments.map((d) => [d.id, d]));
  const catMap = new Map(db.budget_categories.map((c) => [c.id, c.name]));
  const userMap = new Map(db.users.map((u) => [u.id, u.name]));

  // Departments mapped to this school
  const depts = db.departments.filter((d) => d.school_id === school.id || (!d.school_id && school.code === 'SOET' && d.category === 'academic'));
  const deptIds = new Set(depts.map((d) => d.id));

  // Department Details
  const deptDetails = depts.map((d, idx) => {
    const dNfas = db.nfas.filter((n) => n.department_id === d.id && (!fyId || n.financial_year_id === fyId));
    const facultyWithNfas = new Set(dNfas.map((n) => n.created_by));
    const approved = dNfas.filter((n) => n.status === 'approved');
    const pending = dNfas.filter((n) => !['approved', 'rejected', 'draft'].includes(n.status));
    const rejected = dNfas.filter((n) => n.status === 'rejected');

    const budgets = db.department_budgets.filter((b) => b.department_id === d.id && (!fyId || b.financial_year_id === fyId));
    const alloc = budgets.reduce((sum, b) => sum + (Number(b.allocated_amount) || 0), 0);
    const app = budgets.reduce((sum, b) => sum + (Number(b.approved_amount) || 0), 0);
    const pend = budgets.reduce((sum, b) => sum + (Number(b.pending_amount) || 0), 0);
    const rem = alloc - app - pend;
    const util = alloc > 0 ? `${Math.round(((app + pend) / alloc) * 100)}%` : '0%';

    return {
      sl_no: idx + 1,
      department_name: d.name,
      department_code: d.code,
      faculty_count: facultyWithNfas.size,
      total_nfas: dNfas.length,
      approved_nfas: approved.length,
      pending_nfas: pending.length,
      rejected_nfas: rejected.length,
      allocated: alloc,
      approved: app,
      pending: pend,
      available: rem,
      utilization: util,
    };
  });

  const totalAlloc = deptDetails.reduce((sum, d) => sum + d.allocated, 0);
  const totalApp = deptDetails.reduce((sum, d) => sum + d.approved, 0);
  const totalPend = deptDetails.reduce((sum, d) => sum + d.pending, 0);
  const totalRem = totalAlloc - totalApp - totalPend;
  const allSchoolNfas = db.nfas.filter((n) => deptIds.has(n.department_id) && (!fyId || n.financial_year_id === fyId));
  const uniqueFaculty = new Set(allSchoolNfas.map((n) => n.created_by));

  const overview = {
    school_name: school.name,
    school_code: school.code,
    campus: school.campus || 'Bengaluru – Kengeri Campus',
    reporting_year: '2026-27',
    total_departments: depts.length,
    active_faculty_count: uniqueFaculty.size,
    total_nfas: allSchoolNfas.length,
    allocated_budget: totalAlloc,
    approved_expenditure: totalApp,
    pending_reservations: totalPend,
    available_balance: totalRem,
  };

  // Faculty & NFA Activity
  const facultyNfas = allSchoolNfas.map((n, idx) => ({
    sl_no: idx + 1,
    faculty_name: n.submitted_by_name || userMap.get(n.created_by) || 'Faculty',
    department: deptMap.get(n.department_id)?.code || '',
    nfa_ref: n.ref_no,
    title: n.title,
    nfa_type: (n.nfa_type || 'event').toUpperCase(),
    amount: Number(n.total_amount) || 0,
    submission_date: n.date,
    status: n.status.toUpperCase(),
  }));

  // Event Activity
  const eventActivity = allSchoolNfas.filter((n) => n.nfa_type === 'event').map((n, idx) => {
    const revs = (db.event_revenues || []).filter((r) => r.nfa_id === n.id);
    const recRev = revs.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const verRev = revs.filter((r) => r.status === 'verified').reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    return {
      sl_no: idx + 1,
      event_title: n.title,
      organizer: n.submitted_by_name || userMap.get(n.created_by) || 'Faculty',
      department: deptMap.get(n.department_id)?.code || '',
      nfa_ref: n.ref_no,
      event_date: n.event_details?.event_date || '—',
      completion_status: (n.event_completion_status || 'scheduled').toUpperCase(),
      revenue_generating: n.will_generate_revenue ? 'YES' : 'NO',
      recorded_revenue: recRev,
      verified_revenue: verRev,
    };
  });

  // Budget Details (Categories & Subcategories)
  const budgetDetails: any[] = [];
  let bIdx = 1;
  depts.forEach((d) => {
    const lines = db.department_budgets.filter((b) => b.department_id === d.id && (!fyId || b.financial_year_id === fyId));
    lines.forEach((l) => {
      const subcats = db.budget_subcategories.filter((s) => s.budget_category_id === l.budget_category_id && s.department_id === d.id);
      if (subcats.length > 0) {
        subcats.forEach((s) => {
          budgetDetails.push({
            sl_no: s.sl_no || bIdx++,
            department: d.code,
            category: catMap.get(l.budget_category_id) || 'General',
            subcategory: s.name,
            allocated: Number(s.allocated_amount) || 0,
            approved: Number(s.approved_amount) || 0,
            pending: Number(s.pending_amount) || 0,
            available: (Number(s.allocated_amount) || 0) - (Number(s.approved_amount) || 0) - (Number(s.pending_amount) || 0),
          });
        });
      } else {
        budgetDetails.push({
          sl_no: bIdx++,
          department: d.code,
          category: catMap.get(l.budget_category_id) || 'General',
          subcategory: 'General Category Allocation',
          allocated: Number(l.allocated_amount) || 0,
          approved: Number(l.approved_amount) || 0,
          pending: Number(l.pending_amount) || 0,
          available: (Number(l.allocated_amount) || 0) - (Number(l.approved_amount) || 0) - (Number(l.pending_amount) || 0),
        });
      }
    });
  });

  // Revenue & Earnings
  const revenueEntries = (db.event_revenues || []).filter((r) => {
    const nfa = db.nfas.find((n) => n.id === r.nfa_id);
    return nfa && deptIds.has(nfa.department_id) && (!fyId || nfa.financial_year_id === fyId);
  }).map((r, idx) => {
    const nfa = db.nfas.find((n) => n.id === r.nfa_id);
    return {
      sl_no: idx + 1,
      source: r.revenue_source.replace(/_/g, ' ').toUpperCase(),
      event_ref: nfa?.ref_no || '',
      event_title: nfa?.title || '',
      department: deptMap.get(r.department_id)?.code || '',
      collection_date: r.collection_date,
      amount: Number(r.amount) || 0,
      payment_method: (r.payment_method || 'Online').toUpperCase(),
      status: r.status.toUpperCase(),
    };
  });

  // Purchase Invoices
  const invoices = (db.purchase_invoices || []).filter((i) => {
    const nfa = db.nfas.find((n) => n.id === i.nfa_id);
    return nfa && deptIds.has(nfa.department_id) && (!fyId || nfa.financial_year_id === fyId);
  }).map((i, idx) => {
    const nfa = db.nfas.find((n) => n.id === i.nfa_id);
    return {
      sl_no: idx + 1,
      nfa_ref: nfa?.ref_no || '',
      item_title: nfa?.title || '',
      department: deptMap.get(nfa?.department_id)?.code || '',
      invoice_number: i.invoice_number,
      invoice_date: i.invoice_date,
      vendor: i.vendor_name,
      invoice_amount: Number(i.invoice_amount) || 0,
      gst_amount: Number(i.gst_amount) || 0,
      verification_status: i.verification_status.toUpperCase(),
      payment_status: i.payment_status.toUpperCase(),
      paid_amount: Number(i.paid_amount) || 0,
      outstanding_payment: Math.max(0, (Number(i.invoice_amount) || 0) - (Number(i.paid_amount) || 0)),
    };
  });

  return {
    overview,
    departments: deptDetails,
    faculty_nfas: facultyNfas,
    events: eventActivity,
    budgets: budgetDetails,
    revenues: revenueEntries,
    invoices,
  };
}

// ==========================================
// 3. REPORT DATA ENGINE (14 REPORT TYPES)
// ==========================================

export function getReportDataset(
  reportType: string,
  user: { id: string; role: Role; department_id: string | null; authorized_centre_ids?: string[]; name?: string },
  filters: any = {}
) {
  const db = store.data;
  const resolution = resolveAuthorizedScope(user, filters);
  const targetDeptIds = resolution.targetDeptIds;
  const targetFyId = resolution.financialYear.id;

  const deptMap = new Map(db.departments.map((d) => [d.id, d]));
  const catMap = new Map(db.budget_categories.map((c) => [c.id, c.name]));
  const userMap = new Map(db.users.map((u) => [u.id, u.name]));

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
      const list = db.nfas.filter((n) => {
        if (!targetDeptIds.has(n.department_id) && (!n.centre_id || !targetDeptIds.has(n.centre_id))) return false;
        if (targetFyId && n.financial_year_id !== targetFyId) return false;
        return nfaInScope(n);
      });
      return list.map((n, idx) => ({
        sl_no: idx + 1,
        ref_no: n.ref_no,
        date: n.date,
        title: n.title,
        department: deptMap.get(n.department_id)?.code || '',
        category: catMap.get(n.budget_category_id) || '',
        proposer: n.submitted_by_name || userMap.get(n.created_by) || 'Faculty',
        amount: Number(n.total_amount) || 0,
        status: n.status.toUpperCase(),
        type: (n.nfa_type || 'event').toUpperCase(),
      }));
    }

    case 'department_budget': {
      const depts = db.departments.filter((d) => targetDeptIds.has(d.id));
      const rows: any[] = [];
      let sl = 1;
      depts.forEach((d) => {
        const budgets = db.department_budgets.filter((b) => b.department_id === d.id && (!targetFyId || b.financial_year_id === targetFyId));
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
      let schools = db.schools || [];
      if (resolution.selectedSchool) {
        schools = schools.filter((s) => s.id === resolution.selectedSchool?.id);
      }
      schools.forEach((s) => {
        const sDepts = db.departments.filter((d) => d.school_id === s.id);
        const m = computeDepartmentMetrics(sDepts.map((d) => d.id), targetFyId);
        rows.push({
          sl_no: sl++,
          school_code: s.code,
          school_name: s.name,
          campus: s.campus || 'Bengaluru – Kengeri Campus',
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
      const overall = computeDepartmentMetrics(db.departments.map((d) => d.id), targetFyId);
      const academic = computeDepartmentMetrics(db.departments.filter((d) => d.category !== 'coe' && !d.code.startsWith('COE-')).map((d) => d.id), targetFyId);
      const coe = computeDepartmentMetrics(db.departments.filter((d) => d.category === 'coe' || d.code.startsWith('COE-')).map((d) => d.id), targetFyId);
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
      const capexNfas = db.nfas.filter((n) => {
        if (!capexCatIds.has(n.budget_category_id)) return false;
        if (!targetDeptIds.has(n.department_id) && (!n.centre_id || !targetDeptIds.has(n.centre_id))) return false;
        if (targetFyId && n.financial_year_id !== targetFyId) return false;
        return nfaInScope(n);
      });
      return capexNfas.map((n, idx) => ({
        sl_no: idx + 1,
        ref_no: n.ref_no,
        date: n.date,
        department: deptMap.get(n.department_id)?.code || '',
        item_title: n.title,
        amount: Number(n.total_amount) || 0,
        status: n.status.toUpperCase(),
        vendor: (n.quotations && n.quotations[0]?.vendor_name) || 'Not Finalized',
      }));
    }

    case 'revenue_earnings': {
      const revs = (db.event_revenues || []).filter((r) => {
        if (!r.department_id || !targetDeptIds.has(r.department_id)) return false;
        const nfa = db.nfas.find((n) => n.id === r.nfa_id);
        if (nfa && targetFyId && nfa.financial_year_id !== targetFyId) return false;
        return !nfa || nfaInScope(nfa);
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
          payment_method: (r.payment_method || 'Online').toUpperCase(),
          status: r.status.toUpperCase(),
          verified_by: r.verified_by_name || '—',
        };
      });
    }

    case 'event_activity': {
      const events = db.nfas.filter((n) => {
        if (n.nfa_type !== 'event') return false;
        if (!targetDeptIds.has(n.department_id) && (!n.centre_id || !targetDeptIds.has(n.centre_id))) return false;
        if (targetFyId && n.financial_year_id !== targetFyId) return false;
        return nfaInScope(n);
      });
      return events.map((n, idx) => ({
        sl_no: idx + 1,
        ref_no: n.ref_no,
        date: n.date,
        event_title: n.title,
        department: deptMap.get(n.department_id)?.code || '',
        resource_person: n.event_details?.resource_person_name || '—',
        venue: n.event_details?.venue || 'Campus',
        amount: Number(n.total_amount) || 0,
        status: n.status.toUpperCase(),
        completion: (n.event_completion_status || 'scheduled').toUpperCase(),
        revenue_enabled: n.will_generate_revenue ? 'YES' : 'NO',
      }));
    }

    case 'purchase_activity': {
      const purchases = db.nfas.filter((n) => {
        if (n.nfa_type !== 'purchase' && !n.purchase_details) return false;
        if (!targetDeptIds.has(n.department_id) && (!n.centre_id || !targetDeptIds.has(n.centre_id))) return false;
        if (targetFyId && n.financial_year_id !== targetFyId) return false;
        return nfaInScope(n);
      });
      return purchases.map((n, idx) => ({
        sl_no: idx + 1,
        ref_no: n.ref_no,
        date: n.date,
        item_title: n.title,
        department: deptMap.get(n.department_id)?.code || '',
        amount: Number(n.total_amount) || 0,
        status: n.status.toUpperCase(),
        quotations_count: n.quotations?.length || 0,
        vendor: (n.quotations && n.quotations[0]?.vendor_name) || '—',
      }));
    }

    case 'purchase_invoice': {
      const invoices = (db.purchase_invoices || []).filter((i) => {
        const nfa = db.nfas.find((n) => n.id === i.nfa_id);
        if (!nfa) return false;
        if (!targetDeptIds.has(nfa.department_id) && (!nfa.centre_id || !targetDeptIds.has(nfa.centre_id))) return false;
        if (targetFyId && nfa.financial_year_id !== targetFyId) return false;
        return nfaInScope(nfa);
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
      (db.purchase_invoices || []).forEach((i) => {
        const nfa = db.nfas.find((n) => n.id === i.nfa_id);
        if (nfa && (targetDeptIds.has(nfa.department_id) || (nfa.centre_id && targetDeptIds.has(nfa.centre_id)))) {
          if (!targetFyId || nfa.financial_year_id === targetFyId) {
            if (nfaInScope(nfa)) {
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
          }
        }
      });
      (db.resource_person_bank_details || []).forEach((b) => {
        const nfa = db.nfas.find((n) => n.id === b.nfa_id);
        if (nfa && (targetDeptIds.has(nfa.department_id) || (nfa.centre_id && targetDeptIds.has(nfa.centre_id)))) {
          if (!targetFyId || nfa.financial_year_id === targetFyId) {
            if (nfaInScope(nfa)) {
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
          }
        }
      });
      return rows;
    }

    case 'financial_ledger': {
      const logs = db.audit_logs.filter((l) => {
        if (l.department_id && !targetDeptIds.has(l.department_id)) return false;
        if (isSenior || isDean) return true;
        if (user.role === 'hod') return l.department_id === user.department_id;
        return l.changed_by === user.name;
      });
      return logs.slice(0, 200).map((l, idx) => ({
        sl_no: idx + 1,
        timestamp: l.created_at,
        entity: l.entity_type.toUpperCase(),
        department: l.department_id || '—',
        user: l.changed_by,
        role: l.role.toUpperCase(),
        action: l.approval_status,
        reason: l.reason,
        amount: l.new_amount !== null ? `₹${Number(l.new_amount).toLocaleString('en-IN')}` : '—',
      }));
    }

    case 'faculty_nfa': {
      // Filter faculty strictly to authorized target departments
      const facultyList = db.users.filter((u) => u.role === 'faculty' && u.department_id && targetDeptIds.has(u.department_id));
      const rows: any[] = [];
      let sl = 1;

      facultyList.forEach((f) => {
        const fNfas = db.nfas.filter((n) => n.created_by === f.id && n.status !== 'draft' && (!targetFyId || n.financial_year_id === targetFyId));
        // Exclude faculty with 0 submitted proposals unless include_all_faculty is requested
        if (!resolution.includeAllFaculty && fNfas.length === 0) {
          return;
        }

        const approved = fNfas.filter((n) => n.status === 'approved');
        const pending = fNfas.filter((n) => !['approved', 'rejected', 'draft'].includes(n.status));
        const rejected = fNfas.filter((n) => n.status === 'rejected');
        const requestedAmt = fNfas.reduce((sum, n) => sum + (Number(n.total_amount) || 0), 0);
        const approvedAmt = approved.reduce((sum, n) => sum + (Number(n.total_amount) || 0), 0);
        const completedEvents = fNfas.filter((n) => n.nfa_type === 'event' && n.event_completion_status === 'completed').length;

        rows.push({
          sl_no: sl++,
          faculty_name: f.name,
          email: f.email,
          department: f.department_id ? (deptMap.get(f.department_id)?.code || '') : '',
          total_submitted: fNfas.length,
          total_approved: approved.length,
          total_pending: pending.length,
          total_rejected: rejected.length,
          total_requested: requestedAmt,
          total_approved_amount: approvedAmt,
          events_completed: completedEvents,
        });
      });
      return rows;
    }

    case 'centres_offices': {
      let coes = db.departments.filter((d) => d.category === 'coe' || d.code.startsWith('COE-'));
      if (resolution.targetDeptIds.size > 0 && resolution.isSpecificFilter) {
        coes = coes.filter((c) => resolution.targetDeptIds.has(c.id));
      }
      return coes.map((c, idx) => {
        const m = computeDepartmentMetrics([c.id], targetFyId);
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
      const inFlight = db.nfas.filter((n) => {
        if (['draft', 'approved', 'rejected'].includes(n.status)) return false;
        if (!targetDeptIds.has(n.department_id) && (!n.centre_id || !targetDeptIds.has(n.centre_id))) return false;
        if (targetFyId && n.financial_year_id !== targetFyId) return false;
        return nfaInScope(n);
      });
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
 * Returns structured data for the table preview, applying strict organization and FY filters
 */
reportsRouter.get('/data/:reportType', (req: AuthedRequest, res) => {
  const { reportType } = req.params;
  const data = getReportDataset(reportType, req.user!, req.query);
  res.json({
    report_type: reportType,
    title: reportType.replace(/_/g, ' ').toUpperCase(),
    total_records: data.length,
    rows: data,
    data,
  });
});

// ==========================================
// 4. PROFESSIONAL A4 PDF REPORT GENERATOR
// ==========================================

export function isCurrencyKey(k: string): boolean {
  const lower = k.toLowerCase();
  if (
    lower === 'sl_no' ||
    lower === 's_no' ||
    lower === 'sno' ||
    lower.includes('count') ||
    lower.includes('days') ||
    lower.includes('percentage') ||
    lower.includes('utilization') ||
    lower.includes('faculty_count') ||
    lower.includes('departments_count')
  ) {
    return false;
  }
  return (
    lower.includes('amount') ||
    lower.includes('allocated') ||
    lower.includes('approved_amount') ||
    lower.includes('approved_expenditure') ||
    lower.includes('pending_reservations') ||
    lower.includes('available') ||
    lower.includes('revenue') ||
    lower.includes('requested') ||
    lower.includes('spend') ||
    lower.includes('balance') ||
    lower.includes('paid') ||
    lower.includes('gst') ||
    lower.includes('honorarium') ||
    lower.includes('cost') ||
    lower.includes('budget') ||
    lower === 'allocated' ||
    lower === 'approved' ||
    lower === 'pending'
  );
}

export function formatStatusLabel(val: any): string {
  if (val === null || val === undefined) return '—';
  const str = String(val);
  if (str.includes('_') || (str === str.toUpperCase() && str.length > 3)) {
    return str
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return str;
}

function renderPdfTable(
  doc: PDFKit.PDFDocument,
  keys: string[],
  rows: any[],
  startY: number,
  pageWidth: number,
  pageHeight: number,
  leftMargin: number,
  rightMargin: number,
  fonts?: RegisteredPdfFonts
) {
  const tableWidth = pageWidth - leftMargin - rightMargin;

  if (!rows || rows.length === 0) {
    doc.font(fonts?.fontItalic || 'Times-Italic').fontSize(8.5).fillColor('#64748B').text('No records available for the selected organization and academic year.', leftMargin, startY);
    return startY + 20;
  }

  // Custom intelligent column weights
  const customWeights: Record<string, number> = {
    sl_no: 32,
    date: 58,
    invoice_date: 58,
    collection_date: 58,
    timestamp: 68,
    ref_no: 78,
    nfa_ref: 78,
    invoice_no: 78,
    event_ref: 78,
    code: 45,
    department: 48,
    department_code: 48,
    school_code: 48,
    status: 75,
    verification: 75,
    verification_status: 75,
    payment_status: 75,
    completion: 75,
    completion_status: 75,
    current_stage: 80,
    type: 48,
    nfa_type: 48,
    revenue_enabled: 48,
    revenue_generating: 48,
    will_generate_revenue: 48,
    allocated: 68,
    approved: 68,
    pending: 68,
    available: 68,
    amount: 68,
    requested_amount: 68,
    approved_amount: 68,
    invoice_amount: 68,
    paid_amount: 68,
    gst_amount: 58,
    recorded_revenue: 68,
    verified_revenue: 68,
    revenue_generated: 68,
    total_requested: 68,
    total_approved_amount: 68,
    total_submitted: 42,
    total_approved: 42,
    total_pending: 42,
    total_rejected: 42,
    events_completed: 45,
  };

  let allocatedFixed = 0;
  let flexCols = 0;
  keys.forEach((k) => {
    if (customWeights[k]) allocatedFixed += customWeights[k];
    else flexCols++;
  });

  const remainingWidth = Math.max(80 * flexCols, tableWidth - allocatedFixed);
  const flexColWidth = flexCols > 0 ? Math.floor(remainingWidth / flexCols) : 90;

  const colWidths = keys.map((k) => customWeights[k] || flexColWidth);

  // Normalize column widths to exact tableWidth
  const totalCalculated = colWidths.reduce((a, b) => a + b, 0);
  const scale = tableWidth / totalCalculated;
  const finalColWidths = colWidths.map((w) => Math.floor(w * scale));

  let curY = startY;
  const boldFont = fonts?.fontBold || 'Times-Bold';
  const regFont = fonts?.fontRegular || 'Times-Roman';
  const hasUnicode = Boolean(fonts?.hasUnicode);

  function drawTableHeader() {
    doc.rect(leftMargin, curY, tableWidth, 22).fillColor(CHRIST_BLUE).fill();
    let colX = leftMargin;
    keys.forEach((k, idx) => {
      const colW = finalColWidths[idx];
      const isCurr = isCurrencyKey(k);
      const isCenter = k === 'sl_no' || k === 's_no' || k.includes('count') || k === 'type' || k === 'nfa_type';
      doc
        .font(boldFont)
        .fontSize(8)
        .fillColor('#FFFFFF')
        .text(k.replace(/_/g, ' ').toUpperCase(), colX + 4, curY + 6, {
          width: colW - 8,
          align: isCurr ? 'right' : isCenter ? 'center' : 'left',
          ellipsis: true,
        });
      colX += colW;
    });
    curY += 22;
  }

  drawTableHeader();

  // Draw data rows
  doc.fontSize(7.5);
  rows.forEach((row, rIdx) => {
    // Measure dynamic row height
    let maxCellHeight = 16;
    keys.forEach((k, idx) => {
      const colW = finalColWidths[idx];
      const val = row[k];
      let cellText: string;
      if (typeof val === 'number') {
        cellText = isCurrencyKey(k) ? formatPdfCurrency(val, hasUnicode) : val.toLocaleString('en-IN');
      } else if (k === 'status' || k.includes('status') || k === 'current_stage') {
        cellText = formatStatusLabel(val);
      } else {
        cellText = String(val ?? '—');
      }
      doc.font(regFont).fontSize(7.5);
      const h = doc.heightOfString(cellText, { width: colW - 8 });
      if (h > maxCellHeight) maxCellHeight = h;
    });

    const rowHeight = Math.min(65, Math.max(18, maxCellHeight + 6));

    // Page break handling: only add page if this row will exceed bottom margin
    if (curY + rowHeight > pageHeight - 45) {
      doc.addPage();
      curY = 36;
      drawTableHeader();
    }

    if (rIdx % 2 === 1) {
      doc.rect(leftMargin, curY, tableWidth, rowHeight).fillColor(ROW_BG_ALT).fill();
    }

    let colX = leftMargin;
    keys.forEach((k, idx) => {
      const colW = finalColWidths[idx];
      const val = row[k];
      const isCurr = isCurrencyKey(k);
      const isCenter = k === 'sl_no' || k === 's_no' || k.includes('count') || k === 'type' || k === 'nfa_type';
      let cellText: string;
      if (typeof val === 'number') {
        cellText = isCurr ? formatPdfCurrency(val, hasUnicode) : val.toLocaleString('en-IN');
      } else if (k === 'status' || k.includes('status') || k === 'current_stage') {
        cellText = formatStatusLabel(val);
      } else {
        cellText = String(val ?? '—');
      }

      doc
        .font(regFont)
        .fontSize(7.5)
        .fillColor(TEXT_DARK)
        .text(cellText, colX + 4, curY + 4, {
          width: colW - 8,
          align: isCurr ? 'right' : isCenter ? 'center' : 'left',
          ellipsis: true,
        });
      colX += colW;
    });

    doc.moveTo(leftMargin, curY + rowHeight).lineTo(leftMargin + tableWidth, curY + rowHeight).strokeColor(BORDER_LIGHT).lineWidth(0.5).stroke();
    curY += rowHeight;
  });

  return curY;
}

/**
 * Draws the official CHRIST University header with crest logo and institutional metadata
 */
function drawOfficialHeader(
  doc: PDFKit.PDFDocument,
  title: string,
  user: any,
  leftMargin: number,
  contentWidth: number,
  fyLabel: string = '2026-27',
  fonts?: RegisteredPdfFonts
) {
  const topY = 36;
  if (fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, leftMargin, topY, { fit: [55, 55] });
    } catch {}
  }

  const boldFont = fonts?.fontBold || 'Times-Bold';
  const regFont = fonts?.fontRegular || 'Times-Roman';

  doc
    .font(boldFont)
    .fontSize(15)
    .fillColor(CHRIST_BLUE)
    .text('CHRIST (Deemed to be University)', leftMargin + 65, topY + 2);

  doc
    .font(regFont)
    .fontSize(9.5)
    .fillColor(TEXT_DARK)
    .text('Bengaluru – Kengeri Campus · Institutional NFA & Budget Management System', leftMargin + 65, topY + 20)
    .font(boldFont)
    .fontSize(11)
    .fillColor(CHRIST_BLUE)
    .text(`OFFICIAL INSTITUTIONAL REPORT: ${title.toUpperCase()}`, leftMargin + 65, topY + 34);

  doc
    .font(regFont)
    .fontSize(8)
    .fillColor('#64748B')
    .text(`Academic Year: ${fyLabel} | Generated: ${new Date().toLocaleString('en-IN')} | Authorized User: ${user.name} (${user.role.toUpperCase()})`, leftMargin, topY + 64);

  doc.moveTo(leftMargin, topY + 76).lineTo(leftMargin + contentWidth, topY + 76).strokeColor(CHRIST_BLUE).lineWidth(1.5).stroke();

  return topY + 88;
}

/**
 * Renders footers across all buffered pages with ZERO accidental page breaks
 */
function renderPdfFooters(doc: PDFKit.PDFDocument, leftMargin: number, contentWidth: number, pageHeight: number, fonts?: RegisteredPdfFonts) {
  const regFont = fonts?.fontRegular || 'Times-Roman';
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i++) {
    doc.switchToPage(i);
    // CRITICAL: set margins.bottom to 0 so footer text never triggers an auto-page-break
    doc.page.margins.bottom = 0;
    doc
      .font(regFont)
      .fontSize(7.5)
      .fillColor('#94A3B8')
      .text(
        `CHRIST (Deemed to be University) — Institutional Confidential Document | Page ${i + 1} of ${pageRange.count}`,
        leftMargin,
        pageHeight - 22,
        { align: 'center', width: contentWidth, lineBreak: false }
      );
  }
}

/**
 * POST or GET /api/reports/summary/export/pdf
 * Generates official A4 Executive Summary PDF (Executive KPI Box + Faculty Table + Detailed NFA Table)
 */
reportsRouter.all('/summary/export/pdf', (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const filters = { ...(req.query || {}), ...(req.body || {}) };
  const summary = getExecutiveSummaryData(user, filters);

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margins: { top: 36, bottom: 20, left: 36, right: 36 },
    bufferPages: true,
  });

  const fonts = registerUnicodeFonts(doc);

  const filename = `CU_Executive_Summary_${summary.org_code}_${Date.now()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const leftMargin = 36;
  const rightMargin = 36;
  const contentWidth = pageWidth - leftMargin - rightMargin;

  let curY = drawOfficialHeader(
    doc,
    `EXECUTIVE SUMMARY — ${summary.org_name.toUpperCase()} (${summary.org_code})`,
    user,
    leftMargin,
    contentWidth,
    summary.financial_year,
    fonts
  );

  // Section 1: Executive KPI Overview Box
  doc.font(fonts.fontBold).fontSize(11).fillColor(CHRIST_BLUE).text('SECTION 1: FINANCIAL CEILING & COMMITMENTS SUMMARY', leftMargin, curY);
  curY += 16;

  doc.rect(leftMargin, curY, contentWidth, 48).fillColor('#F1F5F9').strokeColor(BORDER_LIGHT).lineWidth(1).fillAndStroke();
  const kpiCol = Math.floor(contentWidth / 4);
  const m = summary.metrics;
  const kpis = [
    { l: 'Allocated Budget', v: formatPdfCurrency(m.allocated, fonts.hasUnicode), c: CHRIST_BLUE },
    { l: 'Approved Expenditure', v: formatPdfCurrency(m.approved, fonts.hasUnicode), c: '#16A34A' },
    { l: 'Active Reservations', v: formatPdfCurrency(m.pending, fonts.hasUnicode), c: '#CA8A04' },
    { l: 'Available Balance', v: formatPdfCurrency(m.available, fonts.hasUnicode), c: '#0284C7' },
  ];
  kpis.forEach((k, idx) => {
    doc.font(fonts.fontBold).fontSize(7.5).fillColor('#64748B').text(k.l.toUpperCase(), leftMargin + idx * kpiCol + 8, curY + 8);
    doc.font(fonts.fontBold).fontSize(13).fillColor(k.c).text(k.v, leftMargin + idx * kpiCol + 8, curY + 24);
  });
  curY += 60;

  // Secondary metrics line
  doc.font(fonts.fontRegular).fontSize(8.5).fillColor(TEXT_DARK).text(
    `Total NFAs: ${m.total_nfas} (Approved: ${m.approved_nfas} · In-Flight: ${m.pending_nfas} · Rejected: ${m.rejected_nfas}) | Events Completed: ${m.events_completed_count}/${m.event_nfas_count} | Revenue Generated: ${formatPdfCurrency(m.total_revenue, fonts.hasUnicode)} (Verified: ${formatPdfCurrency(m.verified_revenue, fonts.hasUnicode)}) | Invoices Paid: ${formatPdfCurrency(m.invoices_paid, fonts.hasUnicode)} (Pending: ${formatPdfCurrency(m.invoices_pending, fonts.hasUnicode)})`,
    leftMargin,
    curY
  );
  curY += 20;

  // Section 2: Faculty-wise NFA Activity Table
  doc.font(fonts.fontBold).fontSize(11).fillColor(CHRIST_BLUE).text(`SECTION 2: FACULTY-WISE NFA ACTIVITY (${summary.faculty_activity.length} Faculty Members)`, leftMargin, curY);
  curY += 16;

  if (summary.faculty_activity.length > 0) {
    const facKeys = ['sl_no', 'faculty_name', 'department', 'total_submitted', 'total_approved', 'total_pending', 'total_rejected', 'total_requested', 'total_approved_amount', 'events_completed'];
    curY = renderPdfTable(doc, facKeys, summary.faculty_activity, curY, pageWidth, pageHeight, leftMargin, rightMargin, fonts);
  } else {
    doc.font(fonts.fontRegular).fontSize(9).fillColor('#64748B').text('No active faculty submissions found for this organization in the selected academic year.', leftMargin, curY);
    curY += 24;
  }

  // Section 3: Detailed NFA Proposals Table
  if (curY + 60 > pageHeight - 45) {
    doc.addPage();
    curY = 36;
  } else {
    curY += 20;
  }

  doc.font(fonts.fontBold).fontSize(11).fillColor(CHRIST_BLUE).text(`SECTION 3: DETAILED NFA PROPOSALS (${summary.detailed_nfas.length} Records)`, leftMargin, curY);
  curY += 16;

  if (summary.detailed_nfas.length > 0) {
    const nfaKeys = ['sl_no', 'ref_no', 'date', 'proposer', 'department', 'title', 'type', 'requested_amount', 'approved_amount', 'status', 'completion_status'];
    curY = renderPdfTable(doc, nfaKeys, summary.detailed_nfas, curY, pageWidth, pageHeight, leftMargin, rightMargin, fonts);
  } else {
    doc.font(fonts.fontRegular).fontSize(9).fillColor('#64748B').text('No submitted NFA proposals found matching criteria.', leftMargin, curY);
  }

  // Render footers safely without blank pages
  renderPdfFooters(doc, leftMargin, contentWidth, pageHeight, fonts);
  doc.end();
});

/**
 * POST or GET /api/reports/export/:reportType/pdf
 * Official CHRIST University Report PDF Generation (14 Reports)
 */
reportsRouter.all('/export/:reportType/pdf', (req: AuthedRequest, res: Response) => {
  const { reportType } = req.params;
  const user = req.user!;
  const filters = { ...(req.query || {}), ...(req.body || {}) };
  const data = getReportDataset(reportType, user, filters);
  const resolution = resolveAuthorizedScope(user, filters);

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margins: { top: 36, bottom: 20, left: 36, right: 36 },
    bufferPages: true,
  });

  const fonts = registerUnicodeFonts(doc);

  const filename = `CU_Report_${reportType}_${Date.now()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const leftMargin = 36;
  const rightMargin = 36;
  const contentWidth = pageWidth - leftMargin - rightMargin;

  let curY = drawOfficialHeader(
    doc,
    reportType.replace(/_/g, ' '),
    user,
    leftMargin,
    contentWidth,
    resolution.financialYear.label,
    fonts
  );

  if (reportType === 'school_budget') {
    // Multi-section school report
    const targetSchool = filters.school || filters.targetId || filters.id || resolution.selectedSchool?.id || 'SOET';
    const bundle = getSchoolReportBundle(targetSchool, user, resolution.financialYear.id);

    doc.font(fonts.fontBold).fontSize(11).fillColor(CHRIST_BLUE).text(`SECTION 1: ${bundle.overview.school_name.toUpperCase()} OVERVIEW & METRICS`, leftMargin, curY);
    curY += 16;

    // KPI box
    doc.rect(leftMargin, curY, contentWidth, 44).fillColor('#F1F5F9').strokeColor(BORDER_LIGHT).lineWidth(1).fillAndStroke();
    const kpiCol = Math.floor(contentWidth / 4);
    const kpis = [
      { l: 'Allocated Budget', v: formatPdfCurrency(bundle.overview.allocated_budget, fonts.hasUnicode), c: CHRIST_BLUE },
      { l: 'Approved Expenses', v: formatPdfCurrency(bundle.overview.approved_expenditure, fonts.hasUnicode), c: '#16A34A' },
      { l: 'Active Reservations', v: formatPdfCurrency(bundle.overview.pending_reservations, fonts.hasUnicode), c: '#CA8A04' },
      { l: 'Remaining Balance', v: formatPdfCurrency(bundle.overview.available_balance, fonts.hasUnicode), c: '#0284C7' },
    ];
    kpis.forEach((k, idx) => {
      doc.font(fonts.fontBold).fontSize(7.5).fillColor('#64748B').text(k.l.toUpperCase(), leftMargin + idx * kpiCol + 8, curY + 8);
      doc.font(fonts.fontBold).fontSize(13).fillColor(k.c).text(k.v, leftMargin + idx * kpiCol + 8, curY + 22);
    });
    curY += 56;

    doc.font(fonts.fontBold).fontSize(11).fillColor(CHRIST_BLUE).text('SECTION 2: DEPARTMENT-WISE FINANCIAL & APPROVAL STATUS', leftMargin, curY);
    curY += 16;

    const deptKeys = ['sl_no', 'department_code', 'total_nfas', 'approved_nfas', 'pending_nfas', 'allocated', 'approved', 'pending', 'available', 'utilization'];
    curY = renderPdfTable(doc, deptKeys, bundle.departments, curY, pageWidth, pageHeight, leftMargin, rightMargin, fonts);
  } else {
    // Standard 14 report table
    if (data.length === 0) {
      doc.font(fonts.fontRegular).fontSize(10).fillColor(TEXT_DARK).text('No records found matching the requested reporting criteria.', leftMargin, curY);
    } else {
      const keys = Object.keys(data[0]);
      curY = renderPdfTable(doc, keys, data, curY, pageWidth, pageHeight, leftMargin, rightMargin, fonts);
    }
  }

  // Footer on all pages with zero blank pages
  renderPdfFooters(doc, leftMargin, contentWidth, pageHeight, fonts);
  doc.end();
});

// ==========================================
// 5. PROFESSIONAL EXCEL REPORT GENERATOR
// ==========================================

function styleWorksheet(ws: ExcelJS.Worksheet, keys: string[], rows: any[]) {
  // Setup auto-fit columns with sensible bounds
  ws.columns = keys.map((k) => {
    let maxLen = k.length + 4;
    rows.forEach((r) => {
      const v = r[k];
      const str = typeof v === 'number' ? v.toLocaleString('en-IN') : String(v || '');
      if (str.length > maxLen) maxLen = str.length;
    });
    return {
      header: k.replace(/_/g, ' ').toUpperCase(),
      key: k,
      width: Math.min(Math.max(maxLen + 3, 12), 42),
    };
  });

  // Freeze top row
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Autofilters
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: keys.length } };
  }

  // Style Header Row
  const headerRow = ws.getRow(1);
  headerRow.height = 24;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF003D8F' }, // Official CHRIST Blue
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // Add Data Rows
  rows.forEach((r) => {
    ws.addRow(r);
  });

  // Style Data Rows & Cell Alignment
  ws.eachRow((r, rowNumber) => {
    if (rowNumber > 1) {
      r.height = 20;
      if (rowNumber % 2 === 0) {
        r.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8FAFC' },
        };
      }
      keys.forEach((k, colIdx) => {
        const cell = r.getCell(colIdx + 1);
        if (isCurrencyKey(k) && typeof cell.value === 'number') {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFmt = '₹#,##0.00';
        } else if (typeof cell.value === 'number') {
          cell.alignment = { vertical: 'middle', horizontal: k === 'sl_no' || k === 's_no' ? 'center' : 'right' };
          cell.numFmt = '#,##0';
        } else if (k === 'sl_no' || k.includes('date') || k === 'status') {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        }
      });
    }
  });
}

/**
 * POST or GET /api/reports/summary/export/excel
 * Generates official multi-sheet Executive Summary Excel Workbook
 */
reportsRouter.all('/summary/export/excel', async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const filters = { ...(req.query || {}), ...(req.body || {}) };
  const summary = getExecutiveSummaryData(user, filters);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CHRIST (Deemed to be University) NFA System';
  wb.created = new Date();

  // Sheet 1: Executive Overview
  const wsOverview = wb.addWorksheet('Executive Overview');
  const overviewRows = [
    { metric: 'Organization', value: `${summary.org_name} (${summary.org_code})` },
    { metric: 'Scope', value: summary.scope.toUpperCase() },
    { metric: 'Academic Year', value: summary.financial_year },
    { metric: 'Allocated Budget', value: summary.metrics.allocated },
    { metric: 'Approved Expenditure', value: summary.metrics.approved },
    { metric: 'Active Reservations (Pending)', value: summary.metrics.pending },
    { metric: 'Available Balance', value: summary.metrics.available },
    { metric: 'Total Submitted NFAs', value: summary.metrics.total_nfas },
    { metric: 'Approved NFAs', value: summary.metrics.approved_nfas },
    { metric: 'Pending Review NFAs', value: summary.metrics.pending_nfas },
    { metric: 'Rejected NFAs', value: summary.metrics.rejected_nfas },
    { metric: 'Event NFAs Count', value: summary.metrics.event_nfas_count },
    { metric: 'Events Completed', value: summary.metrics.events_completed_count },
    { metric: 'Purchase NFAs Count', value: summary.metrics.purchase_nfas_count },
    { metric: 'Total Recorded Revenue', value: summary.metrics.total_revenue },
    { metric: 'Verified Revenue', value: summary.metrics.verified_revenue },
    { metric: 'Invoices Paid', value: summary.metrics.invoices_paid },
    { metric: 'Invoices Pending Payment', value: summary.metrics.invoices_pending },
  ];
  styleWorksheet(wsOverview, ['metric', 'value'], overviewRows);

  // Sheet 2: Faculty-wise Activity
  const wsFaculty = wb.addWorksheet('Faculty-wise Activity');
  if (summary.faculty_activity.length > 0) {
    styleWorksheet(wsFaculty, Object.keys(summary.faculty_activity[0]), summary.faculty_activity);
  } else {
    wsFaculty.addRow(['No active faculty submissions found for this organization']);
  }

  // Sheet 3: Detailed NFAs
  const wsNfas = wb.addWorksheet('Detailed NFAs');
  if (summary.detailed_nfas.length > 0) {
    styleWorksheet(wsNfas, Object.keys(summary.detailed_nfas[0]), summary.detailed_nfas);
  } else {
    wsNfas.addRow(['No submitted NFA proposals found matching criteria']);
  }

  // Sheet 4: Categories Breakdown (if available)
  if (summary.categories && summary.categories.length > 0) {
    const wsCats = wb.addWorksheet('Category Budgets');
    styleWorksheet(wsCats, Object.keys(summary.categories[0]), summary.categories);
  }

  const filename = `CU_Executive_Summary_${summary.org_code}_${Date.now()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
});

/**
 * POST or GET /api/reports/export/:reportType/excel
 * Excel Workbook Generation using ExcelJS (14 Reports)
 */
reportsRouter.all('/export/:reportType/excel', async (req: AuthedRequest, res: Response) => {
  const { reportType } = req.params;
  const user = req.user!;
  const filters = { ...(req.query || {}), ...(req.body || {}) };
  const data = getReportDataset(reportType, user, filters);
  const resolution = resolveAuthorizedScope(user, filters);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CHRIST (Deemed to be University) NFA System';
  wb.created = new Date();

  if (reportType === 'school_budget') {
    const targetSchool = filters.school || filters.targetId || filters.id || resolution.selectedSchool?.id || 'SOET';
    const bundle = getSchoolReportBundle(targetSchool, user, resolution.financialYear.id);

    // Sheet 1: School Summary
    const wsSummary = wb.addWorksheet('School Summary');
    styleWorksheet(wsSummary, Object.keys(bundle.overview), [bundle.overview]);

    // Sheet 2: Department Details
    const wsDepts = wb.addWorksheet('Department Details');
    styleWorksheet(wsDepts, Object.keys(bundle.departments[0] || {}), bundle.departments);

    // Sheet 3: Faculty & NFA Activity
    const wsFaculty = wb.addWorksheet('Faculty & NFA Activity');
    styleWorksheet(wsFaculty, Object.keys(bundle.faculty_nfas[0] || { sl_no: 1, records: 'None' }), bundle.faculty_nfas);

    // Sheet 4: Event Activity
    const wsEvents = wb.addWorksheet('Event Activity');
    styleWorksheet(wsEvents, Object.keys(bundle.events[0] || { sl_no: 1, records: 'None' }), bundle.events);

    // Sheet 5: Budget Details
    const wsBudgets = wb.addWorksheet('Budget Details');
    styleWorksheet(wsBudgets, Object.keys(bundle.budgets[0] || { sl_no: 1, records: 'None' }), bundle.budgets);

    // Sheet 6: Revenue & Earnings
    const wsRevenues = wb.addWorksheet('Revenue & Earnings');
    styleWorksheet(wsRevenues, Object.keys(bundle.revenues[0] || { sl_no: 1, records: 'None' }), bundle.revenues);

    // Sheet 7: Purchase Invoices
    const wsInvoices = wb.addWorksheet('Purchase Invoices');
    styleWorksheet(wsInvoices, Object.keys(bundle.invoices[0] || { sl_no: 1, records: 'None' }), bundle.invoices);
  } else {
    // Single sheet standard report
    const ws = wb.addWorksheet(reportType.replace(/_/g, ' ').slice(0, 30));
    if (data.length > 0) {
      styleWorksheet(ws, Object.keys(data[0]), data);
    } else {
      ws.addRow(['No records available for the selected criteria']);
    }
  }

  const filename = `CU_Report_${reportType}_${Date.now()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
});
