import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { store } from '../store.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import type { EventRevenue, EventRevenueSource, EventRevenueStatus, Nfa, Role } from '../types.js';
import { sendRevenueReminderNotification } from '../services/revenueReminder.js';
import { validateDiskFile } from '../lib/fileValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const attachmentsDir = path.join(__dirname, '..', '..', 'data', 'attachments');

if (!fs.existsSync(attachmentsDir)) {
  fs.mkdirSync(attachmentsDir, { recursive: true });
}

const revenueStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, attachmentsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `rev_${uuid()}${ext}`;
    cb(null, uniqueName);
  },
});

const allowedMimes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png'];

const uploadReceipt = multer({
  storage: revenueStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid document format. Allowed: PDF, JPG, JPEG, PNG (Max 10MB).'));
    }
  },
});

export const revenueRouter = Router();
revenueRouter.use(requireAuth);

/**
 * Helper to check if a user can view/manage revenue for a given NFA or department
 */
export function canAccessRevenue(
  user: { id: string; role: Role; department_id: string | null; authorized_centre_ids?: string[] },
  nfa: Nfa
): boolean {
  if (['super_admin', 'director', 'finance', 'finance_head'].includes(user.role)) {
    return true;
  }

  // School Deans & Assoc Deans
  if (['dean', 'associate_dean', 'deans_office'].includes(user.role)) {
    const deanSchoolCode = (user as any).school || 'SOET';
    const deanSchool = store.getSchool(deanSchoolCode);
    const dept = store.getDepartment(nfa.department_id);
    if (deanSchool && dept?.school_id) {
      return dept.school_id === deanSchool.id;
    }
    return false;
  }

  // HOD of department
  if (user.role === 'hod' && user.department_id && nfa.department_id === user.department_id) {
    return true;
  }

  // Centre Coordinator
  if (nfa.centre_id && user.authorized_centre_ids?.includes(nfa.centre_id)) {
    return true;
  }

  // Faculty owner / proposer
  if (nfa.created_by === user.id) {
    return true;
  }

  return false;
}

/**
 * GET /api/revenue/summary
 * Aggregated revenue statistics scoped to the user's role.
 */
revenueRouter.get('/summary', (req: AuthedRequest, res) => {
  const user = req.user!;
  const allRevenues = store.data.event_revenues || [];
  const allNfas = store.data.nfas || [];

  // Filter NFAs and revenues accessible to user
  const accessibleNfas = allNfas.filter((n) => canAccessRevenue(user, n));
  const accessibleNfaIds = new Set(accessibleNfas.map((n) => n.id));

  const revenues = allRevenues.filter((r) => accessibleNfaIds.has(r.nfa_id));

  let totalCollected = 0;
  let totalVerified = 0;
  let totalPending = 0;
  let totalReturned = 0;

  const bySource: Record<EventRevenueSource, number> = {
    registration_fee: 0,
    sponsorship: 0,
    participation_fee: 0,
    event_collection: 0,
    other_income: 0,
  };

  const deptMap: Record<string, { department_id: string; name: string; code: string; total_collected: number; verified: number; pending: number }> = {};

  for (const r of revenues) {
    const amt = Number(r.amount) || 0;
    totalCollected += amt;

    if (r.status === 'verified') {
      totalVerified += amt;
    } else if (r.status === 'submitted') {
      totalPending += amt;
    } else if (r.status === 'returned') {
      totalReturned += amt;
    }

    if (bySource[r.revenue_source] !== undefined) {
      bySource[r.revenue_source] += amt;
    }

    const deptId = r.department_id || 'UNKNOWN';
    if (!deptMap[deptId]) {
      const dept = store.data.departments.find((d) => d.id === deptId);
      deptMap[deptId] = {
        department_id: deptId,
        name: dept?.name || 'Department',
        code: dept?.code || 'DEPT',
        total_collected: 0,
        verified: 0,
        pending: 0,
      };
    }
    deptMap[deptId].total_collected += amt;
    if (r.status === 'verified') deptMap[deptId].verified += amt;
    if (r.status === 'submitted') deptMap[deptId].pending += amt;
  }

  // Count eligible events awaiting revenue submission
  const revenueGeneratingEvents = accessibleNfas.filter(
    (n) => n.nfa_type === 'event' && n.status === 'approved' && n.will_generate_revenue
  );

  const completedEvents = revenueGeneratingEvents.filter((n) => n.event_completion_status === 'completed');

  res.json({
    total_collected: totalCollected,
    total_verified: totalVerified,
    total_pending: totalPending,
    total_returned: totalReturned,
    total_entries: revenues.length,
    by_source: bySource,
    by_department: Object.values(deptMap),
    revenue_events_count: revenueGeneratingEvents.length,
    completed_events_count: completedEvents.length,
    pending_revenue_events_count: completedEvents.filter(
      (n) => !revenues.some((r) => r.nfa_id === n.id)
    ).length,
  });
});

