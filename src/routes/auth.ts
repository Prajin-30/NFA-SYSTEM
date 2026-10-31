import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { store } from '../store.js';
import { signToken } from '../middleware/auth.js';

export const authRouter = Router();

/**
 * POST /api/auth/login
 * body: { email, password }
 * -> { token, user }
 */
authRouter.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = store.data.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = signToken({ id: user.id, role: user.role, department_id: user.department_id, name: user.name, email: user.email });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, department_id: user.department_id } });
});

/**
 * GET /api/auth/embedded
 * Insecure embedded session bootstrap is permanently disabled.
 * Returns 404 without exposing user details, tokens, or internal configuration.
 *
 * Preserved reference implementation for potential future secured integration:
 * const embeddedEmail = process.env.EMBEDDED_USER_EMAIL || 'hod@christ.edu';
 * const user = store.data.users.find((u) => u.email.toLowerCase() === embeddedEmail.toLowerCase());
 * if (!user) return res.status(503).json({ error: 'Embedded user not found' });
 * const token = signToken({ id: user.id, role: user.role, department_id: user.department_id, name: user.name, email: user.email });
 * res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, department_id: user.department_id } });
 */
authRouter.get('/embedded', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

