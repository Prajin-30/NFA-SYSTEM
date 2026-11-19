import { v4 as uuid } from 'uuid';
import type { DB, MockEmail, Nfa, Role, User } from '../types.js';
import { generateNfaPdfBuffer } from '../lib/pdf.js';

/**
 * Mock Notification Service for CU-NFA Management System.
 * Strictly in-memory and mock persistent delivery.
 * NEVER connects to SMTP or external email providers.
 */

export interface NotificationEventPayload {
  nfa: Nfa;
  actor: {
    id: string;
    name: string;
    role: Role;
    email?: string;
  };
  event:
    | 'nfa_submitted'
    | 'hod_reviewed'
    | 'deans_office_verified'
    | 'associate_dean_approved'
    | 'dean_approved'
    | 'finance_office_approved'
    | 'director_approved'
    | 'finance_head_approved'
    | 'revision_required'
    | 'nfa_resubmitted'
    | 'nfa_rejected'
    | 'nfa_deleted';
  comments?: string;
  nextAuthority?: string;
  pdfBuffer?: Buffer;
}

export interface FacilityManagementPayload {
  nfa: Nfa;
  facultyName: string;
  facultyEmail: string;
  organizationName: string;
  services: Array<{
    particulars: string;
    quantity: string;
    rate?: string;
    amount: number;
    arrangement?: string;
    isSampling?: boolean;
  }>;
  eventDetails?: {
    event_date?: string;
    start_time?: string;
    end_time?: string;
    venue?: string;
    additional_info?: string;
  };
  pdfBuffer?: Buffer;
}

// In-memory duplicate send tracking
const sentNotificationKeys = new Set<string>();

// Failure simulation flag for testing
let simulateFailureOnce = false;

export function setSimulateEmailFailure(fail: boolean) {
  simulateFailureOnce = fail;
}

export function resetSentNotifications() {
  sentNotificationKeys.clear();
}

/**
 * Resolves recipient email and display name for a given role and department context.
 */
function resolveRecipient(
  db: DB,
  role: Role | 'facility_management',
  departmentId?: string
): { email: string; name: string; role: string } {
  if (role === 'facility_management') {
    return {
      email: 'facility.kengeri@christuniversity.in',
      name: 'Facility & Hospitality Management',
      role: 'facility_management',
    };
  }

  // Look for users matching the role
  let matchingUsers = db.users.filter((u) => u.role === role && u.is_active !== false);

  // If HOD, filter by department
  if (role === 'hod' && departmentId) {
    const deptHod = matchingUsers.find((u) => u.department_id === departmentId);
    if (deptHod) {
      return { email: deptHod.email, name: deptHod.name, role };
    }
  }

  if (matchingUsers.length > 0) {
    return { email: matchingUsers[0].email, name: matchingUsers[0].name, role };
  }

  // Default institutional role fallbacks
  const fallbacks: Record<string, { email: string; name: string }> = {
    hod: { email: 'hod@christ.edu', name: 'Head of Department' },
    deans_office: { email: 'deansoffice@christ.edu', name: "Dean's Office Secretariat" },
    dean: { email: 'dean@christ.edu', name: 'Dean (SoET)' },
    associate_dean: { email: 'associate_dean@christ.edu', name: 'Associate Dean (SoET)' },
    finance: { email: 'finance@christ.edu', name: 'Finance Office' },
    director: { email: 'director@christ.edu', name: 'Campus Director' },
    finance_head: { email: 'financehead@christ.edu', name: 'Chief Finance Officer (Head)' },
    faculty: { email: 'faculty@christ.edu', name: 'Faculty Proposer' },
    super_admin: { email: 'admin@christ.edu', name: 'Super Administrator' },
  };

  const fb = fallbacks[role] || { email: `${role}@christ.edu`, name: role };
  return { email: fb.email, name: fb.name, role };
}

/**
 * Record a mock email delivery.
 */
