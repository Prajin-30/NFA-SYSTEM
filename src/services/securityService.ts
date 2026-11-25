import { v4 as uuid } from 'uuid';
import { store } from '../store.js';
import {
  SecurityAuditLog,
  SecurityAlert,
  EmergencyModeState,
  SecuritySeverity,
  SecurityLogStatus,
  SecurityAlertStatus,
  Role,
} from '../types.js';

interface FailedAttemptRecord {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
}

class SecurityService {
  // In-memory sliding window trackers (10 min expiration)
  private failedLoginAttempts = new Map<string, FailedAttemptRecord>();
  private alertCooldowns = new Map<string, number>();

  /**
   * Log an append-only security event to the audit log.
   */
  async logEvent(event: {
    event_type?: string;
    action?: string;
    user_id?: string;
    user_email?: string;
    user_role?: string;
    ip_address?: string;
    user_agent?: string;
    resource?: string;
    resource_type?: string;
    resource_id?: string;
    status?: SecurityLogStatus | string;
    severity?: SecuritySeverity | string;
    metadata?: Record<string, any>;
    details?: Record<string, any>;
  }): Promise<SecurityAuditLog> {
    const rawStatus = (event.status || 'SUCCESS').toUpperCase();
    const status: SecurityLogStatus = ['SUCCESS', 'FAILURE', 'BLOCKED', 'FLAGGED'].includes(rawStatus)
      ? (rawStatus as SecurityLogStatus)
      : 'FLAGGED';

    const rawSeverity = (event.severity || 'LOW').toUpperCase();
    const severity: SecuritySeverity = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(rawSeverity)
      ? (rawSeverity as SecuritySeverity)
      : 'LOW';

    const entry: SecurityAuditLog = {
      id: uuid(),
      event_type: event.event_type || event.action || 'SECURITY_EVENT',
      action: event.action || event.event_type,
      severity,
      user_id: event.user_id,
      user_role: event.user_role,
      ip_address: event.ip_address,
      user_agent: event.user_agent ? event.user_agent.substring(0, 500) : undefined,
      resource: event.resource || event.resource_type,
      status,
      details: {
        ...(event.details || {}),
        ...(event.metadata || {}),
        user_email: event.user_email,
        resource_id: event.resource_id,
      },
      created_at: new Date().toISOString(),
    };

    try {
      await store.transact((db) => {
        if (!Array.isArray(db.security_audit_logs)) {
          db.security_audit_logs = [];
        }
        db.security_audit_logs.push(entry);
        if (db.security_audit_logs.length > 5000) {
          db.security_audit_logs = db.security_audit_logs.slice(-5000);
        }
      });
    } catch (err: any) {
      console.error('[SECURITY SERVICE] Failed to persist audit log:', err.message);
    }

    return entry;
  }

  /**
   * Track failed authentication attempts and detect brute-force threats.
   * Returns true if brute-force threshold is breached (5+ failures in 10 minutes).
   */
  recordFailedLogin(ip: string, email: string): { isBruteForce: boolean; attemptCount: number } {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000; // 10 minutes
    const key = `${ip}:${email.toLowerCase().trim()}`;

    let record = this.failedLoginAttempts.get(key);
    if (!record || now - record.firstAttempt > windowMs) {
      record = { count: 1, firstAttempt: now, lastAttempt: now };
    } else {
      record.count += 1;
      record.lastAttempt = now;
    }
    this.failedLoginAttempts.set(key, record);

    const isBruteForce = record.count >= 5;

    if (isBruteForce) {
      this.triggerAlert({
        alert_type: 'BRUTE_FORCE_DETECTED',
        severity: 'HIGH',
        affected_component: 'Authentication Service',
        description: `Exceeded failed authentication threshold (${record.count} failed attempts) for user ${email} from IP ${ip}.`,
        action_taken: 'IP temporarily restricted with HTTP 429 response',
        recommended_action: 'Investigate IP source and check for distributed credential stuffing attack.',
      });

      this.logEvent({
        user_email: email,
        ip_address: ip,
        action: 'BRUTE_FORCE_ATTEMPT',
        resource: 'auth',
        status: 'BLOCKED',
        severity: 'HIGH',
        details: { attemptCount: record.count },
      });
    }

    return { isBruteForce, attemptCount: record.count };
  }

  /**
   * Reset failed attempts after successful login.
   */
  clearFailedLogins(ip: string, email: string): void {
    const key = `${ip}:${email.toLowerCase().trim()}`;
    this.failedLoginAttempts.delete(key);
  }

