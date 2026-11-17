import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { v4 as uuid } from 'uuid';
import { store } from '../store.js';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth.js';
import {
  createInstitutionalAccount,
  validateUniversityEmail,
  resetTemporaryPassword,
  updateAccountActiveStatus,
  DEFAULT_FACULTY_ONBOARDING_PASSWORD,
} from '../services/supabaseAuth.js';
import type { Role } from '../types.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('super_admin'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max for Excel
});

/**
 * Checks whether an active HOD already exists for a department.
 */
function checkActiveHodUniqueness(departmentId: string, excludeUserId?: string): { allowed: boolean; existingHod?: any } {
  const existingHod = store.data.users.find(
    (u) =>
      u.role === 'hod' &&
      u.department_id === departmentId &&
      u.is_active !== false &&
      (!excludeUserId || u.id !== excludeUserId)
  );
  if (existingHod) {
    return { allowed: false, existingHod };
  }
  return { allowed: true };
}

/** POST /api/admin/financial-years — enforce uniqueness and format */
adminRouter.post('/financial-years', async (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Academic Year label is required, e.g. "2027-28"' });
  
  const result = await store.transact((db) => {
    const existing = db.financial_years.find((f) => f.label.toLowerCase() === label.toLowerCase());
    if (existing) {
      return { error: 409 as const, msg: `Academic / Financial Year '${label}' already exists.` };
    }
    const fy = { id: uuid(), label, is_active: false };
    db.financial_years.push(fy);
    return { fy };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });
  res.status(201).json(result.fy);
});

/** PUT /api/admin/financial-years/:id/activate — enforce single active academic year */
adminRouter.put('/financial-years/:id/activate', async (req, res) => {
  const result = await store.transact((db) => {
    const target = db.financial_years.find((f) => f.id === req.params.id);
    if (!target) return { error: 404 as const, msg: 'Academic Year not found' };
    db.financial_years.forEach((f) => {
      f.is_active = f.id === target.id;
    });
    return { active_fy: target };
  });

  if ('error' in result) return res.status(result.error).json({ error: result.msg });
  res.json(store.data.financial_years);
});

/** POST /api/admin/departments */
adminRouter.post('/departments', async (req, res) => {
  const { name, code, hod_name, dean_name, faculty_name, associate_dean_name, director_name, finance_officer_name } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
  const dept = { id: uuid(), name, code, hod_name, dean_name, faculty_name, associate_dean_name, director_name, finance_officer_name };
  await store.transact((db) => db.departments.push(dept));
  res.status(201).json(dept);
});

/** PUT /api/admin/departments/:id — update department and approval signer names. */
adminRouter.put('/departments/:id', async (req, res) => {
  const { name, code, hod_name, dean_name, faculty_name, associate_dean_name, director_name, finance_officer_name } = req.body || {};
  const updated = await store.transact((db) => {
    const dept = db.departments.find((d) => d.id === req.params.id);
    if (!dept) return null;
    if (name !== undefined) dept.name = String(name).trim();
    if (code !== undefined) dept.code = String(code).trim();
    if (hod_name !== undefined) dept.hod_name = String(hod_name).trim();
    if (dean_name !== undefined) dept.dean_name = String(dean_name).trim();
    if (faculty_name !== undefined) dept.faculty_name = String(faculty_name).trim();
    if (associate_dean_name !== undefined) dept.associate_dean_name = String(associate_dean_name).trim();
    if (director_name !== undefined) dept.director_name = String(director_name).trim();
    if (finance_officer_name !== undefined) dept.finance_officer_name = String(finance_officer_name).trim();
    return dept;
  });
  if (!updated) return res.status(404).json({ error: 'Department not found' });
  res.json(updated);
});

/** POST /api/admin/budget-types */
adminRouter.post('/budget-types', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const bt = { id: uuid(), name };
  await store.transact((db) => db.budget_types.push(bt));
  res.status(201).json(bt);
});

/** POST /api/admin/budget-categories */
adminRouter.post('/budget-categories', async (req, res) => {
  const { budget_type_id, name } = req.body || {};
  if (!budget_type_id || !name) return res.status(400).json({ error: 'budget_type_id and name are required' });
  const cat = { id: uuid(), budget_type_id, name };
  await store.transact((db) => db.budget_categories.push(cat));
  res.status(201).json(cat);
});

/**
 * POST /api/admin/department-budgets — allocate a category's budget for a dept/FY.
 */
adminRouter.post('/department-budgets', async (req, res) => {
  const { department_id, financial_year_id, budget_category_id, allocated_amount } = req.body || {};
  if (!department_id || !financial_year_id || !budget_category_id || typeof allocated_amount !== 'number') {
    return res.status(400).json({ error: 'department_id, financial_year_id, budget_category_id, allocated_amount are required' });
  }
  const line = { id: uuid(), department_id, financial_year_id, budget_category_id, allocated_amount, approved_amount: 0, pending_amount: 0, revised_amount: 0 };
  await store.transact((db) => db.department_budgets.push(line));
  res.status(201).json(line);
});

