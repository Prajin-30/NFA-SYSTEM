import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Role } from '../types.js';
import { store } from '../store.js';
import { query } from '../db/pool.js';
import { getSystemMode, isDemoAuthenticationAllowed } from '../services/supabaseAuth.js';
import { securityService } from '../services/securityService.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';

// In-memory set of revoked JWT tokens and token hashes for low-latency lookup
export const revokedTokenSet = new Set<string>();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * Loads unexpired revoked tokens from persistent store into in-memory set.
 * Called on application startup and available to test harnesses simulating container restarts.
 */
export function loadRevokedTokensFromStore() {
  const now = Date.now();
  const list = store.data.revoked_tokens || [];
  for (const item of list) {
    if (item.expires_at > now) {
      revokedTokenSet.add(item.token_hash);
    }
  }
}

// Initial hydration from persistent store
loadRevokedTokensFromStore();

/**
 * Revokes a JWT token persistently.
 * Persists to disk in store and prepares PostgreSQL persistence when table exists.
 * Also prunes expired tokens to prevent unbounded memory growth.
 */
export async function revokeToken(token: string): Promise<void> {
  if (!token || !token.trim()) return;
  const rawToken = token.trim();
  const hash = hashToken(rawToken);

  revokedTokenSet.add(rawToken);
  revokedTokenSet.add(hash);

  let expiresAt = Date.now() + 12 * 3600 * 1000;
  try {
    const decoded = jwt.decode(rawToken) as any;
    if (decoded && typeof decoded.exp === 'number') {
      expiresAt = decoded.exp * 1000;
    }
  } catch { }

  const now = Date.now();
  await store.transact((db) => {
    db.revoked_tokens = (db.revoked_tokens || []).filter((t) => t.expires_at > now);
    db.revoked_tokens.push({ token_hash: hash, expires_at: expiresAt });
  });

  // Supabase PostgreSQL persistence (schema-tolerant)
  if (process.env.DATABASE_URL && process.env.DATA_SOURCE === 'postgres') {
    try {
      await query(
        'INSERT INTO revoked_tokens (token_hash, expires_at) VALUES ($1, $2) ON CONFLICT (token_hash) DO NOTHING;',
        [hash, new Date(expiresAt).toISOString()]
      );
    } catch {
      // Table does not exist yet (pre-migration)
    }
  }
}

export function isTokenRevoked(token: string): boolean {
  if (!token || !token.trim()) return false;
  const rawToken = token.trim();
  if (revokedTokenSet.has(rawToken)) return true;

  const hash = hashToken(rawToken);
  if (revokedTokenSet.has(hash)) return true;

  const now = Date.now();
  const found = (store.data.revoked_tokens || []).some(
    (t) => (t.token_hash === hash || t.token_hash === rawToken) && t.expires_at > now
  );
  if (found) {
    revokedTokenSet.add(hash);
    return true;
  }
  return false;
}

export interface AuthedRequest extends Request {
  user?: {
    id: string;
    role: Role;
    department_id: string | null;
    authorized_centre_ids?: string[];
    school?: string | null;
    name: string;
    email: string;
    must_change_password?: boolean;
    is_active?: boolean;
    signature_image?: string | null;
  };
}