function recordMockEmail(
  db: DB,
  record: {
    nfaId: string;
    nfaRefNo: string;
    event: string;
    recipientRole: string;
    recipientEmail: string;
    recipientName: string;
    subject: string;
    body: string;
    htmlBody?: string;
    attachmentName?: string;
    hasPdfAttachment: boolean;
  }
): MockEmail {
  if (!db.mock_emails) {
    db.mock_emails = [];
  }

  // Deduplication key
  const dedupeKey = `${record.nfaId}:${record.event}:${record.recipientRole}:${record.recipientEmail}`;
  if (sentNotificationKeys.has(dedupeKey)) {
    console.log(`[MockEmail] Deduplicated skipped: ${dedupeKey}`);
    const existing = db.mock_emails.find((m) => m.nfa_id === record.nfaId && m.event === record.event && m.recipient_email === record.recipientEmail);
    if (existing) return existing;
  }
  sentNotificationKeys.add(dedupeKey);

  let status: 'mock_delivered' | 'failed' = 'mock_delivered';
  let errorMessage: string | undefined;

  if (simulateFailureOnce) {
    status = 'failed';
    errorMessage = 'Simulated delivery failure (testing fault tolerance)';
    simulateFailureOnce = false; // Reset after one failure
  }

  const mockEmail: MockEmail = {
    id: uuid(),
    nfa_id: record.nfaId,
    nfa_ref_no: record.nfaRefNo,
    event: record.event,
    recipient_role: record.recipientRole,
    recipient_email: record.recipientEmail,
    recipient_name: record.recipientName,
    subject: record.subject,
    body: record.body,
    html_body: record.htmlBody,
    attachment_name: record.attachmentName,
    has_pdf_attachment: record.hasPdfAttachment,
    status,
    error_message: errorMessage,
    created_at: new Date().toISOString(),
  };

  db.mock_emails.push(mockEmail);
  console.log(`[MockEmail ${status.toUpperCase()}] To: ${record.recipientName} <${record.recipientEmail}> [${record.recipientRole}] | Event: ${record.event} | Subj: ${record.subject}`);
  return mockEmail;
}

/**
 * Helper to construct clean email body text.
 */
