import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import { store } from '../store.js';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth.js';
import { availableAmount } from '../lib/budgetEngine.js';
import {
  exportBudgetReportExcel,
  generateBlankBudgetTemplateExcel,
  parseAndLoadMasterBudgetExcel,
} from '../lib/excel.js';

export const budgetsRouter = Router();
budgetsRouter.use(requireAuth);
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Helper to compute next financial year label: e.g. "2026-27" -> "2027-28"
 */
function getNextFinancialYearLabel(currentLabel: string): string {
  const match = currentLabel.match(/^(\d{4})[-/](\d{2,4})$/);
  if (match) {
    const startYear = parseInt(match[1], 10) + 1;
    const endYearPart = match[2];
    if (endYearPart.length === 2) {
      const endYear = (parseInt(endYearPart, 10) + 1) % 100;
      return `${startYear}-${String(endYear).padStart(2, '0')}`;
    } else {
      const endYear = parseInt(endYearPart, 10) + 1;
      return `${startYear}-${endYear}`;
    }
  }
  const curr = new Date().getFullYear();
  return `${curr + 1}-${String((curr + 2) % 100).padStart(2, '0')}`;
}

/** GET /api/budgets/departments - reference data */
budgetsRouter.get('/departments', (_req, res) => res.json(store.data.departments));

/** GET /api/budgets/financial-years - reference data */
budgetsRouter.get('/financial-years', (_req, res) => res.json(store.data.financial_years));

/** GET /api/budgets/categories - reference data with subcategories */
budgetsRouter.get('/categories', (_req, res) => {
  const subcats = store.data.budget_subcategories || [];
  const list = store.data.budget_categories.map((c) => ({
    ...c,
    subcategories: subcats.filter((s) => s.budget_category_id === c.id),
  }));
  res.json(list);
});

/** GET /api/budgets/subcategories?category= */
budgetsRouter.get('/subcategories', (req, res) => {
  let list = store.data.budget_subcategories || [];
  if (req.query.category) list = list.filter((s) => s.budget_category_id === req.query.category);
  res.json(list);
});

/** GET /api/budgets/template — Admin-only: download clean budget template Excel */
budgetsRouter.get('/template', requireRole('super_admin'), async (_req, res) => {
  try {
    await generateBlankBudgetTemplateExcel(res);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to generate budget template' });
  }
});

/**
 * POST /api/budgets/upload-master-excel — Admin-only: upload private university Excel workbook
 * Automatically parses sheets, maps categories, and sets live budget allocations.
 */
budgetsRouter.post('/upload-master-excel', requireRole('super_admin'), upload.single('file'), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: 'Excel file (.xlsx) is required' });
  const mode = req.body.mode === 'merge' ? 'merge' : 'replace';
  const fyId = String(req.body.financial_year_id || store.data.financial_years.find((f) => f.is_active)?.id || store.data.financial_years[0]?.id);

  try {
    let resultSummary: any;
    await store.transact(async (db) => {
      resultSummary = await parseAndLoadMasterBudgetExcel(req.file!.buffer, db, { mode, financial_year_id: fyId });
      db.audit_logs.push({
        id: uuid(),
        entity_type: 'department_budget',
        entity_id: fyId,
        department_id: 'ALL',
        old_amount: null,
        new_amount: resultSummary.total_allocated,
        difference: resultSummary.total_allocated,
        changed_by: req.user!.id,
        role: req.user!.role,
        reason: `Private University Budget Master Upload (${mode} mode): Processed ${resultSummary.items_processed} items across ${resultSummary.departments_count} departments and ${resultSummary.categories_count} categories. Total allocation: ₹${resultSummary.total_allocated.toLocaleString('en-IN')}`,
        source: 'excel',
        approval_status: 'approved',
        created_at: new Date().toISOString(),
      });
    });
    res.json({ success: true, ...resultSummary });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to parse and load budget workbook' });
  }
});

/**
 * GET /api/budgets/rollover-preview — Simulate & preview next financial year budget allocation
 */
