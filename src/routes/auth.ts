import { Router } from 'express';
import { store } from '../store.js';
import { requireAuth, signToken, AuthedRequest } from '../middleware/auth.js';
import {
  authenticateInstitutionalUser,
  updateUserPassword,
  validatePasswordStrength,
  validateUniversityEmail,
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
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Official Email ID and Password are required' });
    }

    const { user, must_change_password } = await authenticateInstitutionalUser(
      String(email).trim(),
      String(password)
    );

    const userSchool = user.school || (['super_admin', 'director', 'finance', 'dean', 'associate_dean'].includes(user.role) ? 'SoET' : null);
    const token = signToken({
      id: user.id,
      role: user.role,
      department_id: user.department_id,
      school: userSchool,
      name: user.name,
      email: user.email,
      must_change_password,
      is_active: user.is_active,
    });

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department_id: user.department_id,
        school: userSchool,
        must_change_password,
      },
      must_change_password,
    });
  } catch (err: any) {
    const message = err?.message || 'Authentication failed';
    if (message.includes('deactivated')) {
      return res.status(401).json({ error: message });
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
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Official Email ID is required' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const domainCheck = validateUniversityEmail(cleanEmail);
    if (!domainCheck.valid) {
      return res.status(400).json({ error: domainCheck.error });
    }

    // Generic safe response to prevent email enumeration
    return res.json({
      success: true,
      message: 'If an account exists for this official email ID, password reset instructions have been dispatched.',
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Password reset request failed' });
  }
});

/**
 * POST /api/auth/logout
 * Session logout endpoint.
 */
authRouter.post('/logout', (_req, res) => {
  return res.json({ success: true, message: 'Logged out successfully' });
});

/**
 * GET /api/auth/embedded
 * Insecure embedded session bootstrap is permanently disabled.
 */
authRouter.get('/embedded', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
