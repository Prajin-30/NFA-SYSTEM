import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import { store } from '../store.js';
import { requireAuth, signToken, revokeToken, AuthedRequest } from '../middleware/auth.js';
import { securityService } from '../services/securityService.js';
import {
  authenticateInstitutionalUser,
  maskEmail,
  updateUserPassword,
  validatePasswordStrength,
  validateUniversityEmail,
  resolveUsernameToEmail,
  auditUsernameConflicts,
  getSystemMode,
  setRuntimeMode,
} from '../services/supabaseAuth.js';

export const authRouter = Router();

/**
 * GET /api/auth/mode
 * Informs frontend whether system is in 'demo' or 'institutional' mode.
 */
authRouter.get('/mode', (_req, res) => {
  const mode = getSystemMode();
  res.json({
    mode,
    institution: 'CHRIST (Deemed to be University)',
    env: process.env.APP_ENV || 'development',
  });
});

/**
 * POST /api/auth/mode
 * Allows switching operating mode in development/testing.
 * Strictly forbidden in production.
 */
authRouter.post('/mode', (req, res) => {
  if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
    return res.status(403).json({ error: 'Mode switching is disabled in production.' });
  }
  const { mode } = req.body || {};
  if (mode !== 'demo' && mode !== 'institutional') {
    return res.status(400).json({ error: "Invalid mode. Must be 'demo' or 'institutional'." });
  }
  setRuntimeMode(mode);
  res.json({
    success: true,
    mode: getSystemMode(),
    message: `Switched system operating mode to ${mode}.`,
  });
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Authenticates user, verifies active status, and flags mandatory password change.
 */
authRouter.post('/login', async (req, res) => {
  try {
    const rawIdentifier = (req.body?.email || req.body?.username || req.body?.identifier || '').toString().trim();
    const { password } = req.body || {};
    if (!rawIdentifier || !password) {
      return res.status(400).json({ error: 'Username or Official Email ID and Password are required' });
    }

    const resolved = await resolveUsernameToEmail(rawIdentifier);
    if (resolved.ambiguous) {
      return res.status(400).json({ error: resolved.error || 'Ambiguous username prefix. Multiple accounts match. Please sign in with your full university email.' });
    }

    const targetEmail = resolved.email || rawIdentifier;

    const { user, must_change_password } = await authenticateInstitutionalUser(
      targetEmail,
      String(password)
    );

    const userSchool = user.school || (['super_admin', 'director', 'finance', 'finance_head', 'dean', 'associate_dean', 'deans_office'].includes(user.role) ? 'SoET' : null);
    const userCentres = Array.isArray((user as any).authorized_centre_ids) ? (user as any).authorized_centre_ids : [];

    // Multi-Factor Authentication Challenge
    const mfaSetting = (store.data.user_mfa_settings || []).find((m) => m.user_id === user.id && m.mfa_enabled);
    if (mfaSetting && mfaSetting.mfa_enabled) {
      const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
      const mfaTicket = jwt.sign(
        { id: user.id, email: user.email, role: user.role, mfa_pending: true },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({
        mfa_required: true,
        mfa_ticket: mfaTicket,
        email: user.email,
        message: 'Multi-Factor Authentication required. Enter the 6-digit verification code from your authenticator application.',
      });
    }

    let token: string;
    try {
      token = signToken({
        id: user.id,
        role: user.role,
        department_id: user.department_id,
        authorized_centre_ids: userCentres,
        school: userSchool,
        name: user.name,
        email: user.email,
        must_change_password,
        is_active: user.is_active,
      });
    } catch (jwtErr: any) {
      console.error(`[Auth Failure] Category: JWT_ERROR | Detail: ${jwtErr?.message || jwtErr}`);
      throw new Error(`JWT_ERROR: ${jwtErr?.message || 'Token generation failed'}`);
    }

    // Reset failed login counter and audit success
    securityService.clearFailedLogins(req.ip || '127.0.0.1', user.email);
    securityService.logEvent({
      user_id: user.id,
      user_email: user.email,
      user_role: user.role,
      ip_address: req.ip,
      user_agent: (req.headers['user-agent'] as string) || null,
      action: 'LOGIN_SUCCESS',
      resource_type: 'auth',
      status: 'success',
      severity: 'info',
    });

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department_id: user.department_id,
        authorized_centre_ids: userCentres,
        school: userSchool,
        must_change_password,
      },
      must_change_password,
    });
  } catch (err: any) {
    const rawMessage = String(err?.message || 'Authentication failed');
    const rawTarget = (req.body?.email || req.body?.username || req.body?.identifier || 'unknown').toString().trim();
    const masked = maskEmail(rawTarget);

    if (rawMessage.includes('deactivated')) {
      console.warn(`[Auth Failure] Category: ACCOUNT_DEACTIVATED | Target: ${masked}`);
      return res.status(401).json({ error: rawMessage });
    }

    if (rawMessage === 'INVALID_CREDENTIALS' || rawMessage.includes('Invalid email or password')) {
      console.warn(`[Auth Failure] Category: INVALID_CREDENTIALS | Target: ${masked}`);
    } else if (rawMessage.startsWith('SUPABASE_API_ERROR')) {
      console.error(`[Auth Failure] Category: SUPABASE_API_ERROR | Target: ${masked} | Detail: ${rawMessage}`);
    } else if (rawMessage === 'DATABASE_UNAVAILABLE') {
      console.error(`[Auth Failure] Category: DATABASE_UNAVAILABLE | Target: ${masked}`);
    } else if (rawMessage === 'AUTH_CONFIGURATION_ERROR') {
      console.error(`[Auth Failure] Category: AUTH_CONFIGURATION_ERROR | Target: ${masked}`);
    } else if (rawMessage === 'PROFILE_NOT_FOUND') {
      console.warn(`[Auth Failure] Category: PROFILE_NOT_FOUND | Target: ${masked}`);
    } else if (rawMessage.startsWith('JWT_ERROR')) {
      console.error(`[Auth Failure] Category: JWT_ERROR | Target: ${masked} | Detail: ${rawMessage}`);
    } else if (rawMessage.includes('not authorized')) {
      console.warn(`[Auth Failure] Category: UNAUTHORIZED_DOMAIN | Target: ${masked}`);
    } else {
      console.error(`[Auth Failure] Category: UNEXPECTED_ERROR | Target: ${masked} | Name: ${err?.name || 'Error'} | Message: ${rawMessage}`);
    }

    const bruteCheck = securityService.recordFailedLogin(req.ip || '127.0.0.1', rawTarget);
    securityService.logEvent({
      user_email: rawTarget,
      ip_address: req.ip,
      user_agent: (req.headers['user-agent'] as string) || null,
      action: 'LOGIN_FAILURE',
      resource_type: 'auth',
      status: 'failure',
      severity: bruteCheck.isBruteForce ? 'high' : 'low',
      metadata: { reason: rawMessage, attemptCount: bruteCheck.attemptCount },
    });

    if (bruteCheck.isBruteForce) {
      return res.status(429).json({
        error: 'TOO_MANY_FAILED_LOGINS',
        message: 'Account access temporarily restricted due to repeated failed logins. Please try again after 10 minutes.',
      });
    }

    return res.status(401).json({ error: 'Invalid email or password' });
  }
});

