import { Resend } from 'resend';
import { v4 as uuid } from 'uuid';
import { store } from '../store.js';
import type { MockEmail } from '../types.js';

/**
 * Resend & Mock Email Testing Service for CU-NFA Management System.
 * Dedicated testing service and future delivery gateway.
 *
 * Normal institutional NFA notifications strictly adhere to EMAIL_PROVIDER=mock.
 * Email testing is available to Super Admin when EMAIL_TEST_MODE=true (defaulting to safe mock testing).
 */

// In-memory rate limiting tracker (timestamp of last test send)
let lastTestSendTimestamp = 0;
const TEST_EMAIL_COOLDOWN_MS = 5000; // 5-second cooldown between test sends

export interface ResendConfigStatus {
  isDevelopment: boolean;
  emailTestMode: boolean;
  isTestingAllowed: boolean;
  isProduction: boolean;
  emailProvider: string;
  fromEmail: string;
  hasApiKey: boolean;
  hasTestRecipient: boolean;
  testRecipientMasked: string;
  canSendLiveResend: boolean;
  canSendMock: boolean;
  rateLimitCooldownSeconds: number;
}

export interface SendTestEmailResult {
  success: boolean;
  mode: 'mock' | 'resend';
  messageId?: string;
  recipient: string;
  status: string;
  note: string;
  error?: string;
  mockEmail?: MockEmail;
}

/**
 * Helper to safely mask recipient email for display in UI/logs without exposing full PII.
 */
export function maskEmail(email?: string): string {
  if (!email || !email.includes('@')) return 'Not configured';
  const [local, domain] = email.trim().split('@');
  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }
  return `${local.slice(0, 2)}***${local.slice(-1)}@${domain}`;
}

/**
 * Checks whether email testing features are enabled.
 * Decouples email testing permissions from NODE_ENV=production.
 * Enabled if EMAIL_TEST_MODE is true, 1, yes, enabled, or if left unset (defaulting to safe mock testing).
 * Explicitly disabled only when EMAIL_TEST_MODE is 'false', '0', 'no', or 'disabled'.
 */
export function isEmailTestingEnabled(): boolean {
  const envVal = (process.env.EMAIL_TEST_MODE ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'disabled'].includes(envVal);
}

/**
 * Retrieves the Resend client instance.
 * Lazy initialization on backend only; never exposes API key.
 */
export function getResendClient(): Resend | null {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return null;
  return new Resend(apiKey);
}

/**
 * Inspects current environment configuration for Resend and Mock testing without revealing secrets.
 */