function buildEmailBody(params: {
  greetingName: string;
  nfaRef: string;
  nfaTitle: string;
  facultyName: string;
  orgName: string;
  amount: number;
  actionCompleted: string;
  currentStatus: string;
  nextAuthority: string;
  remarks?: string;
}): { text: string; html: string } {
  const formattedAmt = `₹${params.amount.toLocaleString('en-IN')}`;
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const dashboardLink = 'http://localhost:4000/#nfas';

  const text = `
Dear ${params.greetingName},

This is an automated notification regarding Note for Approval (NFA):

• Reference No: ${params.nfaRef}
• Title: ${params.nfaTitle}
• Proposer: ${params.facultyName}
• Organization: ${params.orgName}
• Requested Amount: ${formattedAmt}
• Action Completed: ${params.actionCompleted}
• Current Status: ${params.currentStatus}
• Next Reviewing Authority: ${params.nextAuthority}
• Timestamp: ${now}
${params.remarks ? `• Remarks: ${params.remarks}\n` : ''}
You may view and act upon this NFA in the university portal:
${dashboardLink}

Regards,
CU-NFA Automated Notification System
School of Engineering and Technology (SoET)
CHRIST (Deemed to be University)
  `.trim();

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
  <div style="background-color: #0f172a; padding: 20px; color: #ffffff;">
    <h2 style="margin: 0; font-size: 18px; font-weight: 600;">CU-NFA Notification</h2>
    <p style="margin: 4px 0 0; font-size: 13px; color: #94a3b8;">CHRIST (Deemed to be University)</p>
  </div>
  <div style="padding: 24px;">
    <p style="margin-top: 0;">Dear <strong>${params.greetingName}</strong>,</p>
    <p>A recent action was completed for Note for Approval (NFA) <strong>${params.nfaRef}</strong>.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
      <tr><td style="padding: 8px 0; color: #64748b; width: 35%;">Reference:</td><td style="padding: 8px 0; font-weight: 600;">${params.nfaRef}</td></tr>
      <tr><td style="padding: 8px 0; color: #64748b;">Title:</td><td style="padding: 8px 0;">${params.nfaTitle}</td></tr>
      <tr><td style="padding: 8px 0; color: #64748b;">Proposer:</td><td style="padding: 8px 0;">${params.facultyName}</td></tr>
      <tr><td style="padding: 8px 0; color: #64748b;">Organization:</td><td style="padding: 8px 0;">${params.orgName}</td></tr>
      <tr><td style="padding: 8px 0; color: #64748b;">Total Amount:</td><td style="padding: 8px 0; font-weight: 600; color: #0f766e;">${formattedAmt}</td></tr>
      <tr><td style="padding: 8px 0; color: #64748b;">Action Completed:</td><td style="padding: 8px 0;">${params.actionCompleted}</td></tr>
      <tr><td style="padding: 8px 0; color: #64748b;">Current Status:</td><td style="padding: 8px 0;"><span style="background-color: #f1f5f9; padding: 2px 8px; border-radius: 4px; font-weight: 500;">${params.currentStatus}</span></td></tr>
      <tr><td style="padding: 8px 0; color: #64748b;">Next Authority:</td><td style="padding: 8px 0; font-weight: 600; color: #1e40af;">${params.nextAuthority}</td></tr>
      ${params.remarks ? `<tr><td style="padding: 8px 0; color: #64748b;">Remarks:</td><td style="padding: 8px 0; font-style: italic;">"${params.remarks}"</td></tr>` : ''}
    </table>
    <div style="margin-top: 24px;">
      <a href="${dashboardLink}" style="background-color: #2563eb; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px; display: inline-block;">Open CU-NFA Dashboard</a>
    </div>
  </div>
  <div style="background-color: #f8fafc; padding: 12px 24px; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
    This is a system generated notification. Please do not reply directly to this email.
  </div>
</div>
  `.trim();

  return { text, html };
}

function isCseOrAdseDept(db: DB, deptId?: string | null): boolean {
  if (!deptId) return false;
  const dept = db.departments.find((d) => d.id === deptId);
  if (!dept) return false;
  const code = (dept.code || '').trim().toUpperCase();
  const name = (dept.name || '').trim().toLowerCase();
  if (code === 'CSE' || code === 'ADSE') return true;
  if (deptId === 'b5643609-22d9-4b21-9ce0-2f6eb5b9d04e' || deptId === '330ada81-5246-4c92-9ca2-688eae0f28d4') return true;
  if (name.includes('computer science') || name.includes('data science') || name.includes('artificial intelligence')) {
    return true;
  }
  return false;
}

/**
 * Dispatches workflow stage notifications based on organizational type and action.
 */
export async function dispatchWorkflowNotification(
  db: DB,
  payload: NotificationEventPayload
): Promise<MockEmail[]> {
  const nfa = payload.nfa;
  const isCentre = nfa.organization_type === 'centre_or_office';
  const isCseOrAdse = !isCentre && isCseOrAdseDept(db, nfa.department_id);
  const org = db.departments.find((d) => d.id === nfa.department_id);
  const orgName = org ? org.name : 'University Department';
  const facultyUser = db.users.find((u) => u.id === nfa.created_by);
  const facultyName = facultyUser ? facultyUser.name : (nfa.submitted_by_name || 'Faculty Proposer');
  const facultyEmail = facultyUser ? facultyUser.email : 'faculty@christ.edu';

  const results: MockEmail[] = [];

  const send = (
    role: Role | 'facility_management',
    recipientEmailOverride?: string,
    recipientNameOverride?: string
  ) => {
    let rec = resolveRecipient(db, role, nfa.department_id);
    if (recipientEmailOverride) {
      rec = {
        email: recipientEmailOverride,
        name: recipientNameOverride || rec.name,
        role: role.toString(),
      };
    }

    const { text, html } = buildEmailBody({
      greetingName: rec.name,
      nfaRef: nfa.ref_no,
      nfaTitle: nfa.title,
      facultyName,
      orgName,
      amount: nfa.total_amount,
      actionCompleted: getActionCompletedLabel(payload.event),
      currentStatus: getStatusDisplayLabel(nfa.status),
      nextAuthority: payload.nextAuthority || getNextAuthorityLabel(payload.event, isCentre, isCseOrAdse),
      remarks: payload.comments,
    });

    const isFinalApproval = payload.event === 'finance_head_approved';
    const email = recordMockEmail(db, {
      nfaId: nfa.id,
      nfaRefNo: nfa.ref_no,
      event: payload.event,
      recipientRole: rec.role,
      recipientEmail: rec.email,
      recipientName: rec.name,
      subject: `[CU-NFA] ${nfa.ref_no} — ${getActionSubjectPrefix(payload.event)}: ${nfa.title}`,
      body: text,
      htmlBody: html,
      hasPdfAttachment: isFinalApproval,
      attachmentName: isFinalApproval ? `NFA_${nfa.ref_no.replace(/[\/\\]/g, '_')}_Approved.pdf` : undefined,
    });
    results.push(email);
  };

  switch (payload.event) {
    case 'nfa_submitted':
      if (isCentre) {
        // Centres or Offices: Faculty submits -> Dean's Office (HOD NEVER notified)
        send('deans_office');
      } else {
        // Department: Faculty submits -> HOD
        send('hod');
      }
      break;

    case 'hod_reviewed':
      // Department only: Faculty + Dean's Office
      send('faculty', facultyEmail, facultyName);
      send('deans_office');
      break;

    case 'deans_office_verified':
      // Workflow A (CSE/ADSE): Faculty + Associate Dean
      // Workflow B (Other Depts) & C (Centres): Faculty + Dean
      send('faculty', facultyEmail, facultyName);
      if (isCseOrAdse) {
        send('associate_dean');
      } else {
        send('dean');
      }
      break;

    case 'associate_dean_approved':
    case 'dean_approved':
      // Faculty + Finance Office
      send('faculty', facultyEmail, facultyName);
      send('finance');
      break;

    case 'finance_office_approved':
      // Both: Faculty + Director
      send('faculty', facultyEmail, facultyName);
      send('director');
      break;

    case 'director_approved':
      // Both: Faculty + Finance Officer (Head)
      send('faculty', facultyEmail, facultyName);
      send('finance_head');
      break;

    case 'finance_head_approved':
      // Final Approved:
      // Department: Faculty + HOD + Finance Office
      // Centres or Offices: Faculty + Finance Office (NO HOD!)
      send('faculty', facultyEmail, facultyName);
      send('finance');
      if (!isCentre) {
        send('hod');
      }

      // Check and dispatch Facility Management notification if applicable
      await checkAndDispatchFacilityNotification(db, nfa, facultyName, facultyEmail, orgName);
      break;

    case 'revision_required':
      // Return to Faculty for Correction
      send('faculty', facultyEmail, facultyName);
      break;

    case 'nfa_resubmitted':
      // Resubmission: Next Reviewer + confirmation to Faculty
      send('faculty', facultyEmail, facultyName);
      if (isCentre) {
        send('deans_office');
      } else {
        send('hod');
      }
      break;

    case 'nfa_rejected':
      // Rejection: Faculty
      send('faculty', facultyEmail, facultyName);
      break;

    case 'nfa_deleted':
      // Deletion: confirmation to Faculty
      send('faculty', facultyEmail, facultyName);
      break;
  }

  return results;
}

/**
 * Inspects Event NFA items for facility management services:
 * Memento, Travel Expenses, Sampling, Refreshments — Forenoon, Refreshments — Afternoon, Lunch
 */
export async function checkAndDispatchFacilityNotification(
  db: DB,
  nfa: Nfa,
  facultyName: string,
  facultyEmail: string,
  orgName: string
): Promise<MockEmail | null> {
  if (nfa.nfa_type === 'purchase') {
    return null; // Purchases never require hospitality/facility management
  }

  const items = db.nfa_items.filter((i) => i.nfa_id === nfa.id);
  const targetKeywords = [
    'memento',
    'travel expense',
    'travel expenses',
    'sampling',
    'refreshments — forenoon',
    'refreshments - forenoon',
    'refreshment — forenoon',
    'forenoon',
    'refreshments — afternoon',
    'refreshments - afternoon',
    'afternoon',
    'lunch',
  ];

  const matchedItems = items.filter((it) => {
    const p = String(it.particulars || '').toLowerCase();
    const key = String(it.predefined_key || '').toLowerCase();
    const isSampling = Boolean(it.sampling_required) || key === 'sampling' || p.includes('sampling');
    const matchesKeyword = targetKeywords.some((kw) => p.includes(kw) || key.includes(kw));
    return matchesKeyword || isSampling;
  });

  if (matchedItems.length === 0) {
    return null; // No relevant hospitality/facility services
  }

  // Generate consolidated Facility Management Notification
  const servicesList = matchedItems.map((it) => {
    const isSampling = Boolean(it.sampling_required) || it.predefined_key === 'sampling' || it.particulars.toLowerCase().includes('sampling');
    return {
      particulars: it.particulars,
      quantity: isSampling ? 'Non-monetary (Arrangement only)' : (it.quantity || '1'),
      rate: isSampling ? '₹0' : (it.rate ? `₹${it.rate}` : undefined),
      amount: isSampling ? 0 : it.amount,
      arrangement: it.carry_back_arrangement || undefined,
      isSampling,
    };
  });

  const eventDetails = nfa.event_details || {};
  const formattedServices = servicesList
    .map(
      (s, idx) =>
        `${idx + 1}. ${s.particulars} | Qty: ${s.quantity}${s.isSampling ? ' (Non-monetary)' : ` | Amt: ₹${s.amount.toLocaleString('en-IN')}`}${s.arrangement ? ` | Arrangement: ${s.arrangement}` : ''}`
    )
    .join('\n');

  const text = `
Dear Facility & Hospitality Management,

This is a consolidated arrangement notification for Fully Approved Event NFA:

• NFA Reference: ${nfa.ref_no}
• Event Title: ${nfa.title}
• Organizing Unit: ${orgName}
• Faculty Coordinator: ${facultyName} (${facultyEmail})
• Event Date: ${eventDetails.event_date || 'As scheduled'}
• Venue: ${eventDetails.venue || 'Campus Auditorium / Seminar Hall'}
• Additional Details: ${eventDetails.additional_info || 'None specified'}

Required Campus Services & Hospitality:
${formattedServices}

Note: Sampling is non-monetary and requires logistics/booth arrangement only.
The final approved NFA PDF is attached.

Regards,
CU-NFA Campus Automation System
CHRIST (Deemed to be University)
  `.trim();

  const html = `
<div style="font-family: sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px;">
  <div style="background-color: #1e3a8a; padding: 20px; color: #ffffff;">
    <h2 style="margin: 0; font-size: 18px;">Facility & Hospitality Service Order</h2>
    <p style="margin: 4px 0 0; font-size: 13px; color: #93c5fd;">Fully Approved NFA: ${nfa.ref_no}</p>
  </div>
  <div style="padding: 24px;">
    <p>Dear <strong>Facility & Hospitality Management</strong>,</p>
    <p>The following campus hospitality arrangements have been officially approved:</p>
    <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 16px 0;">
      <tr style="background-color: #f1f5f9;"><th style="padding: 6px; text-align: left;">Service</th><th style="padding: 6px; text-align: left;">Quantity</th><th style="padding: 6px; text-align: left;">Details</th></tr>
      ${servicesList
        .map(
          (s) =>
            `<tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 8px 6px;"><strong>${s.particulars}</strong></td><td style="padding: 8px 6px;">${s.quantity}</td><td style="padding: 8px 6px;">${s.isSampling ? '<span style="color: #0284c7; font-weight: 500;">Sampling (Non-monetary)</span>' : `₹${s.amount.toLocaleString('en-IN')}`}${s.arrangement ? `<br><small>${s.arrangement}</small>` : ''}</td></tr>`
        )
        .join('')}
    </table>
    <p style="font-size: 13px; color: #64748b;">
      <strong>Event Date:</strong> ${eventDetails.event_date || 'TBD'}<br>
      <strong>Venue:</strong> ${eventDetails.venue || 'Campus Venue'}<br>
      <strong>Faculty Coordinator:</strong> ${facultyName} (${facultyEmail})
    </p>
  </div>
</div>
  `.trim();

  const recipient = resolveRecipient(db, 'facility_management');
  return recordMockEmail(db, {
    nfaId: nfa.id,
    nfaRefNo: nfa.ref_no,
    event: 'facility_management_order',
    recipientRole: 'facility_management',
    recipientEmail: recipient.email,
    recipientName: recipient.name,
    subject: `[Facility Order] ${nfa.ref_no} — Services for ${nfa.title}`,
    body: text,
    htmlBody: html,
    hasPdfAttachment: true,
    attachmentName: `NFA_${nfa.ref_no.replace(/[\/\\]/g, '_')}_Approved.pdf`,
  });
}

function getActionCompletedLabel(event: string): string {
  const map: Record<string, string> = {
    nfa_submitted: 'NFA Proposal Submitted',
    hod_reviewed: 'Reviewed & Endorsed by HOD',
    deans_office_verified: "Verified by Dean's Office",
    associate_dean_approved: 'Approved by Associate Dean',
    dean_approved: 'Approved by Dean',
    finance_office_approved: 'Approved by Finance Office',
    director_approved: 'Approved by Campus Director',
    finance_head_approved: 'Final Approved & Budget Debited by Chief Finance Officer',
    revision_required: 'Returned to Faculty for Correction',
    nfa_resubmitted: 'Resubmitted by Faculty after Correction',
    nfa_rejected: 'Proposal Rejected',
    nfa_deleted: 'NFA Deleted',
  };
  return map[event] || event;
}

function getActionSubjectPrefix(event: string): string {
  const map: Record<string, string> = {
    nfa_submitted: 'New NFA Submitted',
    hod_reviewed: 'HOD Endorsement Completed',
    deans_office_verified: "Dean's Office Verified",
    associate_dean_approved: 'Associate Dean Approved',
    dean_approved: 'Dean Approved',
    finance_office_approved: 'Finance Office Approved',
    director_approved: 'Director Approved',
    finance_head_approved: 'FINAL FULL APPROVAL',
    revision_required: 'Action Required: Returned for Correction',
    nfa_resubmitted: 'NFA Resubmitted',
    nfa_rejected: 'NFA Rejected',
    nfa_deleted: 'NFA Deleted',
  };
  return map[event] || 'Update';
}

function getStatusDisplayLabel(status: string): string {
  const map: Record<string, string> = {
    draft: 'Draft',
    submitted: 'Pending HOD Review',
    pending_hod_review: 'Pending HOD Review',
    pending_deans_office_verification: "Pending Dean's Office Verification",
    pending_associate_dean_approval: 'Pending Associate Dean Approval',
    dean_review: 'Pending Dean Approval',
    pending_dean_approval: 'Pending Dean Approval',
    accounts_review: 'Pending Finance Office Approval',
    pending_finance_office_approval: 'Pending Finance Office Approval',
    pending_director_approval: 'Pending Director Approval',
    pending_finance_head_approval: 'Pending Finance Head Approval',
    approved: 'Fully Approved',
    revision_required: 'Returned for Correction',
    rejected: 'Rejected',
  };
  return map[status] || status;
}

function getNextAuthorityLabel(event: string, isCentre: boolean, isCseOrAdse?: boolean): string {
  switch (event) {
    case 'nfa_submitted':
      return isCentre ? "Dean's Office" : 'Head of Department (HOD)';
    case 'hod_reviewed':
      return "Dean's Office";
    case 'deans_office_verified':
      return isCseOrAdse ? 'Associate Dean (SoET)' : 'Dean (SoET)';
    case 'associate_dean_approved':
    case 'dean_approved':
      return 'Finance Office';
    case 'finance_office_approved':
      return 'Campus Director';
    case 'director_approved':
      return 'Chief Finance Officer (Head)';
    case 'finance_head_approved':
      return 'Completed (Fully Approved)';
    case 'revision_required':
      return 'Faculty Proposer';
    case 'nfa_resubmitted':
      return isCentre ? "Dean's Office" : 'Head of Department (HOD)';
    case 'nfa_rejected':
    case 'nfa_deleted':
      return 'None';
    default:
      return 'Next Reviewing Authority';
  }
}