/**
 * POST /api/auth/change-password
 * Protected by requireAuth (allowed when must_change_password is true).
 * Validates password strength, updates password, and clears must_change_password flag.
 */
authRouter.post('/change-password', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { new_password, newPassword, confirm_password, confirmPassword } = req.body || {};
    const candidate = new_password || newPassword;
    const confirm = confirm_password || confirmPassword;

    if (!candidate) {
      return res.status(400).json({ error: 'New password is required' });
    }

    if (confirm && candidate !== confirm) {
      return res.status(400).json({ error: 'New passwords do not match' });
    }

    const strength = validatePasswordStrength(candidate);
    if (!strength.valid) {
      return res.status(400).json({ error: strength.error });
    }

    const userId = req.user!.id;
    await updateUserPassword(userId, candidate);

    // Issue updated token with must_change_password = false
    const refreshedToken = signToken({
      id: req.user!.id,
      role: req.user!.role,
      department_id: req.user!.department_id,
      authorized_centre_ids: req.user!.authorized_centre_ids || [],
      school: req.user!.school,
      name: req.user!.name,
      email: req.user!.email,
      must_change_password: false,
      is_active: true,
    });

    return res.json({
      success: true,
      message: 'Password changed successfully',
      token: refreshedToken,
      must_change_password: false,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Failed to change password' });
  }
});

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Validates official institutional email domain and initiates password recovery.
 */
