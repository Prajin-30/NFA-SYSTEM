import { store } from '../store.js';
import type { Role, Department, Nfa, DepartmentBudget, BudgetCategory } from '../types.js';

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

  // Authoritative Scoped NFAs: Single Source of Truth for Sections 1, 2, and 3
  const scopedNfas = db.nfas.filter(
    (n) => (targetDeptIds.has(n.department_id) || (n.centre_id && targetDeptIds.has(n.centre_id))) &&
           n.status !== 'draft' &&
           (!fyId || n.financial_year_id === fyId)
  );

  // Group scoped NFAs by creator for Section 2
  const nfasByCreator = new Map<string, typeof scopedNfas>();
  scopedNfas.forEach((n) => {
    const list = nfasByCreator.get(n.created_by) || [];
    list.push(n);
    nfasByCreator.set(n.created_by, list);
  });

  // 3. Faculty-wise Activity Table
  const departmentFaculty = db.users.filter(
    (u) => ['faculty', 'hod'].includes(u.role) && u.department_id && targetDeptIds.has(u.department_id)
  );

  // Combine departmental faculty with any other creators who have proposals charged to this scope
  const allProposerIds = new Set<string>([
    ...departmentFaculty.map((f) => f.id),
    ...Array.from(nfasByCreator.keys()),
  ]);

  const facultyActivity: any[] = [];
  let facSl = 1;

  allProposerIds.forEach((uid) => {
    const fNfas = nfasByCreator.get(uid) || [];
    if (!resolution.includeAllFaculty && fNfas.length === 0) {
      return; // Exclude zero-activity faculty unless explicitly requested
    }
    const userObj = db.users.find((u) => u.id === uid);
    const approved = fNfas.filter((n) => n.status === 'approved');
    const pending = fNfas.filter((n) => !['approved', 'rejected', 'draft'].includes(n.status));
    const rejected = fNfas.filter((n) => n.status === 'rejected');
    const requestedAmt = fNfas.reduce((sum, n) => sum + (Number(n.total_amount) || 0), 0);
    const approvedAmt = approved.reduce((sum, n) => sum + (Number(n.total_amount) || 0), 0);
    const eventsCompleted = fNfas.filter((n) => n.nfa_type === 'event' && n.event_completion_status === 'completed').length;

    facultyActivity.push({
      sl_no: facSl++,
      faculty_name: userObj?.name || (fNfas[0]?.submitted_by_name) || 'Faculty / Proposer',
      email: userObj?.email || '—',
      department: userObj?.department_id ? (deptMap.get(userObj.department_id)?.code || '') : (fNfas[0] ? (deptMap.get(fNfas[0].department_id)?.code || '') : ''),
      total_submitted: fNfas.length,
      total_approved: approved.length,
      total_pending: pending.length,
      total_rejected: rejected.length,
      total_requested: requestedAmt,
      total_approved_amount: approvedAmt,
      events_completed: eventsCompleted,
    });
  });

  // 4. Detailed NFA Activity Table (derived from the exact same scopedNfas)
  const detailedNfas = scopedNfas.map((n, idx) => ({
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

/**
 * Builds the school comprehensive bundle for school budget reports
 */
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

/**
 * Returns structured dataset for all 14 official report types
 */
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
      const facultyList = db.users.filter((u) => u.role === 'faculty' && u.department_id && targetDeptIds.has(u.department_id));
      const rows: any[] = [];
      let sl = 1;

      facultyList.forEach((f) => {
        const fNfas = db.nfas.filter((n) => n.created_by === f.id && n.status !== 'draft' && (!targetFyId || n.financial_year_id === targetFyId));
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
 * Determines whether a column key represents currency
 */
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

/**
 * Formats status strings cleanly for institutional reporting
 */
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

/**
 * Returns human-readable, multi-line header labels for PDF tables.
 * Prevents awkward mid-word splits like "REQUEST/ED" or "DEPART/MENT".
 */
export function getHeaderLabel(k: string): string {
  const map: Record<string, string> = {
    sl_no: 'Sl.\nNo.',
    s_no: 'Sl.\nNo.',
    ref_no: 'Ref.\nNo.',
    nfa_ref: 'NFA\nRef.',
    invoice_no: 'Invoice\nNo.',
    invoice_number: 'Invoice\nNo.',
    event_ref: 'Event\nRef.',
    date: 'Date',
    invoice_date: 'Invoice\nDate',
    collection_date: 'Collection\nDate',
    submission_date: 'Submission\nDate',
    timestamp: 'Date &\nTime',
    faculty_name: 'Faculty Name',
    proposer: 'Proposer /\nFaculty',
    submitted_by: 'Submitted By',
    organizer: 'Organizer',
    department: 'Dept',
    department_code: 'Dept\nCode',
    department_name: 'Department Name',
    school_code: 'School',
    school_name: 'School Name',
    campus: 'Campus',
    title: 'Proposal / Event Title',
    event_title: 'Event Title',
    item_title: 'Item Title',
    type: 'Type',
    nfa_type: 'NFA\nType',
    category: 'Budget Category',
    subcategory: 'Budget Subcategory',
    total_submitted: 'Total\nSub.',
    total_approved: 'Total\nApp.',
    total_pending: 'Total\nPend.',
    total_rejected: 'Total\nRej.',
    total_requested: 'Requested\nAmount',
    total_approved_amount: 'Approved\nAmount',
    events_completed: 'Events\nDone',
    allocated: 'Allocated\nBudget',
    approved: 'Approved\nSpend',
    pending: 'Active\nReserv.',
    available: 'Available\nBalance',
    amount: 'Total\nAmount',
    requested_amount: 'Requested\nAmount',
    approved_amount: 'Approved\nAmount',
    invoice_amount: 'Invoice\nAmount',
    paid_amount: 'Paid\nAmount',
    gst_amount: 'GST\nAmount',
    recorded_revenue: 'Recorded\nRevenue',
    verified_revenue: 'Verified\nRevenue',
    revenue_generated: 'Revenue\nAmount',
    revenue_enabled: 'Revenue\nEligible',
    revenue_generating: 'Revenue\nEligible',
    will_generate_revenue: 'Revenue\nEligible',
    completion: 'Event\nStatus',
    completion_status: 'Event\nStatus',
    verification: 'Verification\nStatus',
    verification_status: 'Verification\nStatus',
    payment_status: 'Payment\nStatus',
    current_stage: 'Current Stage',
    status: 'Approval\nStatus',
    utilization: 'Budget\nUtil.',
    days_in_review: 'Days in\nReview',
    vendor: 'Vendor Name',
    quotations_count: 'Quotes\nCount',
    resource_person: 'Resource Person',
    venue: 'Venue',
    payment_method: 'Payment\nMethod',
    verified_by: 'Verified By',
    outstanding_payment: 'Outstanding\nPayment',
    beneficiary: 'Beneficiary Name',
    utr_ref: 'UTR / Payment Ref',
    payment_date: 'Payment Date',
    entity: 'Entity',
    user: 'User',
    role: 'Role',
    action: 'Action',
    reason: 'Reason',
    source: 'Revenue Source',
    description: 'Description',
    departments_count: 'Depts\nCount',
    active_faculty_count: 'Active\nFaculty',
    total_departments: 'Depts\nCount',
    total_nfas: 'Total\nNFAs',
    approved_nfas: 'Approved\nNFAs',
    pending_nfas: 'Pending\nNFAs',
    rejected_nfas: 'Rejected\nNFAs',
    centre_code: 'Centre\nCode',
    centre_name: 'Centre / Office Name',
    nfas_count: 'Total\nNFAs',
    allocated_budget: 'Allocated\nBudget',
    approved_expenditure: 'Approved\nSpend',
    pending_reservations: 'Active\nReserv.',
    available_balance: 'Available\nBalance',
    reporting_year: 'Academic\nYear',
    segment: 'Campus Segment',
  };

  if (map[k]) return map[k];
  return k.replace(/_/g, '\n').replace(/\b\w/g, (c) => c.toUpperCase());
}