/**
 * GET /api/revenue/entries
 * List all revenue entries scoped to user permissions.
 */
revenueRouter.get('/entries', (req: AuthedRequest, res) => {
  const user = req.user!;
  const { nfa_id, department_id, status, source } = req.query;

  const allRevenues = store.data.event_revenues || [];
  const allNfas = store.data.nfas || [];
  const nfaMap = new Map(allNfas.map((n) => [n.id, n]));
  const deptMap = new Map(store.data.departments.map((d) => [d.id, d]));

  const filtered = allRevenues.filter((r) => {
    const nfa = nfaMap.get(r.nfa_id);
    if (!nfa) return false;
    if (!canAccessRevenue(user, nfa)) return false;

    if (nfa_id && r.nfa_id !== String(nfa_id)) return false;
    if (department_id && r.department_id !== String(department_id)) return false;
    if (status && r.status !== String(status)) return false;
    if (source && r.revenue_source !== String(source)) return false;

    return true;
  });

  const enriched = filtered.map((r) => {
    const nfa = nfaMap.get(r.nfa_id);
    const dept = r.department_id ? deptMap.get(r.department_id) : undefined;
    return {
      ...r,
      nfa_ref_no: nfa?.ref_no || '',
      nfa_title: nfa?.title || '',
      department_name: dept?.name || '',
      department_code: dept?.code || '',
    };
  });

  res.json(enriched);
});

/**
 * GET /api/revenue/eligible-nfas
 * Returns approved Event NFAs where revenue can be logged.
 */
revenueRouter.get('/eligible-nfas', (req: AuthedRequest, res) => {
  const user = req.user!;
  const allNfas = store.data.nfas || [];
  const allRevenues = store.data.event_revenues || [];
  const deptMap = new Map(store.data.departments.map((d) => [d.id, d]));

  const eligible = allNfas.filter((n) => {
    if (n.status !== 'approved') return false;
    if (n.nfa_type !== 'event') return false;
    return canAccessRevenue(user, n);
  });

  const result = eligible.map((n) => {
    const dept = deptMap.get(n.department_id);
    const entries = allRevenues.filter((r) => r.nfa_id === n.id);
    const totalCollected = entries.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const totalVerified = entries.filter((r) => r.status === 'verified').reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

    return {
      id: n.id,
      ref_no: n.ref_no,
      title: n.title,
      total_amount: n.total_amount,
      department_id: n.department_id,
      department_name: dept?.name || '',
      department_code: dept?.code || '',
      will_generate_revenue: Boolean(n.will_generate_revenue),
      event_completion_status: n.event_completion_status || 'not_started',
      event_completion_date: n.event_completion_date,
      entries_count: entries.length,
      total_collected: totalCollected,
      total_verified: totalVerified,
    };
  });

  res.json(result);
});

/**
 * POST /api/revenue/entries
 * Submit a revenue collection entry.
 */