authRouter.post('/forgot-password', async (req, res) => {
  try {
    const rawIdentifier = (req.body?.email || req.body?.username || req.body?.identifier || '').toString().trim();
    if (!rawIdentifier) {
      return res.status(400).json({ error: 'Official Email ID or Username is required' });
    }

    const resolved = await resolveUsernameToEmail(rawIdentifier);
    const cleanEmail = String(resolved.email || rawIdentifier).trim().toLowerCase();
    const domainCheck = validateUniversityEmail(cleanEmail);
    if (!domainCheck.valid) {
      return res.status(400).json({ error: domainCheck.error });
    }

    // Generic safe response to prevent email enumeration
    return res.json({
      success: true,
      message: 'If an account exists for this official email ID or username, password reset instructions have been dispatched.',
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Password reset request failed' });
  }
});

/**
 * GET /api/auth/username-conflicts
 * Audits accounts for potential username collisions across domains.
 */
authRouter.get('/username-conflicts', requireAuth, (req: AuthedRequest, res) => {
  if (req.user!.role !== 'super_admin' && req.user!.role !== 'it_admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  const audit = auditUsernameConflicts();
  res.json(audit);
});

/**
 * POST /api/auth/refresh
 * Validates the caller's active session, verifies active user account status,
 * and issues a refreshed JWT access token.
 */
authRouter.post('/refresh', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const user = req.user;
    if (!user || user.is_active === false) {
      return res.status(401).json({ error: 'Account is deactivated or session is invalid.' });
    }

    const refreshedToken = signToken({
      id: user.id,
      role: user.role,
      department_id: user.department_id,
      authorized_centre_ids: user.authorized_centre_ids || [],
      school: user.school,
      name: user.name,
      email: user.email,
      must_change_password: Boolean(user.must_change_password),
      is_active: true,
      refreshed_at: Date.now(),
    } as any);

    return res.json({
      success: true,
      token: refreshedToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department_id: user.department_id,
        authorized_centre_ids: user.authorized_centre_ids || [],
        school: user.school,
        must_change_password: Boolean(user.must_change_password),
      },
    });
  } catch (err: any) {
    return res.status(401).json({ error: err?.message || 'Token refresh failed' });
  }
});

/**
 * POST /api/auth/logout
 * Session logout endpoint with server-side token revocation.
 */
authRouter.post('/logout', async (req, res) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) {
      await revokeToken(token);
    }
  }
  return res.json({ success: true, message: 'Logged out and token revoked successfully' });
});

/**
 * GET /api/auth/mfa/status
 * Returns current user MFA configuration status.
 */
authRouter.get('/mfa/status', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!;
  const mfa = (store.data.user_mfa_settings || []).find((m) => m.user_id === user.id);
  res.json({
    mfa_enabled: Boolean(mfa?.mfa_enabled),
    enrolled_at: mfa?.enrolled_at || null,
    has_recovery_codes: Boolean(mfa?.recovery_codes && mfa.recovery_codes.length > 0),
    remaining_recovery_codes: mfa?.recovery_codes?.length || 0,
  });
});

/**
 * POST /api/auth/mfa/setup
 * Initiates TOTP MFA enrollment: generates RFC 6238 secret, QR code, and 8 backup recovery codes.
 */