budgetsRouter.get('/rollover-preview', (req: AuthedRequest, res) => {
  const sourceFyId = String(req.query.source_fy || store.data.financial_years.find((f) => f.is_active)?.id || store.data.financial_years[0]?.id);
  const sourceFy = store.data.financial_years.find((f) => f.id === sourceFyId);
  if (!sourceFy) return res.status(404).json({ error: 'Source financial year not found' });

  const percentage = Number(req.query.percentage ?? 8);
  const carryForward = req.query.carry_forward === 'true';
  const targetLabel = String(req.query.target_label || getNextFinancialYearLabel(sourceFy.label));

  const lines = store.data.department_budgets.filter((b) => b.financial_year_id === sourceFy.id);
  
  let currentTotalAllocated = 0;
  let currentTotalApproved = 0;
  let currentTotalPending = 0;
  let currentTotalUnspent = 0;
  let projectedTotalAllocated = 0;

  const departmentBreakdown = store.data.departments.map((dept) => {
    const deptLines = lines.filter((b) => b.department_id === dept.id);
    const categoryRows = deptLines.map((line) => {
      const cat = store.data.budget_categories.find((c) => c.id === line.budget_category_id);
      const unspent = Math.max(0, line.allocated_amount - line.approved_amount);
      const growthComponent = Math.round(line.allocated_amount * (percentage / 100));
      const carryComponent = carryForward ? unspent : 0;
      const projectedAllocated = line.allocated_amount + growthComponent + carryComponent;

      currentTotalAllocated += line.allocated_amount;
      currentTotalApproved += line.approved_amount;
      currentTotalPending += line.pending_amount;
      currentTotalUnspent += unspent;
      projectedTotalAllocated += projectedAllocated;

      return {
        category_id: line.budget_category_id,
        category_name: cat?.name || 'Uncategorized',
        current_allocated: line.allocated_amount,
        current_approved: line.approved_amount,
        current_pending: line.pending_amount,
        current_unspent: unspent,
        growth_amount: growthComponent,
        carry_amount: carryComponent,
        projected_allocated: projectedAllocated,
        projected_diff: projectedAllocated - line.allocated_amount,
      };
    });

    const deptCurrentAlloc = categoryRows.reduce((s, r) => s + r.current_allocated, 0);
    const deptProjectedAlloc = categoryRows.reduce((s, r) => s + r.projected_allocated, 0);

    return {
      department_id: dept.id,
      department_name: dept.name,
      department_code: dept.code,
      current_allocated: deptCurrentAlloc,
      projected_allocated: deptProjectedAlloc,
      difference: deptProjectedAlloc - deptCurrentAlloc,
      categories: categoryRows,
    };
  });

  res.json({
    source_fy: sourceFy,
    target_label: targetLabel,
    percentage,
    carry_forward: carryForward,
    totals: {
      current_allocated: currentTotalAllocated,
      current_approved: currentTotalApproved,
      current_pending: currentTotalPending,
      current_unspent: currentTotalUnspent,
      projected_allocated: projectedTotalAllocated,
      projected_growth: projectedTotalAllocated - currentTotalAllocated,
      growth_pct: currentTotalAllocated > 0 ? Math.round(((projectedTotalAllocated - currentTotalAllocated) / currentTotalAllocated) * 100) : percentage,
    },
    departments: departmentBreakdown,
  });
});

/**
 * POST /api/budgets/rollover — Execute annual budget transition to next financial year
 */