export function signToken(user: {
  id: string;
  role: Role;
  department_id: string | null;
  authorized_centre_ids?: string[];
  school?: string | null;
  name: string;
  email: string;
  must_change_password?: boolean;
  is_active?: boolean;
}) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '12h' });
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  let token: string | undefined;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice('Bearer '.length);
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  // Check if token was explicitly revoked via logout (persistent + in-memory)
  if (isTokenRevoked(token)) {
    return res.status(401).json({ error: 'Session has been logged out and revoked. Please sign in again.' });
  }

  // Prevent browser caching of sensitive protected responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    if (decoded.mfa_pending) {
      return res.status(401).json({ error: 'MFA_REQUIRED', message: 'Multi-factor authentication verification pending.' });
    }

    // Load authoritative profile from PostgreSQL if in postgres mode (for non-demo accounts), or local store
    let dbUser: any = null;
    const isDemo = isDemoAuthenticationAllowed(decoded.email);
    if (
      !isDemo &&
      process.env.DATABASE_URL &&
      process.env.DATA_SOURCE === 'postgres' &&
      process.env.NODE_ENV !== 'test' &&
      process.env.MOCK_AUTH !== 'true'
    ) {
      try {
        let queryRes;
        try {
          queryRes = await query(
            'SELECT id, name, email, role, department_id, authorized_centre_ids, must_change_password, is_active, signature_image FROM user_profiles WHERE id = $1 LIMIT 1;',
            [decoded.id]
          );
        } catch (colErr: any) {
          if (colErr?.code === '42703') {
            // Schema tolerance: column authorized_centre_ids does not exist yet (pre-migration 002)
            queryRes = await query(
              'SELECT id, name, email, role, department_id, must_change_password, is_active, signature_image FROM user_profiles WHERE id = $1 LIMIT 1;',
              [decoded.id]
            );
          } else {
            throw colErr;
          }
        }
        if (queryRes.rows.length > 0) {
          dbUser = queryRes.rows[0];
        }
      } catch { }
    }

    if (!dbUser) {
      dbUser = store.data.users.find((u) => u.id === decoded.id || u.email.toLowerCase() === (decoded.email || '').toLowerCase());
    }

    if (dbUser) {
      if (dbUser.is_active === false) {
        return res.status(401).json({ error: 'Account has been deactivated. Please contact the administrator.' });
      }
      req.user = {
        id: dbUser.id,
        name: dbUser.name,
        email: dbUser.email,
        role: dbUser.role, // Authoritative role from database
        department_id: dbUser.department_id,
        authorized_centre_ids: Array.isArray(dbUser.authorized_centre_ids)
          ? dbUser.authorized_centre_ids
          : (Array.isArray(decoded.authorized_centre_ids) ? decoded.authorized_centre_ids : []),
        school: dbUser.school || (['super_admin', 'director', 'finance', 'dean', 'associate_dean'].includes(dbUser.role) ? 'SoET' : null),
        must_change_password: Boolean(dbUser.must_change_password || decoded.must_change_password),
        is_active: dbUser.is_active !== false,
        signature_image: dbUser.signature_image || null,
      };
    } else {
      req.user = {
        ...decoded,
        authorized_centre_ids: Array.isArray(decoded.authorized_centre_ids) ? decoded.authorized_centre_ids : [],
        school: decoded.school || (['super_admin', 'director', 'finance', 'dean', 'associate_dean'].includes(decoded.role) ? 'SoET' : null),
      };
    }

    // Strict Backend Enforcement of Mandatory Password Change
    if (req.user?.must_change_password) {
      // Normalize path to strip mount prefixes or trailing slashes
      const reqPath = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;
      const allowedPaths = ['/api/auth/change-password', '/api/auth/logout', '/api/auth/refresh', '/api/users/me', '/api/auth/mfa/status', '/api/auth/mfa/setup', '/api/auth/mfa/verify'];
      if (!allowedPaths.includes(reqPath)) {
        return res.status(403).json({
          error: 'PasswordChangeRequired',
          message: 'You must change your temporary password before accessing institutional data.',
          must_change_password: true,
        });
      }
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Backend-enforced RBAC. Every mutating route must declare who is allowed. */
export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      securityService.logEvent({
        user_id: req.user.id,
        user_email: req.user.email,
        user_role: req.user.role,
        ip_address: req.ip,
        user_agent: (req.headers['user-agent'] as string) || null,
        action: 'ACCESS_DENIED',
        resource_type: req.baseUrl || req.path,
        status: 'blocked',
        severity: 'low',
        metadata: { requiredRoles: roles, userRole: req.user.role, path: req.originalUrl },
      });
      return res.status(403).json({ error: `Forbidden: requires role in [${roles.join(', ')}], you are '${req.user.role}'` });
    }
    next();
  };
}
