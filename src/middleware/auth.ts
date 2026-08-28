import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import type { Role } from '../types.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';

export interface AuthedRequest extends Request {
  user?: { id: string; role: Role; department_id: string | null; name: string; email: string };
}

export function signToken(user: { id: string; role: Role; department_id: string | null; name: string; email: string }) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '12h' });
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  try {
    const token = header.slice('Bearer '.length);
    req.user = jwt.verify(token, JWT_SECRET) as any;
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