authRouter.post('/mfa/setup', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const user = req.user!;
    const secret = speakeasy.generateSecret({
      name: `CU-NFA (${user.email})`,
      issuer: 'CHRIST (Deemed to be University)',
      length: 20,
    });

    const qrCodeDataUrl = await qrcode.toDataURL(secret.otpauth_url || '');

    // Generate 8 alphanumeric recovery codes: XXXX-XXXX
    const recoveryCodes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      recoveryCodes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
    }

    await store.transact((db) => {
      db.user_mfa_settings ||= [];
      const existingIdx = db.user_mfa_settings.findIndex((m) => m.user_id === user.id);
      const entry = {
        user_id: user.id,
        mfa_enabled: false, // Remains disabled until verified
        secret: secret.base32,
        recovery_codes: recoveryCodes,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (existingIdx >= 0) {
        db.user_mfa_settings[existingIdx] = entry;
      } else {
        db.user_mfa_settings.push(entry);
      }
    });

    res.json({
      success: true,
      secret: secret.base32,
      qr_code: qrCodeDataUrl,
      qr_code_url: qrCodeDataUrl,
      recovery_codes: recoveryCodes,
      message: 'Scan the QR code with your authenticator app (Google Authenticator, Microsoft Authenticator) and verify with the 6-digit code.',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'MFA_SETUP_FAILED', message: err?.message || 'Failed to initiate MFA setup' });
  }
});

/**
 * POST /api/auth/mfa/verify
 * Confirms and enables MFA with initial 6-digit TOTP code.
 */
authRouter.post('/mfa/verify', requireAuth, async (req: AuthedRequest, res) => {
  const user = req.user!;
  const { token } = req.body || {};

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'MFA 6-digit verification code is required.' });
  }

  const mfa = (store.data.user_mfa_settings || []).find((m) => m.user_id === user.id);
  if (!mfa || !mfa.secret) {
    return res.status(400).json({ error: 'MFA setup not initiated. Please call /setup first.' });
  }

  const verified = speakeasy.totp.verify({
    secret: mfa.secret,
    encoding: 'base32',
    token: token.trim(),
    window: 1, // Allow 30s clock drift
  });

  if (!verified) {
    return res.status(400).json({ error: 'Invalid verification code. Please check your authenticator application.' });
  }

  await store.transact((db) => {
    const entry = (db.user_mfa_settings || []).find((m) => m.user_id === user.id);
    if (entry) {
      entry.mfa_enabled = true;
      entry.enrolled_at = new Date().toISOString();
      entry.last_verified_at = new Date().toISOString();
      entry.updated_at = new Date().toISOString();
    }
  });

  res.json({
    success: true,
    mfa_enabled: true,
    message: 'Multi-Factor Authentication has been successfully enabled for your account.',
  });
});

/**
 * POST /api/auth/mfa/authenticate
 * Completes login by validating TOTP code or backup recovery code against mfa_ticket.
 */