// =========================================================================
// SUPER ADMIN USER MANAGEMENT ENDPOINTS
// =========================================================================

/**
 * GET /api/admin/users
 * Returns system users with status, must_change_password, and department metadata.
 * Supports query filters: search, role, department_id.
 * Sensitive password hashes are never exposed.
 */
adminRouter.get('/users', (req, res) => {
  const { search, role, department_id } = req.query as Record<string, string>;

  let list = store.data.users.map((u) => {
    const dept = u.department_id ? store.data.departments.find((d) => d.id === u.department_id) : null;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      department_id: u.department_id,
      department_name: dept ? dept.name : (u.department_id ? 'Unknown Department' : 'Institution-wide'),
      department_code: dept ? dept.code : '',
      is_active: u.is_active !== false,
      must_change_password: Boolean(u.must_change_password),
      signature_image: u.signature_image || undefined,
      created_at: u.created_at,
    };
  });

  if (search) {
    const s = String(search).trim().toLowerCase();
    list = list.filter((u) => u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s));
  }
  if (role && role !== 'all') {
    list = list.filter((u) => u.role === role);
  }
  if (department_id && department_id !== 'all') {
    list = list.filter((u) => u.department_id === department_id);
  }

  res.json(list);
});

/**
 * POST /api/admin/users
 * Super Admin creates an individual institutional account.
 * Automatically generates a unique, cryptographically secure 14-char temporary password,
 * marks must_change_password = true, and returns the credentials once for delivery.
 */