revenueRouter.post('/entries', uploadReceipt.single('receipt'), async (req: AuthedRequest, res) => {
  const user = req.user!;
  const { nfa_id, revenue_source, description, amount, collection_date, payment_method, remarks } = req.body;

  if (req.file) {
    const val = validateDiskFile(req.file.path, req.file.originalname, ['pdf', 'image']);
    if (!val.valid) {
      return res.status(400).json({ error: val.error });
    }
  }

  if (!nfa_id || !revenue_source || !description || !amount || !collection_date) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Missing required revenue entry fields' });
  }

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Revenue amount must be a positive number' });
  }

  const validSources: EventRevenueSource[] = [
    'registration_fee',
    'sponsorship',
    'participation_fee',
    'event_collection',
    'other_income',
  ];
  if (!validSources.includes(revenue_source)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Invalid revenue source specified' });
  }

  const nfa = store.data.nfas.find((n) => n.id === nfa_id);
  if (!nfa) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Associated Note for Approval not found' });
  }

  if (nfa.status !== 'approved') {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Revenue can only be recorded against approved NFAs' });
  }

  if (!canAccessRevenue(user, nfa)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'Forbidden: You do not have permission to submit revenue for this NFA' });
  }

  const entryId = uuid();
  const entry: EventRevenue = {
    id: entryId,
    nfa_id: nfa.id,
    department_id: nfa.department_id,
    revenue_source,
    description: String(description).trim(),
    amount: numAmount,
    collection_date: String(collection_date).slice(0, 10),
    payment_method: payment_method ? String(payment_method) : 'online',
    receipt_url: req.file ? `/api/revenue/receipts/${path.basename(req.file.path)}` : undefined,
    receipt_filename: req.file ? req.file.originalname : undefined,
    remarks: remarks ? String(remarks).trim() : undefined,
    submitted_by: user.id,
    submitted_by_name: user.name,
    status: 'submitted',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await store.transact((db) => {
    db.event_revenues = db.event_revenues || [];
    db.event_revenues.push(entry);

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'event_revenue',
      entity_id: entry.id,
      department_id: nfa.department_id,
      old_amount: null,
      new_amount: numAmount,
      difference: numAmount,
      changed_by: user.id,
      role: user.role,
      reason: `Recorded ${revenue_source} revenue of ₹${numAmount.toLocaleString('en-IN')} for ${nfa.ref_no}`,
      source: 'portal',
      approval_status: 'submitted',
      created_at: new Date().toISOString(),
    });
  });

  res.status(201).json({ success: true, revenue: entry });
});

/**
 * PUT /api/revenue/entries/:id/verify
 * Finance Office / Super Admin verification or return of revenue entry.
 */
revenueRouter.put('/entries/:id/verify', async (req: AuthedRequest, res) => {
  const user = req.user!;
  if (!['finance', 'finance_head', 'super_admin'].includes(user.role)) {
    return res.status(403).json({ error: 'Forbidden: Only Finance Office or Super Admin can verify revenue entries' });
  }

  const { id } = req.params;
  const { status, remarks } = req.body;

  if (!['verified', 'returned'].includes(status)) {
    return res.status(400).json({ error: 'Invalid verification status. Must be "verified" or "returned".' });
  }

  const entry = store.data.event_revenues?.find((r) => r.id === id);
  if (!entry) {
    return res.status(404).json({ error: 'Revenue entry not found' });
  }

  const nfa = store.data.nfas.find((n) => n.id === entry.nfa_id);

  await store.transact((db) => {
    const target = db.event_revenues?.find((r) => r.id === id);
    if (target) {
      target.status = status as EventRevenueStatus;
      target.verified_by = user.id;
      target.verified_by_name = user.name;
      target.verified_at = new Date().toISOString();
      target.verification_remarks = remarks || '';
      target.updated_at = new Date().toISOString();
    }

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'event_revenue',
      entity_id: entry.id,
      department_id: entry.department_id || 'ALL',
      old_amount: entry.amount,
      new_amount: entry.amount,
      difference: null,
      changed_by: user.id,
      role: user.role,
      reason: `Finance ${status} revenue entry of ₹${entry.amount.toLocaleString('en-IN')} (${entry.revenue_source}) for ${nfa?.ref_no || ''}: ${remarks || 'Verified'}`,
      source: 'portal',
      approval_status: status,
      created_at: new Date().toISOString(),
    });
  });

  res.json({ success: true, message: `Revenue entry marked as ${status}` });
});

/**
 * DELETE /api/revenue/entries/:id
 * Delete an unverified or returned revenue entry.
 */
