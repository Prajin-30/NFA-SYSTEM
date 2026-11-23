import { v4 as uuid } from 'uuid';
import { store } from '../store.js';
import type { Nfa, MockEmail, EventRevenueReminder } from '../types.js';

export async function sendRevenueReminderNotification(nfa: Nfa, completedByName: string): Promise<EventRevenueReminder> {
  const creator = store.data.users.find((u) => u.id === nfa.created_by);
  const recipientEmail = creator?.email || 'faculty@christuniversity.in';
  const recipientName = creator?.name || nfa.submitted_by_name || 'Faculty Member';

  const subject = `[Action Required] Revenue Submission Reminder: ${nfa.ref_no} - ${nfa.title}`;
  const body = `Dear ${recipientName},

Your event "${nfa.title}" (Ref: ${nfa.ref_no}) has been marked as COMPLETED by ${completedByName}.

As this event was approved as a revenue-generating initiative, please log all collected earnings (registration fees, sponsorships, participation fees, or other income) along with supporting receipt vouchers or bank credit advice in the CU-NFA portal:

1. Navigate to: Financial Records > Revenue & Earnings
2. Click "Record Revenue / Earnings"
3. Select Note for Approval: ${nfa.ref_no}
4. Enter the collection amount, source, and attach payment proofs
5. Submit for Finance Office verification

Event Details:
- Reference No: ${nfa.ref_no}
- Approved Budget: ₹${Number(nfa.total_amount).toLocaleString('en-IN')}
- Completion Date: ${nfa.event_completion_date || new Date().toISOString().slice(0, 10)}
- Remarks: ${nfa.event_completion_remarks || 'Event concluded successfully'}

Important Note:
All revenue entries are recorded in the institutional Revenue & Earnings ledger for university reporting and reconciliation.

Warm regards,
Finance Office / Dean's Office
CHRIST (Deemed to be University)`;

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #003D8F; color: #ffffff; padding: 20px 24px;">
        <h2 style="margin: 0; font-size: 18px;">CHRIST (Deemed to be University)</h2>
        <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Note for Approval Management System</p>
      </div>
      <div style="padding: 24px;">
        <h3 style="color: #003D8F; margin-top: 0;">Action Required: Revenue Submission Reminder</h3>
        <p>Dear <strong>${recipientName}</strong>,</p>
        <p>Your event <strong>"${nfa.title}"</strong> (Ref: <code>${nfa.ref_no}</code>) has been officially marked as <strong>COMPLETED</strong> by ${completedByName}.</p>
        <div style="background-color: #f8fafc; border-left: 4px solid #003D8F; padding: 12px 16px; margin: 16px 0;">
          <p style="margin: 2px 0;"><strong>NFA Reference:</strong> ${nfa.ref_no}</p>
          <p style="margin: 2px 0;"><strong>Approved Budget:</strong> ₹${Number(nfa.total_amount).toLocaleString('en-IN')}</p>
          <p style="margin: 2px 0;"><strong>Completion Date:</strong> ${nfa.event_completion_date || new Date().toISOString().slice(0, 10)}</p>
        </div>
        <p>Please log all collected revenues in the CU-NFA system under <strong>Financial Records &gt; Revenue &amp; Earnings</strong> for Finance Office verification.</p>
      </div>
      <div style="background-color: #f1f5f9; padding: 12px 24px; font-size: 11px; color: #64748b; text-align: center;">
        This is an automated notification from CHRIST (Deemed to be University) NFA System.
      </div>
    </div>
  `;

  const mockEmail: MockEmail = {
    id: uuid(),
    nfa_id: nfa.id,
    nfa_ref_no: nfa.ref_no,
    event: 'event_revenue_reminder',
    recipient_role: creator?.role || 'faculty',
    recipient_email: recipientEmail,
    recipient_name: recipientName,
    subject,
    body,
    html_body: htmlBody,
    has_pdf_attachment: false,
    status: 'mock_delivered',
    created_at: new Date().toISOString(),
  };

  const reminder: EventRevenueReminder = {
    id: uuid(),
    nfa_id: nfa.id,
    sent_to: nfa.created_by,
    sent_to_email: recipientEmail,
    sent_at: new Date().toISOString(),
    status: 'mock_delivered',
    created_at: new Date().toISOString(),
  };

  await store.transact((db) => {
    db.mock_emails = db.mock_emails || [];
    db.mock_emails.push(mockEmail);

    db.event_revenue_reminders = db.event_revenue_reminders || [];
    db.event_revenue_reminders.push(reminder);

    db.audit_logs.push({
      id: uuid(),
      entity_type: 'event_revenue',
      entity_id: reminder.id,
      department_id: nfa.department_id,
      old_amount: null,
      new_amount: null,
      difference: null,
      changed_by: nfa.event_completed_by || nfa.created_by,
      role: 'faculty',
      reason: `Revenue submission reminder dispatched to ${recipientEmail} for completed event NFA ${nfa.ref_no}`,
      source: 'portal',
      approval_status: 'reminder_dispatched',
      created_at: new Date().toISOString(),
    });
  });

  return reminder;
}