adminRouter.post('/users', async (req: AuthedRequest, res) => {
  try {
    const { name, email, role, department_id } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Official Email ID is required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const domainCheck = validateUniversityEmail(cleanEmail);
    if (!domainCheck.valid) {
      return res.status(400).json({ error: domainCheck.error });
    }

    if (store.data.users.some((u) => u.email.toLowerCase() === cleanEmail)) {
      return res.status(409).json({ error: `An account with email '${cleanEmail}' already exists in the system.` });
    }

    const validRoles: Role[] = ['faculty', 'hod', 'associate_dean', 'dean', 'finance', 'director', 'super_admin'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role '${role}'. Supported roles: ${validRoles.join(', ')}` });
    }

    let deptId = department_id || null;
    if (['faculty', 'hod'].includes(role)) {
      if (!deptId) {
        return res.status(400).json({ error: `Department selection is required for role '${role}'` });
      }
      const dept = store.data.departments.find((d) => d.id === deptId);
      if (!dept) {
        return res.status(400).json({ error: 'Selected department does not exist' });
      }

      // Enforce single active HOD per department
      if (role === 'hod') {
        const hodCheck = checkActiveHodUniqueness(deptId);
        if (!hodCheck.allowed) {
          return res.status(409).json({
            error: `Department '${dept.name}' (${dept.code}) already has an active HOD: ${hodCheck.existingHod.name} (${hodCheck.existingHod.email}). A department cannot have more than one active HOD.`
          });
        }
      }
    }

    const { user, temporaryPassword } = await createInstitutionalAccount({
      name: name.trim(),
      email: cleanEmail,
      role,
      department_id: deptId,
      initialPassword: req.body?.initialPassword,
    });

    // Record audit trail
    await store.transact((db) => {
      db.audit_logs.push({
        id: uuid(),
        entity_type: 'user_account',
        entity_id: user.id,
        department_id: deptId || 'ALL',
        old_amount: null,
        new_amount: 0,
        difference: 0,
        changed_by: req.user!.id,
        role: req.user!.role,
        reason: `Super Admin provisioned user account: ${user.name} (${user.email}) as role '${user.role}'`,
        source: 'portal',
        approval_status: 'approved',
        created_at: new Date().toISOString(),
      });
    });

    return res.status(201).json({
      user,
      temporaryPassword,
      message: 'User account created successfully with unique temporary password.',
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Failed to create user account' });
  }
});

/**
 * PUT /api/admin/users/:id
 * Super Admin updates account metadata (name, email, role, department).
 */
adminRouter.put('/users/:id', async (req: AuthedRequest, res) => {
  try {
    const { name, email, role, department_id } = req.body || {};
    const userId = req.params.id;

    const existingUser = store.data.users.find((u) => u.id === userId);
    if (!existingUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    let newEmail = existingUser.email;
    if (email !== undefined && String(email).trim().toLowerCase() !== existingUser.email.toLowerCase()) {
      newEmail = String(email).trim().toLowerCase();
      const domainCheck = validateUniversityEmail(newEmail);
      if (!domainCheck.valid) {
        return res.status(400).json({ error: domainCheck.error });
      }
      if (store.data.users.some((u) => u.id !== userId && u.email.toLowerCase() === newEmail)) {
        return res.status(409).json({ error: `Email '${newEmail}' is already in use by another account.` });
      }
    }

    let newRole = existingUser.role;
    if (role !== undefined) {
      const validRoles: Role[] = ['faculty', 'hod', 'associate_dean', 'dean', 'finance', 'director', 'super_admin'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: `Invalid role '${role}'. Supported: ${validRoles.join(', ')}` });
      }
      newRole = role;
    }

    let newDeptId = existingUser.department_id;
    if (department_id !== undefined) {
      newDeptId = department_id || null;
    }

    // Role & Department constraints
    if (['faculty', 'hod'].includes(newRole)) {
      if (!newDeptId) {
        return res.status(400).json({ error: `Department is required for role '${newRole}'` });
      }
      const deptExists = store.data.departments.some((d) => d.id === newDeptId);
      if (!deptExists) {
        return res.status(400).json({ error: 'Department does not exist' });
      }

      // Check active HOD uniqueness if transitioning to HOD or changing department
      if (newRole === 'hod') {
        const hodCheck = checkActiveHodUniqueness(newDeptId, userId);
        if (!hodCheck.allowed) {
          const dept = store.data.departments.find((d) => d.id === newDeptId);
          return res.status(409).json({
            error: `Department '${dept?.name || newDeptId}' already has an active HOD: ${hodCheck.existingHod.name} (${hodCheck.existingHod.email}).`
          });
        }
      }
    }

    await store.transact((db) => {
      const u = db.users.find((usr) => usr.id === userId);
      if (!u) return;
      if (name !== undefined) u.name = String(name).trim();
      u.email = newEmail;
      u.role = newRole;
      u.department_id = newDeptId;

      db.audit_logs.push({
        id: uuid(),
        entity_type: 'user_account',
        entity_id: u.id,
        department_id: u.department_id || 'ALL',
        old_amount: null,
        new_amount: 0,
        difference: 0,
        changed_by: req.user!.id,
        role: req.user!.role,
        reason: `Super Admin updated user profile: ${u.name} (${u.email}) [Role: ${u.role}, Dept: ${u.department_id || 'Institution'}]`,
        source: 'portal',
        approval_status: 'approved',
        created_at: new Date().toISOString(),
      });
    });

    const updated = store.data.users.find((u) => u.id === userId)!;
    return res.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        department_id: updated.department_id,
        is_active: updated.is_active !== false,
        must_change_password: Boolean(updated.must_change_password),
      },
      message: 'User account updated successfully.',
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Failed to update user account' });
  }
});

/**
 * POST /api/admin/users/:id/toggle-active
 * Activate or deactivate an account.
 */
adminRouter.post('/users/:id/toggle-active', async (req: AuthedRequest, res) => {
  try {
    const userId = req.params.id;
    const { is_active } = req.body || {};

    if (req.user!.id === userId && is_active === false) {
      return res.status(400).json({ error: 'You cannot deactivate your own active Super Admin account.' });
    }

    const user = store.data.users.find((u) => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newActiveState = Boolean(is_active);

    // If activating an HOD, verify another active HOD hasn't taken their place
    if (newActiveState && user.role === 'hod' && user.department_id) {
      const hodCheck = checkActiveHodUniqueness(user.department_id, userId);
      if (!hodCheck.allowed) {
        return res.status(409).json({
          error: `Cannot activate HOD: Department already has an active HOD (${hodCheck.existingHod.name}).`
        });
      }
    }

    await updateAccountActiveStatus(userId, newActiveState);

    await store.transact((db) => {
      db.audit_logs.push({
        id: uuid(),
        entity_type: 'user_account',
        entity_id: userId,
        department_id: user.department_id || 'ALL',
        old_amount: null,
        new_amount: 0,
        difference: 0,
        changed_by: req.user!.id,
        role: req.user!.role,
        reason: `Super Admin ${newActiveState ? 'activated' : 'deactivated'} user account: ${user.name} (${user.email})`,
        source: 'portal',
        approval_status: 'approved',
        created_at: new Date().toISOString(),
      });
    });

    return res.json({
      success: true,
      is_active: newActiveState,
      message: `User account ${newActiveState ? 'activated' : 'deactivated'} successfully.`,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Failed to change account status' });
  }
});

/**
 * POST /api/admin/users/:id/reset-password
 * Super Admin resets a user's password to a fresh temporary password.
 * Marks must_change_password = true.
 */
adminRouter.post('/users/:id/reset-password', async (req: AuthedRequest, res) => {
  try {
    const userId = req.params.id;
    const user = store.data.users.find((u) => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { temporaryPassword } = await resetTemporaryPassword(userId);

    await store.transact((db) => {
      db.audit_logs.push({
        id: uuid(),
        entity_type: 'user_account',
        entity_id: userId,
        department_id: user.department_id || 'ALL',
        old_amount: null,
        new_amount: 0,
        difference: 0,
        changed_by: req.user!.id,
        role: req.user!.role,
        reason: `Super Admin reset temporary password for user: ${user.name} (${user.email})`,
        source: 'portal',
        approval_status: 'approved',
        created_at: new Date().toISOString(),
      });
    });

    return res.json({
      success: true,
      temporaryPassword,
      message: 'Temporary password reset successfully. Please deliver it securely to the user.',
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Failed to reset password' });
  }
});

/** DELETE /api/admin/users/:id — remove an account and release its project assignments. */
adminRouter.delete('/users/:id', async (req: AuthedRequest, res) => {
  if (req.user!.id === req.params.id) return res.status(400).json({ error: 'You cannot remove the active administrator account' });
  const removed = await store.transact((db) => {
    const index = db.users.findIndex((u) => u.id === req.params.id);
    if (index < 0) return null;
    const [user] = db.users.splice(index, 1);
    db.projects.forEach((project) => {
      if (project.assigned_faculty_id === user.id) project.assigned_faculty_id = null;
    });
    return { id: user.id, name: user.name };
  });
  if (!removed) return res.status(404).json({ error: 'User not found' });
  res.json({ deleted: true, ...removed });
});

// =========================================================================
// FACULTY EXCEL BULK ONBOARDING ENDPOINTS
// =========================================================================

/**
 * GET /api/admin/users/template
 * Download a blank, formatted .xlsx template for Faculty Bulk Onboarding.
 * Includes column headers and a Reference & Guidelines worksheet with active department codes.
 */
adminRouter.get('/users/template', async (_req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'CHRIST University ERP';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Faculty Onboarding');
    sheet.columns = [
      { header: 'Faculty Name', key: 'name', width: 28 },
      { header: 'Official Email ID', key: 'email', width: 36 },
      { header: 'Department Code', key: 'dept_code', width: 20 },
      { header: 'Role', key: 'role', width: 18 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF003D8F' }, // CHRIST Blue
    };
    sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(1).height = 24;

    // Reference and guidelines sheet
    const refSheet = workbook.addWorksheet('Reference & Guidelines');
    refSheet.columns = [
      { header: 'Department Name', key: 'dept_name', width: 50 },
      { header: 'Department Code', key: 'dept_code', width: 20 },
      { header: 'Category', key: 'category', width: 16 },
    ];
    refSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    refSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF003D8F' },
    };

    store.data.departments.forEach((d) => {
      refSheet.addRow({
        dept_name: d.name,
        dept_code: d.code,
        category: d.category || 'academic',
      });
    });

    refSheet.addRow({});
    refSheet.addRow({ dept_name: 'ROLE SPECIFICATION:', dept_code: 'ALLOWED VALUE', category: 'GUIDELINES' });
    refSheet.addRow({ dept_name: 'Faculty Member', dept_code: 'faculty', category: 'Standard NFA submitter' });
    refSheet.addRow({ dept_name: 'Head of Department', dept_code: 'hod', category: 'Only 1 active HOD per department' });
    refSheet.addRow({ dept_name: 'Associate Dean', dept_code: 'associate_dean', category: 'Institutional reviewer' });
    refSheet.addRow({ dept_name: 'Dean', dept_code: 'dean', category: 'Institutional reviewer' });
    refSheet.addRow({ dept_name: 'Finance / Accounts', dept_code: 'finance', category: 'Accounts approver' });
    refSheet.addRow({ dept_name: 'University Director', dept_code: 'director', category: 'Final authority' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="CU_Faculty_Onboarding_Template.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) {
    res.status(500).json({ error: `Failed to generate Excel template: ${err.message}` });
  }
});

/**
 * Resolves a department from code, full name, or common university alias.
 * Matches case-insensitively, handles prefixes like "Department of", "&" vs "and", etc.
 */
export function resolveDepartment(
  deptInput: string,
  departments: Array<{ id: string; name: string; code: string }>
): { id: string; name: string; code: string } | null {
  if (!deptInput || typeof deptInput !== 'string') return null;
  const raw = deptInput.trim();
  if (!raw) return null;

  // 1. Exact code match (e.g. "CSE", "ADSE", "CIVIL")
  const codeMatch = departments.find((d) => d.code.toUpperCase() === raw.toUpperCase());
  if (codeMatch) return codeMatch;

  // 2. Exact name match (case-insensitive)
  const nameMatch = departments.find((d) => d.name.toLowerCase() === raw.toLowerCase());
  if (nameMatch) return nameMatch;

  // 3. Normalized string comparison
  const normalize = (str: string) =>
    str
      .toLowerCase()
      .replace(/^(department of|dept\.? of|centre of excellence in|center of excellence in|advanced research centre in|laboratory in|laboratory)\s+/gi, '')
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const normInput = normalize(raw);
  if (!normInput) return null;

  // Exact normalized match
  const normMatch = departments.find((d) => normalize(d.name) === normInput);
  if (normMatch) return normMatch;

  // Substring matching
  const subMatch = departments.find((d) => {
    const nd = normalize(d.name);
    return nd.includes(normInput) || normInput.includes(nd);
  });
  if (subMatch) return subMatch;

  // Common university aliases
  const aliasMap: Record<string, string> = {
    'computer science': 'CSE',
    'computer science and engineering': 'CSE',
    'computer science engineering': 'CSE',
    'cse': 'CSE',
    'applied data science': 'ADSE',
    'ai and data science': 'ADSE',
    'ai & data science': 'ADSE',
    'ai and data science engineering': 'ADSE',
    'applied data science and engineering': 'ADSE',
    'data science': 'ADSE',
    'adse': 'ADSE',
    'civil': 'CIVIL',
    'civil engineering': 'CIVIL',
    'mech': 'MECH',
    'mechanical': 'MECH',
    'mechanical engineering': 'MECH',
    'mechanical and automobile': 'MECH',
    'mechanical and automobile engineering': 'MECH',
    'automobile': 'MECH',
    'eee': 'EEE',
    'electrical and electronics': 'EEE',
    'electrical and electronics engineering': 'EEE',
    'ece': 'ECE',
    'electronics and communication': 'ECE',
    'electronics and communication engineering': 'ECE',
    'robotics': 'DRAS',
    'robotics and autonomous systems': 'DRAS',
    'dras': 'DRAS',
    'sciences and humanities': 'S&H',
    's and h': 'S&H',
    's&h': 'S&H',
    'automation': 'COE-AUTO',
    'e mobility': 'COE-EMOB',
    'emobility': 'COE-EMOB',
    'e-mobility': 'COE-EMOB',
    'frontier material': 'COE-FMR',
    'fmr': 'COE-FMR',
    'rf and microwave': 'COE-RFMW',
    'rf & mw': 'COE-RFMW',
    'microwave': 'COE-RFMW',
    'digital forensics': 'COE-ARDC',
    'ardc': 'COE-ARDC',
    'cyber security': 'COE-ARDC',
    'dtici': 'COE-DTICI',
    'daimler': 'COE-DTICI',
  };

  const codeFromAlias = aliasMap[normInput];
  if (codeFromAlias) {
    const deptByAlias = departments.find((d) => d.code.toUpperCase() === codeFromAlias.toUpperCase());
    if (deptByAlias) return deptByAlias;
  }

  return null;
}

export interface SchoolDeptResolution {
  school: string | null;
  school_name: string | null;
  department: { id: string; name: string; code: string } | null;
  isSchoolOnly: boolean;
  unresolvedMessage?: string;
}

/**
 * Resolves school and department separately.
 * Handles single school designations ("SoET", "SoA"), joint school affiliations ("SoET & SoA"),
 * as well as existing departments and CoEs (e.g. S&H, CSE, ADSE, CIVIL, EEE, ECE, MECH, DRAS).
 */
export function resolveSchoolAndDepartment(
  deptInput: string,
  departments: Array<{ id: string; name: string; code: string }>
): SchoolDeptResolution {
  if (!deptInput || typeof deptInput !== 'string') {
    return { school: null, school_name: null, department: null, isSchoolOnly: false };
  }
  const raw = deptInput.trim();
  if (!raw) {
    return { school: null, school_name: null, department: null, isSchoolOnly: false };
  }
  const lower = raw.toLowerCase().replace(/\s+/g, ' ');

  // 1. Joint Affiliation: "SoET & SoA", "SoA & SoET", "SoET and SoA"
  if (
    lower === 'soet & soa' ||
    lower === 'soet and soa' ||
    lower === 'soa & soet' ||
    lower === 'soa and soet' ||
    (lower.includes('engineering') && lower.includes('architecture'))
  ) {
    return {
      school: 'SoET & SoA',
      school_name: 'School of Engineering and Technology & School of Architecture',
      department: null,
      isSchoolOnly: true,
      unresolvedMessage: "Joint affiliation ('SoET & SoA'). Please select the primary Department for NFA authorization.",
    };
  }

  // 2. Single School: "SoET"
  if (
    lower === 'soet' ||
    lower === 'school of engineering' ||
    lower === 'school of engineering and technology' ||
    lower === 'school of engineering & technology'
  ) {
    return {
      school: 'SoET',
      school_name: 'School of Engineering and Technology',
      department: null,
      isSchoolOnly: true,
      unresolvedMessage: "School-level entry ('SoET'). Please select the specific Department in the dropdown below.",
    };
  }

  // 3. Single School: "SoA"
  if (
    lower === 'soa' ||
    lower === 'school of architecture'
  ) {
    return {
      school: 'SoA',
      school_name: 'School of Architecture',
      department: null,
      isSchoolOnly: true,
      unresolvedMessage: "School-level entry ('SoA'). Please select the primary Department in the dropdown below.",
    };
  }

  // 4. Try resolving as a specific department first (e.g. S&H, CSE, ADSE, CIVIL, etc.)
  const dept = resolveDepartment(raw, departments);
  if (dept) {
    // Current engineering departments and CoEs fall under School of Engineering and Technology (SoET)
    return {
      school: 'SoET',
      school_name: 'School of Engineering and Technology',
      department: dept,
      isSchoolOnly: false,
    };
  }

  return {
    school: null,
    school_name: null,
    department: null,
    isSchoolOnly: false,
  };
}

/**
 * POST /api/admin/users/preview-upload
 * Inspects and validates an uploaded Excel file WITHOUT creating accounts.
 * Supports flexible column aliases:
 * - "Official Email ID" or "Email ID"
 * - "Department Code" or "Department" (resolves by code or institutional name)
 * - "Designation" (captures faculty title without auto-promoting to privileged roles)
 * - Optional "Role" (defaults to 'faculty' if omitted)
 * - Ignores "S. No" / "S.No"
 * Returns row-level validation status and error details for preview.
 */
adminRouter.post('/users/preview-upload', upload.single('file'), async (req: AuthedRequest, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Excel file (.xlsx) is required' });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer as any);
    const worksheet = workbook.worksheets[0];

    if (!worksheet || worksheet.rowCount < 2) {
      return res.status(400).json({ error: 'Excel file is empty or missing data rows' });
    }

    // Dynamic header row detection across rows 1 to 5
    let headerRowIdx = -1;
    let nameCol = -1;
    let emailCol = -1;
    let deptCol = -1;
    let desigCol = -1;
    let roleCol = -1;

    for (let r = 1; r <= Math.min(5, worksheet.rowCount); r++) {
      const row = worksheet.getRow(r);
      const cells: Array<{ col: number; text: string }> = [];
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        cells.push({ col: colNumber, text: String(cell.value || '').trim().toLowerCase() });
      });

      const foundName = cells.find(
        (c) => c.text.includes('name') && !c.text.includes('dept') && !c.text.includes('department')
      );
      const foundEmail = cells.find(
        (c) => c.text.includes('email') || c.text.includes('mail') || c.text === 'email id'
      );
      const foundDept = cells.find(
        (c) => c.text.includes('dept') || c.text.includes('department')
      );

      if (foundName && (foundEmail || foundDept)) {
        headerRowIdx = r;
        nameCol = foundName.col;
        if (foundEmail) emailCol = foundEmail.col;
        if (foundDept) deptCol = foundDept.col;

        const foundDesig = cells.find(
          (c) => c.text.includes('designation') || c.text.includes('title') || c.text.includes('post')
        );
        if (foundDesig) desigCol = foundDesig.col;

        const foundRole = cells.find(
          (c) => c.text === 'role' || c.text.includes('role')
        );
        if (foundRole) roleCol = foundRole.col;

        break;
      }
    }

    if (nameCol === -1 || emailCol === -1 || deptCol === -1) {
      return res.status(400).json({
        error:
          'Missing required columns in Excel file. Must include "Faculty Name", "Official Email ID" (or "Email ID"), and "Department" (or "Department Code").',
      });
    }

    const rows: Array<{
      rowNumber: number;
      name: string;
      designation?: string;
      email: string;
      school?: string;
      school_name?: string;
      department_code: string;
      department_name?: string;
      department_id?: string | null;
      role: Role;
      status: 'valid' | 'invalid';
      needs_department?: boolean;
      error?: string;
    }> = [];

    const emailsInFile = new Set<string>();
    const hodDeptsInFile = new Set<string>();

    for (let r = headerRowIdx + 1; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);
      const name = String(row.getCell(nameCol).value || '').trim();

      const rawEmail = row.getCell(emailCol).value;
      const email = (
        typeof rawEmail === 'object' && rawEmail !== null && 'text' in rawEmail
          ? String((rawEmail as any).text)
          : String(rawEmail || '')
      ).trim().toLowerCase();

      const rawDept = String(row.getCell(deptCol).value || '').trim();
      const designation = desigCol !== -1 ? String(row.getCell(desigCol).value || '').trim() : '';
      const rawRole = roleCol !== -1 ? String(row.getCell(roleCol).value || '').trim().toLowerCase() : '';

      // Skip completely empty trailing rows
      if (!name && !email && !rawDept && !designation && !rawRole) continue;

      if (!name) {
        rows.push({
          rowNumber: r,
          name: '',
          designation: designation || 'Faculty',
          email,
          department_code: rawDept,
          role: 'faculty',
          status: 'invalid',
          error: 'Missing faculty name',
        });
        continue;
      }

      if (!email) {
        rows.push({
          rowNumber: r,
          name,
          designation: designation || 'Faculty',
          email: '',
          department_code: rawDept,
          role: 'faculty',
          status: 'invalid',
          error: 'Missing email ID',
        });
        continue;
      }

      const domainCheck = validateUniversityEmail(email);
      if (!domainCheck.valid) {
        rows.push({
          rowNumber: r,
          name,
          designation: designation || 'Faculty',
          email,
          department_code: rawDept,
          role: 'faculty',
          status: 'invalid',
          error: domainCheck.error,
        });
        continue;
      }

      if (emailsInFile.has(email)) {
        rows.push({
          rowNumber: r,
          name,
          designation: designation || 'Faculty',
          email,
          department_code: rawDept,
          role: 'faculty',
          status: 'invalid',
          error: `Duplicate email within file: '${email}'`,
        });
        continue;
      }
      emailsInFile.add(email);

      if (store.data.users.some((u) => u.email.toLowerCase() === email)) {
        rows.push({
          rowNumber: r,
          name,
          designation: designation || 'Faculty',
          email,
          department_code: rawDept,
          role: 'faculty',
          status: 'invalid',
          error: `Email '${email}' is already registered in the system`,
        });
        continue;
      }

      // Department & School resolution against CU-NFA records
      const resDept = resolveSchoolAndDepartment(rawDept, store.data.departments);

      // Role validation: Defaults to 'faculty'; never auto-promotes to HOD or Dean based on designation text
      let role: Role = 'faculty';
      if (rawRole) {
        const validRoles: Role[] = ['faculty', 'hod', 'associate_dean', 'dean', 'finance', 'director', 'super_admin'];
        if (!validRoles.includes(rawRole as Role)) {
          rows.push({
            rowNumber: r,
            name,
            designation: designation || 'Faculty',
            email,
            department_code: rawDept,
            role: 'faculty',
            status: 'invalid',
            error: `Invalid role '${rawRole}'. Supported: ${validRoles.join(', ')}`,
          });
          continue;
        }
        role = rawRole as Role;
      }

      const isSchoolWideRole = ['dean', 'associate_dean', 'director', 'finance', 'super_admin'].includes(role);

      // School-level officials (Dean, Associate Dean, Director, Finance) do NOT require an individual department
      if (isSchoolWideRole) {
        rows.push({
          rowNumber: r,
          name,
          designation: designation || 'Official',
          email,
          school: resDept.school || 'SoET',
          school_name: resDept.school_name || 'School of Engineering and Technology',
          department_code: resDept.department ? resDept.department.code : 'SoET',
          department_name: resDept.department ? resDept.department.name : 'School-wide (SoET)',
          department_id: resDept.department ? resDept.department.id : null,
          role,
          status: 'valid',
          needs_department: false,
        });
        continue;
      }

      // For standard Faculty and HOD, an individual department is mandatory
      if (resDept.isSchoolOnly) {
        rows.push({
          rowNumber: r,
          name,
          designation: designation || 'Faculty',
          email,
          school: resDept.school || '',
          school_name: resDept.school_name || '',
          department_code: '',
          department_name: '',
          department_id: null,
          role: 'faculty',
          status: 'invalid',
          needs_department: true,
          error: `School-level entry ('${resDept.school}'). Select Department, or assign School-wide Role (Dean/Director/Finance).`,
        });
        continue;
      }

      if (!resDept.department) {
        rows.push({
          rowNumber: r,
          name,
          designation: designation || 'Faculty',
          email,
          school: '',
          school_name: '',
          department_code: rawDept,
          department_name: '',
          department_id: null,
          role: 'faculty',
          status: 'invalid',
          needs_department: false,
          error: `Department '${rawDept}' could not be matched with any active CU-NFA department or CoE`,
        });
        continue;
      }

      const dept = resDept.department;

      if (role === 'hod') {
        if (hodDeptsInFile.has(dept.id)) {
          rows.push({
            rowNumber: r,
            name,
            designation: designation || 'Faculty',
            email,
            department_code: dept.code,
            department_name: dept.name,
            department_id: dept.id,
            role: 'faculty',
            status: 'invalid',
            error: `Multiple HODs assigned to department '${dept.code}' in this file`,
          });
          continue;
        }
        hodDeptsInFile.add(dept.id);

        const hodCheck = checkActiveHodUniqueness(dept.id);
        if (!hodCheck.allowed) {
          rows.push({
            rowNumber: r,
            name,
            designation: designation || 'Faculty',
            email,
            department_code: dept.code,
            department_name: dept.name,
            department_id: dept.id,
            role: 'faculty',
            status: 'invalid',
            error: `Department '${dept.code}' already has an active HOD: ${hodCheck.existingHod?.name}`,
          });
          continue;
        }
      }

      rows.push({
        rowNumber: r,
        name,
        designation: designation || 'Faculty',
        email,
        school: resDept.school || 'SoET',
        school_name: resDept.school_name || 'School of Engineering and Technology',
        department_code: dept.code,
        department_name: dept.name,
        department_id: dept.id,
        role,
        status: 'valid',
        needs_department: false,
      });
    }

    const validCount = rows.filter((r) => r.status === 'valid').length;
    const errorCount = rows.filter((r) => r.status === 'invalid').length;

    return res.json({
      totalRows: rows.length,
      validCount,
      errorCount,
      rows,
    });
  } catch (err: any) {
    return res.status(400).json({ error: `Failed to inspect Excel file: ${err.message}` });
  }
});

/**
 * POST /api/admin/users/confirm-upload
 * Creates accounts for validated rows after explicit Super Admin confirmation.
 * Handles partial failures safely, records audit trail.
 */
adminRouter.post('/users/confirm-upload', async (req: AuthedRequest, res) => {
  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No validated rows provided for account creation' });
    }

    const validRows = rows.filter((r) => r.status === 'valid');
    if (validRows.length === 0) {
      return res.status(400).json({ error: 'No valid rows found to create accounts' });
    }

    let createdCount = 0;
    let failedCount = 0;
    const results: Array<{ name: string; email: string; role: string; status: 'created' | 'failed'; error?: string }> = [];

    for (const item of validRows) {
      try {
        // Concurrency / retry check
        if (store.data.users.some((u) => u.email.toLowerCase() === item.email.toLowerCase())) {
          failedCount++;
          results.push({ name: item.name, email: item.email, role: item.role, status: 'failed', error: 'Email already registered' });
          continue;
        }

        const isSchoolWideRole = ['dean', 'associate_dean', 'director', 'finance', 'super_admin'].includes(item.role);

        // Faculty and HOD require a valid Department or CoE assignment
        if (!isSchoolWideRole && !item.department_id) {
          failedCount++;
          results.push({ name: item.name, email: item.email, role: item.role, status: 'failed', error: 'Faculty and HOD require a valid Department or CoE assignment' });
          continue;
        }

        if (item.role === 'hod' && item.department_id) {
          const hodCheck = checkActiveHodUniqueness(item.department_id);
          if (!hodCheck.allowed) {
            failedCount++;
            results.push({ name: item.name, email: item.email, role: item.role, status: 'failed', error: 'Active HOD already exists for department' });
            continue;
          }
        }

        await createInstitutionalAccount({
          name: item.name,
          email: item.email,
          role: (item.role as Role) || 'faculty',
          department_id: isSchoolWideRole ? null : (item.department_id || null),
          school: isSchoolWideRole ? (item.school || 'SoET') : (item.school || 'SoET'),
          initialPassword: DEFAULT_FACULTY_ONBOARDING_PASSWORD,
        });

        createdCount++;
        results.push({ name: item.name, email: item.email, role: item.role, status: 'created' });
      } catch (err: any) {
        failedCount++;
        results.push({ name: item.name, email: item.email, role: item.role, status: 'failed', error: err.message });
      }
    }

    // Record audit log
    await store.transact((db) => {
      db.audit_logs.push({
        id: uuid(),
        entity_type: 'user_account',
        entity_id: 'bulk_onboarding',
        department_id: 'ALL',
        old_amount: null,
        new_amount: 0,
        difference: 0,
        changed_by: req.user!.id,
        role: req.user!.role,
        reason: `Super Admin bulk onboarded ${createdCount} accounts via Excel (${failedCount} failed)`,
        source: 'portal',
        approval_status: 'approved',
        created_at: new Date().toISOString(),
      });
    });

    return res.json({
      success: true,
      createdCount,
      failedCount,
      totalProcessed: validRows.length,
      results,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Bulk creation failed' });
  }
});

// =========================================================================
// BUDGET MANAGEMENT ADMIN UTILITIES
// =========================================================================

/**
 * POST /api/admin/clear-budget — Super admin: clear budget of previous year or specified FY
 */
adminRouter.post('/clear-budget', async (req: AuthedRequest, res) => {
  const { financial_year_id, clear_nfas, reset_mode } = req.body || {};
  if (!financial_year_id) {
    return res.status(400).json({ error: 'financial_year_id is required ("all" or a specific FY ID)' });
  }

  try {
    const result = await store.transact((db) => {
      let fyLabel = 'All Years';
      let clearedBudgetsCount = 0;
      let clearedNfasCount = 0;

      if (financial_year_id === 'all') {
        clearedBudgetsCount = db.department_budgets.length;
        if (reset_mode === 'zero') {
          db.department_budgets.forEach((b) => {
            b.allocated_amount = 0;
            b.approved_amount = 0;
            b.pending_amount = 0;
            b.revised_amount = 0;
          });
        } else {
          db.department_budgets = [];
        }

        if (clear_nfas) {
          clearedNfasCount = db.nfas.length;
          db.nfas = [];
          db.nfa_items = [];
          db.approvals = [];
        }
      } else {
        const fy = db.financial_years.find((f) => f.id === financial_year_id);
        if (!fy) throw new Error('Financial year not found');
        fyLabel = fy.label;

        const targetBudgets = db.department_budgets.filter((b) => b.financial_year_id === financial_year_id);
        clearedBudgetsCount = targetBudgets.length;

        if (reset_mode === 'zero') {
          targetBudgets.forEach((b) => {
            b.allocated_amount = 0;
            b.approved_amount = 0;
            b.pending_amount = 0;
            b.revised_amount = 0;
          });
        } else {
          db.department_budgets = db.department_budgets.filter((b) => b.financial_year_id !== financial_year_id);
        }

        if (clear_nfas) {
          const nfasToRemove = db.nfas.filter((n) => n.financial_year_id === financial_year_id);
          clearedNfasCount = nfasToRemove.length;
          const removeIds = new Set(nfasToRemove.map((n) => n.id));
          db.nfas = db.nfas.filter((n) => !removeIds.has(n.id));
          db.nfa_items = db.nfa_items.filter((i) => !removeIds.has(i.nfa_id));
          db.approvals = db.approvals.filter((a) => !removeIds.has(a.nfa_id));
        }
      }

      db.audit_logs.push({
        id: uuid(),
        entity_type: 'department_budget',
        entity_id: financial_year_id,
        department_id: 'ALL',
        old_amount: null,
        new_amount: 0,
        difference: 0,
        changed_by: req.user!.id,
        role: req.user!.role,
        reason: `Budget data cleared for ${fyLabel} (${clearedBudgetsCount} budget lines removed, ${clearedNfasCount} NFAs cleared)`,
        source: 'portal',
        approval_status: 'approved',
        created_at: new Date().toISOString(),
      });

      return {
        success: true,
        fyLabel,
        clearedBudgetsCount,
        clearedNfasCount,
      };
    });

    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to clear budget' });
  }
});