budgetsRouter.post('/rollover', requireRole('director', 'finance', 'super_admin'), async (req: AuthedRequest, res) => {
  const { source_fy_id, target_label, percentage = 8, carry_forward = false, set_active = true } = req.body || {};
  const pct = Number(percentage) || 0;
  const carry = Boolean(carry_forward);

  const result = await store.transact((db) => {
    const sourceFy = db.financial_years.find((f) => f.id === source_fy_id) || db.financial_years.find((f) => f.is_active) || db.financial_years[0];
    if (!sourceFy) return { error: 404 as const, msg: 'Source financial year not found' };

    const label = target_label || getNextFinancialYearLabel(sourceFy.label);

    let targetFy = db.financial_years.find((f) => f.label.toLowerCase() === label.toLowerCase());
    if (!targetFy) {
      targetFy = {
        id: uuid(),
        label,
        is_active: false,
      };
      db.financial_years.push(targetFy);
    }

    if (set_active) {
      db.financial_years.forEach((f) => {
        f.is_active = f.id === targetFy!.id;
      });
    }

    const sourceLines = db.department_budgets.filter((b) => b.financial_year_id === sourceFy.id);
    let createdCount = 0;
    let updatedCount = 0;
    let totalNewAllocated = 0;

    sourceLines.forEach((sLine) => {
      const unspent = Math.max(0, sLine.allocated_amount - sLine.approved_amount);
      const growth = Math.round(sLine.allocated_amount * (pct / 100));
      const carryAmount = carry ? unspent : 0;
      const newAllocated = sLine.allocated_amount + growth + carryAmount;
      totalNewAllocated += newAllocated;

      const existing = db.department_budgets.find(
        (b) => b.department_id === sLine.department_id && b.financial_year_id === targetFy!.id && b.budget_category_id === sLine.budget_category_id
      );

      if (existing) {
        existing.allocated_amount = newAllocated;
        existing.approved_amount = 0;
        existing.pending_amount = 0;
        existing.revised_amount = 0;
        updatedCount++;
      } else {
        db.department_budgets.push({
          id: uuid(),
          department_id: sLine.department_id,
          financial_year_id: targetFy!.id,
          budget_category_id: sLine.budget_category_id,
          allocated_amount: newAllocated,
          approved_amount: 0,
          pending_amount: 0,
          revised_amount: 0,
        });
        createdCount++;
      }
    });

    if (db.budget_subcategories) {
      db.budget_subcategories.forEach((sub) => {
        const growth = Math.round(sub.allocated_amount * (pct / 100));
        sub.allocated_amount += growth;
        sub.approved_amount = 0;
        sub.pending_amount = 0;
      });
    }

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'department_budget',
      entity_id: targetFy.id,
      department_id: 'ALL',
      old_amount: null,
      new_amount: totalNewAllocated,
      difference: totalNewAllocated,
      changed_by: req.user!.id,
      role: req.user!.role,
      reason: `Annual Institutional Budget Rollover: Transitioned to Academic/Financial Year ${targetFy.label} with ${pct}% increment${carry ? ' + unspent balance carried forward' : ''}.`,
      source: 'portal',
      approval_status: 'approved',
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      target_fy: targetFy,
      created_count: createdCount,
      updated_count: updatedCount,
      total_allocated: totalNewAllocated,
    };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });
  res.json(result);
});

/**
 * POST /api/budgets/switch-active-fy — Switch active financial year across portal
 */
budgetsRouter.post('/switch-active-fy', requireRole('director', 'finance', 'super_admin'), async (req: AuthedRequest, res) => {
  const { financial_year_id } = req.body || {};
  if (!financial_year_id) return res.status(400).json({ error: 'financial_year_id is required' });

  const result = await store.transact((db) => {
    const fy = db.financial_years.find((f) => f.id === financial_year_id);
    if (!fy) return { error: 404 as const, msg: 'Financial year not found' };
    db.financial_years.forEach((f) => {
      f.is_active = f.id === fy.id;
    });
    return { active_fy: fy };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });
  res.json(result);
});

/** GET /api/budgets/export/all — Admin-only: Export all departments master budget */
budgetsRouter.get('/export/all', requireRole('super_admin'), async (req, res) => {
  const fy = String(req.query.fy || store.data.financial_years.find((f) => f.is_active)?.id);
  try {
    await exportBudgetReportExcel(res, store.data, undefined, fy);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to export master budget report' });
  }
});

/** GET /api/budgets/export/:department?fy=... — Admin-only: Excel export */
budgetsRouter.get('/export/:department', requireRole('super_admin'), async (req, res) => {
  const fy = String(req.query.fy || store.data.financial_years.find((f) => f.is_active)?.id);
  try {
    await exportBudgetReportExcel(res, store.data, req.params.department, fy);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to export budget workbook' });
  }
});

/**
 * PUT /api/budgets/subcategory/:id — Admin-only: adjust subcategory allocation or name
 */
budgetsRouter.put('/subcategory/:id', requireRole('super_admin'), async (req, res) => {
  const { allocated_amount, name } = req.body || {};
  const updated = await store.transact((db) => {
    if (!db.budget_subcategories) db.budget_subcategories = [];
    const sub = db.budget_subcategories.find((s) => s.id === req.params.id);
    if (!sub) throw new Error('not_found');
    if (typeof allocated_amount === 'number' && allocated_amount >= 0) sub.allocated_amount = allocated_amount;
    if (name && typeof name === 'string') sub.name = name.trim();
    return sub;
  }).catch((e) => (e.message === 'not_found' ? null : Promise.reject(e)));
  if (!updated) return res.status(404).json({ error: 'Subcategory not found' });
  res.json(updated);
});

/**
 * GET /api/budgets/:department/summary?fy=<financial_year_id>
 * Master department budget view: allocated / approved / pending / available per category and subcategory.
 */
