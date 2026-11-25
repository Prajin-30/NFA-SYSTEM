import { Response, NextFunction } from 'express';
import { AuthedRequest } from './auth.js';
import { securityService } from '../services/securityService.js';

export function emergencyModeGuard(req: AuthedRequest, res: Response, next: NextFunction) {
  // Allow safe read-only methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Check if emergency security mode is active
  if (!securityService.isEmergencyModeActive()) {
    return next();
  }

  // Allow emergency mode toggling and authentication lifecycle
  const allowedPrefixes = [
    '/api/admin/emergency-mode',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/mfa',
    '/api/auth/refresh',
  ];

  if (allowedPrefixes.some((p) => req.path.startsWith(p))) {
    return next();
  }

  // If active and trying to perform mutating operation, reject with HTTP 503
  const state = securityService.getEmergencyModeState();
  return res.status(503).json({
    error: 'EMERGENCY_PROTECTION_MODE',
    message: 'System is currently in Emergency Read-Only Security Mode. Financial modifications and document submissions are temporarily frozen.',
    reason: state.reason || 'Administrative Security Incident Response',
    activated_at: state.activated_at,
  });
}