authRouter.post('/mfa/authenticate', async (req, res) => {
  const { mfa_ticket, token, recovery_code } = req.body || {};
  const candidateCode = token || recovery_code;
  if (!mfa_ticket || !candidateCode) {
    return res.status(400).json({ error: 'MFA ticket and verification code are required.' });
  }

  const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
  let decodedTicket: any;
  try {
    decodedTicket = jwt.verify(mfa_ticket, JWT_SECRET);
    if (!decodedTicket.mfa_pending) {
      return res.status(400).json({ error: 'Invalid MFA ticket.' });
    }
  } catch {
    return res.status(401).json({ error: 'MFA verification session has expired. Please sign in again.' });
  }

  const userId = decodedTicket.id;
  const user = store.data.users.find((u) => u.id === userId);
  if (!user || user.is_active === false) {
    return res.status(401).json({ error: 'User account not found or deactivated.' });
  }

  const mfa = (store.data.user_mfa_settings || []).find((m) => m.user_id === userId);
  if (!mfa || !mfa.mfa_enabled || !mfa.secret) {
    return res.status(400).json({ error: 'MFA is not enabled for this user.' });
  }

  const cleanToken = String(candidateCode).trim().toUpperCase();
  let isValid = false;
  let usedRecoveryCode = false;

  // 1. Check TOTP Code
  if (/^\d{6}$/.test(cleanToken)) {
    isValid = speakeasy.totp.verify({
      secret: mfa.secret,
      encoding: 'base32',
      token: cleanToken,
      window: 1,
    });
  }

  // 2. Fallback to One-Time Backup Recovery Code
  if (!isValid && mfa.recovery_codes && mfa.recovery_codes.length > 0) {
    const formattedCode = cleanToken.includes('-') ? cleanToken : `${cleanToken.slice(0, 4)}-${cleanToken.slice(4)}`;
    const codeIdx = mfa.recovery_codes.findIndex((c) => c === formattedCode || c === cleanToken);
    if (codeIdx >= 0) {
      isValid = true;
      usedRecoveryCode = true;
      await store.transact((db) => {
        const entry = (db.user_mfa_settings || []).find((m) => m.user_id === userId);
        if (entry && entry.recovery_codes) {
          entry.recovery_codes.splice(codeIdx, 1);
          entry.updated_at = new Date().toISOString();
        }
      });
    }
  }

  if (!isValid) {
    securityService.logEvent({
      user_id: user.id,
      user_email: user.email,
      user_role: user.role,
      ip_address: req.ip,
      action: 'MFA_FAILED',
      resource_type: 'auth',
      status: 'failure',
      severity: 'medium',
    });
    return res.status(401).json({ error: 'Invalid verification or recovery code.' });
  }

  securityService.logEvent({
    user_id: user.id,
    user_email: user.email,
    user_role: user.role,
    ip_address: req.ip,
    action: 'MFA_VERIFIED',
    resource_type: 'auth',
    status: 'success',
    severity: 'info',
    metadata: { used_recovery_code: usedRecoveryCode },
  });

  // Record verification timestamp
  await store.transact((db) => {
    const entry = (db.user_mfa_settings || []).find((m) => m.user_id === userId);
    if (entry) {
      entry.last_verified_at = new Date().toISOString();
    }
  });

  const userSchool = user.school || (['super_admin', 'director', 'finance', 'finance_head', 'dean', 'associate_dean', 'deans_office'].includes(user.role) ? 'SoET' : null);
  const userCentres = Array.isArray((user as any).authorized_centre_ids) ? (user as any).authorized_centre_ids : [];

  const fullToken = signToken({
    id: user.id,
    role: user.role,
    department_id: user.department_id,
    authorized_centre_ids: userCentres,
    school: userSchool,
    name: user.name,
    email: user.email,
    must_change_password: Boolean(user.must_change_password),
    is_active: user.is_active,
  });

  res.json({
    token: fullToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      department_id: user.department_id,
      authorized_centre_ids: userCentres,
      school: userSchool,
      must_change_password: Boolean(user.must_change_password),
    },
    used_recovery_code: usedRecoveryCode,
    must_change_password: Boolean(user.must_change_password),
  });
});

/**
 * POST /api/auth/mfa/disable
 * Disables MFA after verifying identity via active TOTP token or account password.
 */
authRouter.post('/mfa/disable', requireAuth, async (req: AuthedRequest, res) => {
  const user = req.user!;
  const { token, password } = req.body || {};

  const mfa = (store.data.user_mfa_settings || []).find((m) => m.user_id === user.id);
  if (!mfa || !mfa.mfa_enabled) {
    return res.status(400).json({ error: 'MFA is not currently enabled.' });
  }

  let authorized = false;
  if (token && mfa.secret) {
    authorized = speakeasy.totp.verify({
      secret: mfa.secret,
      encoding: 'base32',
      token: String(token).trim(),
      window: 1,
    });
  }

  if (!authorized && password) {
    try {
      const authRes = await authenticateInstitutionalUser(user.email, String(password));
      if (authRes?.user?.id === user.id) authorized = true;
    } catch {}
  }

  if (!authorized) {
    return res.status(403).json({ error: 'Identity verification failed. Provide a valid TOTP code or password to disable MFA.' });
  }

  await store.transact((db) => {
    const entry = (db.user_mfa_settings || []).find((m) => m.user_id === user.id);
    if (entry) {
      entry.mfa_enabled = false;
      entry.secret = undefined;
      entry.recovery_codes = [];
      entry.updated_at = new Date().toISOString();
    }
  });

  res.json({ success: true, message: 'Multi-Factor Authentication has been disabled.' });
});

/**
 * GET /api/auth/embedded
 * Insecure embedded session bootstrap is permanently disabled.
 */
authRouter.get('/embedded', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