export function getResendConfigStatus(): ResendConfigStatus {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';
  const isDevelopment = !isProduction;
  const isTestingAllowed = isEmailTestingEnabled();
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const testRecipient = (process.env.RESEND_TEST_RECIPIENT || '').trim();
  const fromEmail = (process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev').trim();
  const emailProvider = (process.env.EMAIL_PROVIDER || 'mock').trim().toLowerCase();
  const hasApiKey = Boolean(apiKey && apiKey.length > 5);
  const hasTestRecipient = Boolean(testRecipient && testRecipient.includes('@'));

  return {
    isDevelopment,
    emailTestMode: isTestingAllowed,
    isTestingAllowed,
    isProduction,
    emailProvider,
    fromEmail,
    hasApiKey,
    hasTestRecipient,
    testRecipientMasked: maskEmail(testRecipient),
    canSendLiveResend: isTestingAllowed && hasApiKey && hasTestRecipient,
    canSendMock: isTestingAllowed,
    rateLimitCooldownSeconds: Math.round(TEST_EMAIL_COOLDOWN_MS / 1000),
  };
}

/**
 * Resets the in-memory test email rate limiting timestamp (useful for unit/integration tests).
 */
export function resetTestEmailRateLimit(): void {
  lastTestSendTimestamp = 0;
}

/**
 * Dedicated Super Admin test email execution.
 *
 * Supports two distinct modes:
 * 1. 'mock' (Default): Generates a simulated institutional email, logs it to store.data.mock_emails
 *    and audit logs with status 'mock_delivered'. ZERO external network calls or real emails sent.
 * 2. 'resend': Sends a single real integration verification email ONLY to the allowlisted
 *    RESEND_TEST_RECIPIENT. Client-supplied recipients are strictly ignored.
 *
 * Security & Guardrails:
 * - Requires EMAIL_TEST_MODE to be enabled.
 * - Enforces server-side 5-second cooldown rate limit.
 * - Restricts live delivery strictly to process.env.RESEND_TEST_RECIPIENT.
 * - Audit logs all test actions.
 */
export async function sendSuperAdminTestEmail(options?: {
  mode?: 'mock' | 'resend';
  clientOverride?: Resend | null;
  skipRateLimit?: boolean;
  actor?: { id: string; name: string; role: string; email: string };
}): Promise<SendTestEmailResult> {
  const config = getResendConfigStatus();

  // Guard 1: Verify email test mode is allowed
  if (!config.isTestingAllowed) {
    throw new Error('Email testing is disabled in production. Set EMAIL_TEST_MODE=true in environment variables to enable testing.');
  }

  // Guard 2: Server-side rate limiting
  const now = Date.now();
  if (!options?.skipRateLimit && now - lastTestSendTimestamp < TEST_EMAIL_COOLDOWN_MS) {
    const remaining = Math.ceil((TEST_EMAIL_COOLDOWN_MS - (now - lastTestSendTimestamp)) / 1000);
    throw new Error(`Rate limit exceeded. Please wait ${remaining} second(s) before sending another test email.`);
  }

  // Determine delivery mode: explicit override, clientOverride, or determined by environment
  let mode: 'mock' | 'resend' = options?.mode || (options?.clientOverride !== undefined || (config.hasApiKey && config.emailProvider === 'resend') ? 'resend' : 'mock');

  const textBody = `
Hello,

This is a test notification from the CU-NFA Management System.

Your email notification integration is working if you receive this message.
Mode: ${mode.toUpperCase()}
Environment: ${config.isProduction ? 'Production' : 'Development'}

This is a testing notification. No financial or administrative action is required.

CU-NFA Management System
School of Engineering and Technology (SoET) · Bangalore Kengeri Campus
`.trim();

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CU-NFA Email Integration Test</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1e293b; background-color: #f8fafc; padding: 24px; margin: 0;">
  <div style="max-width: 580px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
    <div style="background-color: #003D8F; padding: 20px 24px; color: #ffffff;">
      <h2 style="margin: 0; font-size: 18px; font-weight: 600;">CU-NFA — Email Integration Test</h2>
      <p style="margin: 4px 0 0; font-size: 13px; color: #bfdbfe;">CHRIST (Deemed to be University) · System Notification</p>
    </div>
    <div style="padding: 28px 24px;">
      <p style="margin-top: 0; font-size: 15px;">Hello,</p>
      <p style="font-size: 14px; color: #334155;">This is a test notification from the <strong>CU-NFA Management System</strong>.</p>
      <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 14px 16px; margin: 18px 0; color: #166534; font-size: 14px;">
        <strong>Integration Active:</strong> Mode: <code>${mode.toUpperCase()}</code> · System notification pipeline is functional.
      </div>
      <p style="font-size: 13px; color: #64748b; margin-bottom: 24px;">This is a testing notification. No action is required.</p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="margin: 0; font-size: 13px; font-weight: 600; color: #003D8F;">CU-NFA Management System</p>
      <p style="margin: 2px 0 0; font-size: 12px; color: #94a3b8;">School of Engineering and Technology (SoET) · Bangalore Kengeri Campus</p>
    </div>
    <div style="background-color: #f8fafc; padding: 12px 24px; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; text-align: center;">
      Delivered via ${mode === 'resend' ? 'Resend Live Gateway' : 'Mock Outbox Simulator'} · Environment: ${config.isProduction ? 'Production' : 'Development'}
    </div>
  </div>
</body>
</html>
`.trim();

  // --------------------------------------------------------------------------
  // BRANCH 1: MOCK EMAIL DELIVERY (Zero external calls, 100% safe)
  // --------------------------------------------------------------------------
  if (mode === 'mock') {
    const rawRecipient = (process.env.RESEND_TEST_RECIPIENT || options?.actor?.email || 'admin@christ.edu').trim();
    const mockId = uuid();
    const refNo = `TEST-EMAIL-${Math.floor(1000 + Math.random() * 9000)}`;

    const mockEmail: MockEmail = {
      id: mockId,
      nfa_id: 'test-admin-email',
      nfa_ref_no: refNo,
      event: 'admin_test_email',
      recipient_role: options?.actor?.role || 'super_admin',
      recipient_email: rawRecipient,
      recipient_name: options?.actor?.name || 'Super Administrator',
      subject: 'CU-NFA — Mock Email Integration Test',
      body: textBody,
      html_body: htmlBody,
      attachment_name: undefined,
      has_pdf_attachment: false,
      status: 'mock_delivered',
      created_at: new Date().toISOString(),
    };

    store.data.mock_emails = store.data.mock_emails || [];
    store.data.mock_emails.push(mockEmail);

    // Audit log
    store.data.audit_logs = store.data.audit_logs || [];
    store.data.audit_logs.push({
      id: uuid(),
      entity_type: 'user_account',
      entity_id: options?.actor?.id || 'admin',
      department_id: 'ALL',
      old_amount: null,
      new_amount: 0,
      difference: 0,
      changed_by: options?.actor?.id || 'admin',
      role: 'super_admin',
      reason: `Super Admin executed mock email test. Delivered to simulated outbox for ${mockEmail.recipient_name} <${maskEmail(mockEmail.recipient_email)}> (Zero real emails sent).`,
      source: 'portal',
      approval_status: 'approved',
      created_at: new Date().toISOString(),
    });

    lastTestSendTimestamp = Date.now();
    console.log(`[MockEmail OK] Admin mock test email recorded. ID: ${mockId} | Target: ${maskEmail(rawRecipient)}`);

    return {
      success: true,
      mode: 'mock',
      messageId: `mock_${mockId.slice(0, 8)}`,
      recipient: maskEmail(rawRecipient),
      status: 'Mock Delivered',
      note: 'Simulated institutional outbox delivery. Recorded to mock email audit store (Zero real emails sent to faculty/staff).',
      mockEmail,
    };
  }

  // --------------------------------------------------------------------------
  // BRANCH 2: RESEND LIVE GATEWAY DELIVERY
  // --------------------------------------------------------------------------
  const resend = options?.clientOverride !== undefined ? options.clientOverride : getResendClient();
  if (!resend) {
    throw new Error(
      'RESEND_API_KEY is not configured in the backend environment. Please verify that RESEND_API_KEY is set in your .env or Render dashboard.'
    );
  }

  // Recipient MUST strictly come from process.env.RESEND_TEST_RECIPIENT
  const recipient = (process.env.RESEND_TEST_RECIPIENT || '').trim();
  if (!recipient || !recipient.includes('@')) {
    throw new Error(
      'RESEND_TEST_RECIPIENT is not configured in your backend environment. Add your registered Resend email address (e.g. RESEND_TEST_RECIPIENT=your-email@example.com) to receive test emails.'
    );
  }

  const fromEmail = config.fromEmail;
  const subject = 'CU-NFA — Email Integration Test';

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: [recipient],
      subject,
      text: textBody,
      html: htmlBody,
    });

    if (error) {
      console.error('[Resend Error]:', error.name, error.message);
      throw new Error(`Resend delivery failed: ${error.message}`);
    }

    lastTestSendTimestamp = Date.now();
    const messageId = data?.id || 'resend-ack-ok';
    console.log(`[Resend OK] Test email accepted by Resend API. ID: ${messageId} | Recipient: ${maskEmail(recipient)}`);

    // Audit log
    store.data.audit_logs = store.data.audit_logs || [];
    store.data.audit_logs.push({
      id: uuid(),
      entity_type: 'user_account',
      entity_id: options?.actor?.id || 'admin',
      department_id: 'ALL',
      old_amount: null,
      new_amount: 0,
      difference: 0,
      changed_by: options?.actor?.id || 'admin',
      role: 'super_admin',
      reason: `Super Admin executed live Resend test email. Destination: ${maskEmail(recipient)}. Message ID: ${messageId}`,
      source: 'portal',
      approval_status: 'approved',
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      mode: 'resend',
      messageId,
      recipient: maskEmail(recipient),
      status: 'Accepted by Resend',
      note: 'The delivery request was successfully accepted by the Resend API. Check your inbox (or Resend Dashboard) for delivery status.',
    };
  } catch (err: any) {
    console.error('[Resend Exception]:', err.message);
    throw err;
  }
}
