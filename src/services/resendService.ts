import { Resend } from 'resend';

/**
 * Resend Email Service for CU-NFA Management System.
 * Dedicated testing service and future delivery gateway.
 *
 * Normal institutional NFA notifications strictly adhere to EMAIL_PROVIDER=mock.
 * Real email sending is isolated strictly to the manual Super Admin Email Testing feature in development.
 */

// In-memory rate limiting tracker (timestamp of last test send)
let lastTestSendTimestamp = 0;
const TEST_EMAIL_COOLDOWN_MS = 5000; // 5-second cooldown between test sends

export interface ResendConfigStatus {
  isDevelopment: boolean;
  emailProvider: string;
  fromEmail: string;
  hasApiKey: boolean;
  hasTestRecipient: boolean;
  testRecipientMasked: string;
}

export interface SendTestEmailResult {
  success: boolean;
  messageId?: string;
  recipient: string;
  status: string;
  note: string;
  error?: string;
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
 * Retrieves the Resend client instance.
 * Lazy initialization on backend only; never exposes API key.
 */
export function getResendClient(): Resend | null {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return null;
  return new Resend(apiKey);
}

/**
 * Inspects current environment configuration for Resend without revealing secrets.
 */
export function getResendConfigStatus(): ResendConfigStatus {
  const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.APP_ENV !== 'production';
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const testRecipient = (process.env.RESEND_TEST_RECIPIENT || '').trim();
  const fromEmail = (process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev').trim();
  const emailProvider = (process.env.EMAIL_PROVIDER || 'mock').trim().toLowerCase();

  return {
    isDevelopment,
    emailProvider,
    fromEmail,
    hasApiKey: Boolean(apiKey && apiKey.length > 5),
    hasTestRecipient: Boolean(testRecipient && testRecipient.includes('@')),
    testRecipientMasked: maskEmail(testRecipient),
  };
}

/**
 * Dedicated Super Admin test email execution.
 * Sends a single non-monetary integration verification email to the backend-configured RESEND_TEST_RECIPIENT.
 *
 * Security & Guardrails:
 * - Blocked in production environments.
 * - Enforces server-side 5-second cooldown rate limit.
 * - Uses ONLY the backend-configured recipient (ignores any client-passed address).
 * - Distinguishes "Accepted by Resend" from "Delivered to inbox".
 */
export function resetTestEmailRateLimit(): void {
  lastTestSendTimestamp = 0;
}

export async function sendSuperAdminTestEmail(options?: {
  clientOverride?: Resend | null;
  skipRateLimit?: boolean;
}): Promise<SendTestEmailResult> {
  const config = getResendConfigStatus();

  // Guard 1: Local development / staging only — never production
  if (!config.isDevelopment && process.env.NODE_ENV === 'production') {
    throw new Error('Email testing is restricted to development environments and disabled in production.');
  }

  // Guard 2: Server-side rate limiting
  const now = Date.now();
  if (!options?.skipRateLimit && now - lastTestSendTimestamp < TEST_EMAIL_COOLDOWN_MS) {
    const remaining = Math.ceil((TEST_EMAIL_COOLDOWN_MS - (now - lastTestSendTimestamp)) / 1000);
    throw new Error(`Rate limit exceeded. Please wait ${remaining} second(s) before sending another test email.`);
  }

  // Guard 3: Validate API key presence
  const resend = options?.clientOverride !== undefined ? options.clientOverride : getResendClient();
  if (!resend) {
    throw new Error(
      'RESEND_API_KEY is not configured in the backend environment. Please verify that RESEND_API_KEY is set in your .env file.'
    );
  }

  // Guard 4: Validate configured test recipient
  const recipient = (process.env.RESEND_TEST_RECIPIENT || '').trim();
  if (!recipient || !recipient.includes('@')) {
    throw new Error(
      'RESEND_TEST_RECIPIENT is not configured in your backend .env file. Add your registered Resend email address (e.g. RESEND_TEST_RECIPIENT=your-email@example.com) to receive test emails.'
    );
  }

  const fromEmail = config.fromEmail;
  const subject = 'CU-NFA — Email Integration Test';

  const textBody = `
Hello,

This is a test email from the CU-NFA Management System.

Your email notification integration is working if you receive this message.

This is a testing notification. No action is required.

CU-NFA Management System
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
      <p style="font-size: 14px; color: #334155;">This is a test email from the <strong>CU-NFA Management System</strong>.</p>
      <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 14px 16px; margin: 18px 0; color: #166534; font-size: 14px;">
        <strong>Integration Active:</strong> Your email notification integration is working if you receive this message.
      </div>
      <p style="font-size: 13px; color: #64748b; margin-bottom: 24px;">This is a testing notification. No action is required.</p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="margin: 0; font-size: 13px; font-weight: 600; color: #003D8F;">CU-NFA Management System</p>
      <p style="margin: 2px 0 0; font-size: 12px; color: #94a3b8;">School of Engineering and Technology (SoET) · Bangalore Kengeri Campus</p>
    </div>
    <div style="background-color: #f8fafc; padding: 12px 24px; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; text-align: center;">
      Delivered via Resend Integration · Environment: Development/Staging
    </div>
  </div>
</body>
</html>
`.trim();

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

    return {
      success: true,
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