budgetsRouter.get('/:department/summary', (req: AuthedRequest, res) => {
  const deptParam = req.params.department;
  const dept = store.data.departments.find((d) => d.id === deptParam || d.code.toLowerCase() === deptParam.toLowerCase());
  const deptId = dept ? dept.id : deptParam;

  let fyId = String(req.query.fy || store.data.financial_years.find((f) => f.is_active)?.id);
  const fyObj = store.data.financial_years.find((f) => f.id === fyId || f.label === fyId);
  if (fyObj) fyId = fyObj.id;

  const lines = store.data.department_budgets.filter((b) => b.department_id === deptId && b.financial_year_id === fyId);
  const allSubcats = store.data.budget_subcategories || [];
  const out = lines.map((line) => {
    const cat = store.data.budget_categories.find((c) => c.id === line.budget_category_id);
    const avail = availableAmount(line);
    const allocated = line.allocated_amount > 0 ? line.allocated_amount : 1;
    const utilPct = Math.round(((line.approved_amount + line.pending_amount) / allocated) * 100);
    const subcats = allSubcats
      .filter((s) => s.budget_category_id === line.budget_category_id)
      .map((s) => {
        const subAlloc = s.allocated_amount > 0 ? s.allocated_amount : 1;
        const subAvail = s.allocated_amount - s.approved_amount - s.pending_amount;
        const subUtil = Math.round(((s.approved_amount + s.pending_amount) / subAlloc) * 100);
        return {
          ...s,
          available_amount: subAvail,
          utilization_pct: subUtil,
        };
      });

    return {
      ...line,
      category_name: cat ? cat.name : 'General Category',
      available_amount: avail,
      utilization_pct: utilPct,
      status: utilPct >= 100 ? 'exceeded' : utilPct >= 80 ? 'warning' : 'healthy',
      subcategories: subcats,
    };
  });
  const totals = out.reduce(
    (acc, l) => ({
      allocated_amount: acc.allocated_amount + l.allocated_amount,
      approved_amount: acc.approved_amount + l.approved_amount,
      pending_amount: acc.pending_amount + l.pending_amount,
      available_amount: acc.available_amount + l.available_amount,
    }),
    { allocated_amount: 0, approved_amount: 0, pending_amount: 0, available_amount: 0 }
  );
  const totalAlloc = totals.allocated_amount > 0 ? totals.allocated_amount : 1;
  const totalUtilPct = Math.round(((totals.approved_amount + totals.pending_amount) / totalAlloc) * 100);
  res.json({ lines: out, totals: { ...totals, utilization_pct: totalUtilPct } });
});

/** GET /api/budgets/:department - raw budget lines (all financial years) */
budgetsRouter.get('/:department', (req, res) => {
  const deptParam = req.params.department;
  const dept = store.data.departments.find((d) => d.id === deptParam || d.code.toLowerCase() === deptParam.toLowerCase());
  const deptId = dept ? dept.id : deptParam;
  res.json(store.data.department_budgets.filter((b) => b.department_id === deptId));
});

/**
 * PUT /api/budgets/:id — Super Admin only: adjust a category budget line
 */
budgetsRouter.put('/:id', requireRole('super_admin'), async (req, res) => {
  const { allocated_amount, category_name } = req.body || {};
  if (allocated_amount !== undefined && (typeof allocated_amount !== 'number' || allocated_amount < 0)) {
    return res.status(400).json({ error: 'allocated_amount must be a non-negative number' });
  }
  const updated = await store.transact((db) => {
    let line = db.department_budgets.find((b) => b.id === req.params.id);
    if (!line) {
      const cat = db.budget_categories.find((c) => c.id === req.params.id);
      if (cat) {
        if (category_name && typeof category_name === 'string') cat.name = category_name.trim();
        line = db.department_budgets.find((b) => b.budget_category_id === cat.id);
      }
    }
    if (!line) throw new Error('not_found');
    if (allocated_amount !== undefined) line.allocated_amount = allocated_amount;
    if (category_name && typeof category_name === 'string') {
      const cat = db.budget_categories.find((c) => c.id === line.budget_category_id);
      if (cat) cat.name = category_name.trim();
    }
    return line;
  }).catch((e) => (e.message === 'not_found' ? null : Promise.reject(e)));
  if (!updated) return res.status(404).json({ error: 'Budget line not found' });
  res.json(updated);
});