  /**
   * Trigger an administrative security alert with deduplication cooldown (15 minutes).
   */
  async triggerAlert(alertData: {
    alert_type: string;
    severity: SecuritySeverity;
    affected_component: string;
    description: string;
    action_taken?: string;
    recommended_action?: string;
  }): Promise<SecurityAlert | null> {
    const cooldownKey = `${alertData.alert_type}:${alertData.affected_component}`;
    const now = Date.now();
    const lastAlertTime = this.alertCooldowns.get(cooldownKey);
    const cooldownMs = 15 * 60 * 1000; // 15 minutes cooldown

    if (lastAlertTime && now - lastAlertTime < cooldownMs) {
      return null;
    }

    this.alertCooldowns.set(cooldownKey, now);

    const alert: SecurityAlert = {
      id: uuid(),
      incident_ref: `SEC-${Date.now().toString(36).toUpperCase()}`,
      alert_type: alertData.alert_type,
      severity: alertData.severity,
      affected_component: alertData.affected_component,
      description: alertData.description,
      action_taken: alertData.action_taken || 'Logged and monitored',
      recommended_action: alertData.recommended_action || 'Review audit logs and investigate affected component.',
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    console.warn(`[SECURITY ALERT] [${alert.severity}] ${alert.alert_type}: ${alert.description}`);

    try {
      await store.transact((db) => {
        if (!Array.isArray(db.security_alerts)) {
          db.security_alerts = [];
        }
        db.security_alerts.push(alert);
      });
    } catch (err: any) {
      console.error('[SECURITY SERVICE] Failed to persist security alert:', err.message);
    }

    return alert;
  }

  /**
   * Fetch active or recent security alerts.
   */
  getAlerts(limit: number = 50): SecurityAlert[] {
    const alerts = store.data.security_alerts || [];
    return [...alerts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, limit);
  }

  /**
   * Resolve or acknowledge a security alert.
   */
  async updateAlertStatus(
    alertId: string,
    status: SecurityAlertStatus,
    userId?: string
  ): Promise<SecurityAlert | null> {
    let updated: SecurityAlert | null = null;
    await store.transact((db) => {
      const alert = db.security_alerts?.find((a) => a.id === alertId);
      if (alert) {
        alert.status = status;
        alert.updated_at = new Date().toISOString();
        if (status === 'ACKNOWLEDGED') {
          alert.acknowledged_by = userId;
          alert.acknowledged_at = new Date().toISOString();
        } else if (status === 'RESOLVED') {
          alert.resolved_by = userId;
          alert.resolved_at = new Date().toISOString();
        }
        updated = { ...alert };
      }
    });
    return updated;
  }

  /**
   * Check if Emergency Security Mode is active.
   */
  isEmergencyModeActive(): boolean {
    return Boolean(store.data.emergency_mode_state?.is_active);
  }

  /**
   * Retrieve current Emergency Mode state.
   */
  getEmergencyModeState(): EmergencyModeState {
    return (
      store.data.emergency_mode_state || {
        id: 'emergency-state',
        is_active: false,
        activated_by: undefined,
        activated_at: undefined,
        reason: undefined,
        updated_at: new Date().toISOString(),
      }
    );
  }

  /**
   * Toggle Emergency Security Mode (Super Admin only).
   */
  async setEmergencyMode(
    active: boolean,
    user: { id: string; email: string; role: Role },
    reason?: string
  ): Promise<EmergencyModeState> {
    const newState: EmergencyModeState = {
      id: 'emergency-state',
      is_active: active,
      activated_by: active ? user.email : undefined,
      activated_at: active ? new Date().toISOString() : undefined,
      reason: active ? reason || 'Administrative Security Freeze' : undefined,
      updated_at: new Date().toISOString(),
    };

    await store.transact((db) => {
      db.emergency_mode_state = newState;
    });

    await this.logEvent({
      user_id: user.id,
      user_email: user.email,
      user_role: user.role,
      action: active ? 'EMERGENCY_MODE_ACTIVATED' : 'EMERGENCY_MODE_DEACTIVATED',
      status: active ? 'FLAGGED' : 'SUCCESS',
      severity: active ? 'CRITICAL' : 'HIGH',
      details: { reason: newState.reason },
    });

    if (active) {
      await this.triggerAlert({
        alert_type: 'EMERGENCY_MODE_ACTIVATED',
        severity: 'CRITICAL',
        affected_component: 'Entire System',
        description: `System placed into read-only emergency lock by ${user.email}. Reason: ${reason || 'Administrative action'}`,
        action_taken: 'Mutating HTTP endpoints frozen with 503 response',
        recommended_action: 'Perform emergency investigation and restore normal operation once safe.',
      });
    }

    return newState;
  }
}

export const securityService = new SecurityService();