revenueRouter.delete('/entries/:id', async (req: AuthedRequest, res) => {
  const user = req.user!;
  const { id } = req.params;

  const entry = store.data.event_revenues?.find((r) => r.id === id);
  if (!entry) {
    return res.status(404).json({ error: 'Revenue entry not found' });
  }

  if (entry.status === 'verified' && user.role !== 'super_admin') {
    return res.status(400).json({ error: 'Cannot delete a verified revenue entry. Contact Super Admin.' });
  }

  if (entry.submitted_by !== user.id && !['super_admin', 'finance'].includes(user.role)) {
    return res.status(403).json({ error: 'Forbidden: You did not submit this revenue entry' });
  }

  await store.transact((db) => {
    db.event_revenues = db.event_revenues?.filter((r) => r.id !== id);

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'event_revenue',
      entity_id: entry.id,
      department_id: entry.department_id || 'ALL',
      old_amount: entry.amount,
      new_amount: 0,
      difference: -entry.amount,
      changed_by: user.id,
      role: user.role,
      reason: `Deleted revenue entry of ₹${entry.amount.toLocaleString('en-IN')} (${entry.revenue_source})`,
      source: 'portal',
      approval_status: 'deleted',
      created_at: new Date().toISOString(),
    });
  });

  res.json({ success: true, message: 'Revenue entry removed' });
});

/**
 * POST /api/revenue/nfas/:id/complete-event
 * Mark an Event NFA as completed.
 * Automatically dispatches revenue reminder if will_generate_revenue === true.
 */
revenueRouter.post('/nfas/:id/complete-event', async (req: AuthedRequest, res) => {
  const user = req.user!;
  const { id } = req.params;
  const { completion_date, completion_remarks } = req.body;

  const nfa = store.data.nfas.find((n) => n.id === id);
  if (!nfa) {
    return res.status(404).json({ error: 'Note for Approval not found' });
  }

  if (nfa.nfa_type !== 'event') {
    return res.status(400).json({ error: 'Event completion tracking only applies to Event NFAs' });
  }

  if (nfa.status !== 'approved') {
    return res.status(400).json({ error: 'Only finally approved events can be marked as completed' });
  }

  if (!canAccessRevenue(user, nfa)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to manage this NFA' });
  }

  const finalDate = completion_date ? String(completion_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const finalRemarks = completion_remarks ? String(completion_remarks).trim() : 'Event completed successfully';

  await store.transact((db) => {
    const target = db.nfas.find((n) => n.id === id);
    if (target) {
      target.event_completion_status = 'completed';
      target.event_completion_date = finalDate;
      target.event_completion_remarks = finalRemarks;
      target.event_completed_by = user.id;
      target.event_completed_at = new Date().toISOString();
      target.updated_at = new Date().toISOString();
    }

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'nfa',
      entity_id: nfa.id,
      department_id: nfa.department_id,
      old_amount: null,
      new_amount: null,
      difference: null,
      changed_by: user.id,
      role: user.role,
      reason: `Event marked as COMPLETED by ${user.name} on ${finalDate}: ${finalRemarks}`,
      source: 'portal',
      approval_status: 'completed',
      created_at: new Date().toISOString(),
    });
  });

  // If this event was marked to generate revenue, send reminder
  let reminderSent = false;
  if (nfa.will_generate_revenue) {
    try {
      await sendRevenueReminderNotification({ ...nfa, event_completion_date: finalDate, event_completion_remarks: finalRemarks }, user.name);
      reminderSent = true;
    } catch (err: any) {
      console.warn('[REVENUE REMINDER] Notification warning:', err.message);
    }
  }

  res.json({
    success: true,
    message: 'Event successfully marked as completed',
    reminder_sent: reminderSent,
  });
});

/**
 * GET /api/revenue/reminders
 * List revenue reminder history.
 */
revenueRouter.get('/reminders', (req: AuthedRequest, res) => {
  const user = req.user!;
  const reminders = store.data.event_revenue_reminders || [];
  const nfaMap = new Map(store.data.nfas.map((n) => [n.id, n]));

  const filtered = reminders.filter((rem) => {
    const nfa = nfaMap.get(rem.nfa_id);
    if (!nfa) return false;
    return canAccessRevenue(user, nfa);
  });

  res.json(filtered);
});

/**
 * GET /api/revenue/receipts/:filename
 * Secure streaming of uploaded receipts.
 */
revenueRouter.get('/receipts/:filename', (req: AuthedRequest, res) => {
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(attachmentsDir, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Receipt file not found' });
  }

  res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
  fs.createReadStream(filePath).pipe(res);
});
