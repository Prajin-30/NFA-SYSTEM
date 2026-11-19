import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import type { Role } from '../types.js';
import { store } from '../store.js';
import { query } from '../db/pool.js';
import { getSystemMode, isDemoAuthenticationAllowed } from '../services/supabaseAuth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';

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

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;

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
        const queryRes = await query(
          'SELECT id, name, email, role, department_id, authorized_centre_ids, must_change_password, is_active, signature_image FROM user_profiles WHERE id = $1 LIMIT 1;',
          [decoded.id]
        );
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
      const allowedPaths = ['/api/auth/change-password', '/api/auth/logout', '/api/users/me'];
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
      return res.status(403).json({ error: `Forbidden: requires role in [${roles.join(', ')}], you are '${req.user.role}'` });
    }
    next();
  };
}
