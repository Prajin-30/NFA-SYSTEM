import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import WebSocket from 'ws';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Role, User } from '../types.js';
import { store } from '../store.js';
import { query } from '../db/pool.js';

// Polyfill native WebSocket on globalThis if running in Node environments where it is absent
if (typeof (globalThis as any).WebSocket === 'undefined') {
  (globalThis as any).WebSocket = WebSocket;
}

export function maskEmail(email: string): string {
  const clean = String(email || '').trim().toLowerCase();
  const atIdx = clean.indexOf('@');
  if (atIdx <= 0) return '***';
  const name = clean.slice(0, atIdx);
  const domain = clean.slice(atIdx + 1);
  const maskedName = name.length > 2 ? `${name[0]}***${name[name.length - 1]}` : `${name[0]}***`;
  return `${maskedName}@${domain}`;
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
  return { url, key };
}

const APPROVED_DOMAINS = (process.env.APPROVED_EMAIL_DOMAINS || 'christuniversity.in,christ.edu')
  .split(',')
  .map((d) => d.trim().toLowerCase());

/**
 * Generate a cryptographically secure, high-entropy temporary password.
 * Format: 14 characters with uppercase, lowercase, numbers, and symbols.
 * Never uses a shared default password.
 */
export function generateTemporaryPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%&*+?';

  // Ensure at least one character from each class
  const pick = (charset: string) => charset[crypto.randomInt(0, charset.length)];
  const chars = [
    pick(upper),
    pick(upper),
    pick(lower),
    pick(lower),
    pick(digits),
    pick(digits),
    pick(special),
    pick(special),
  ];

  const all = upper + lower + digits + special;
  while (chars.length < 14) {
    chars.push(pick(all));
  }

  // Cryptographic in-place shuffle (Fisher-Yates)
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

/**
 * Validates password complexity:
 * - Minimum 8 characters (10+ recommended)
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one digit
 * - At least one special character
 */
export function validatePasswordStrength(password: string): { valid: boolean; error?: string } {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters long' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one lowercase letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one digit' };
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one special character' };
  }
  return { valid: true };
}

/**
 * Validates university email domain.
 */
export function validateUniversityEmail(email: string): { valid: boolean; error?: string } {
  const clean = String(email || '').trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(clean)) {
    return { valid: false, error: `Invalid email format: '${email}'` };
  }

  const domain = clean.split('@')[1];
  const isApproved = APPROVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
  if (!isApproved) {
    return {
      valid: false,
      error: `Email domain '@${domain}' is not authorized. Allowed university domains: ${APPROVED_DOMAINS.map((d) => '@' + d).join(', ')}`,
    };
  }

  return { valid: true };
}

// In-memory mock auth storage for isolated test harness / development when live Supabase is offline
interface MockAuthUser {
  id: string;
  email: string;
  passwordHash: string;
  mustChangePassword: boolean;
  isActive: boolean;
  tempPasswordCreatedAt?: string;
}

const mockAuthUsers = new Map<string, MockAuthUser>();

export function getMockAuthUsers(): Map<string, MockAuthUser> {
  return mockAuthUsers;
}

let supabaseAdminClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (supabaseAdminClient) return supabaseAdminClient;
  const { url, key } = getSupabaseConfig();
  if (url && key) {
    supabaseAdminClient = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      realtime: {
        transport: WebSocket as any,
      },
    });
  }
  return supabaseAdminClient;
}

export interface InstitutionalUserProfile {
  id: string;
  name: string;
  email: string;
  role: Role;
  department_id: string | null;
  authorized_centre_ids?: string[];
  school?: string | null;
  must_change_password: boolean;
  is_active: boolean;
  temp_password_created_at?: string | null;
  signature_image?: string | null;
}

/**
 * Check if the live Supabase Auth service is configured.
 */
export function isLiveSupabaseAuthConfigured(): boolean {
  if (process.env.NODE_ENV === 'test' || process.env.MOCK_AUTH === 'true') {
    return false;
  }
  const { url, key } = getSupabaseConfig();
  return Boolean(url && key && !url.includes('your-project-ref'));
}

export const APPROVED_DEMO_EMAILS = [
  'faculty@christ.edu',
  'hod@christ.edu',
  'deansoffice@christ.edu',
  'dean@christ.edu',
  'associate_dean@christ.edu',
  'finance@christ.edu',
  'director@christ.edu',
  'financehead@christ.edu',
  'student@christ.edu',
  'itadmin@christ.edu',
  'prajin.s@btech.christuniversity.in',
];

/**
 * Standard default onboarding password for Faculty/HOD bulk onboarding via Excel.
 * Policy: Password@123 (Meets complexity: 12 chars, uppercase, lowercase, digit, special char).
 * Every onboarded user is flagged with must_change_password = true.
 */
export const DEFAULT_FACULTY_ONBOARDING_PASSWORD = 'Password@123';

/**
 * Determines whether demo authentication is permitted for an email.
 * - Strictly forbidden in production (NODE_ENV=production or APP_ENV=production).
 * - admin@christ.edu is strictly institutional (never allowed as demo).
 * - Only approved baseline demo accounts are permitted for demo login.
 * - Newly uploaded institutional Faculty/HOD always authenticate as institutional users.
 */
export function isDemoAuthenticationAllowed(email: string): boolean {
  if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
    return false;
  }
  const clean = String(email || '').trim().toLowerCase();
  if (clean === 'admin@christ.edu') {
    return false;
  }
  return APPROVED_DEMO_EMAILS.includes(clean);
}

let runtimeModeOverride: 'institutional' | 'demo' | null = null;

export function setRuntimeMode(mode: 'institutional' | 'demo'): void {
  if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
    throw new Error('Mode switching is strictly disabled in production.');
  }
  runtimeModeOverride = mode;
}

/**
 * Resolves active operating mode:
 * - 'demo': Local development only. Uses local mock database and demo accounts.
 * - 'institutional': Real institutional mode. Uses Supabase Auth & PostgreSQL user_profiles.
 */
export function getSystemMode(): 'institutional' | 'demo' {
  if (process.env.NODE_ENV === 'test' || process.env.MOCK_AUTH === 'true') {
    return 'demo';
  }
  // Demo mode is strictly forbidden in production
  if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
    return 'institutional';
  }
  if (runtimeModeOverride) {
    return runtimeModeOverride;
  }
  if (process.env.APP_MODE === 'demo') return 'demo';
  if (process.env.APP_MODE === 'institutional') return 'institutional';
  if (process.env.DATA_SOURCE === 'postgres') return 'institutional';
  return 'demo';
}

function isPostgresPersistenceActive(): boolean {
  if (getSystemMode() === 'demo') {
    return false;
  }
  return Boolean(process.env.DATABASE_URL && process.env.DATA_SOURCE === 'postgres');
}

/**
 * Provision a new user account with a unique temporary password.
 * Programmatic server-side administration.
 */
export async function createInstitutionalAccount(params: {
  name: string;
  email: string;
  role: Role;
  department_id: string | null;
  school?: string | null;
  initialPassword?: string;
}): Promise<{ user: InstitutionalUserProfile; temporaryPassword: string }> {
  const { name, email, role, department_id, school, initialPassword } = params;
  const cleanEmail = email.trim().toLowerCase();

  const emailCheck = validateUniversityEmail(cleanEmail);
  if (!emailCheck.valid) {
    throw new Error(emailCheck.error);
  }

  const temporaryPassword = initialPassword || generateTemporaryPassword();
  const supabase = getSupabaseAdmin();

  let authUserId: string;

  if (isLiveSupabaseAuthConfigured() && supabase) {
    // Live Supabase Auth Admin creation
    const { data, error } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { name, role, department_id, school: school || null },
    });

    if (error || !data.user) {
      throw new Error(`Supabase Auth creation failed: ${error?.message || 'Unknown error'}`);
    }
    authUserId = data.user.id;
  } else {
    // Isolated Mock Auth for local development/test harness
    authUserId = crypto.randomUUID();
    mockAuthUsers.set(cleanEmail, {
      id: authUserId,
      email: cleanEmail,
      passwordHash: bcrypt.hashSync(temporaryPassword, 8),
      mustChangePassword: true,
      isActive: true,
      tempPasswordCreatedAt: new Date().toISOString(),
    });
  }

  // Update or insert into store/database
  const now = new Date().toISOString();
  const profile: InstitutionalUserProfile = {
    id: authUserId,
    name: name.trim(),
    email: cleanEmail,
    role,
    department_id: department_id || null,
    school: school || null,
    must_change_password: true,
    is_active: true,
    temp_password_created_at: now,
  };

  // Sync to PostgreSQL user_profiles if running with database backend
  if (isPostgresPersistenceActive()) {
    try {
      await query(
        `INSERT INTO user_profiles (id, name, email, role, department_id, must_change_password, is_active, temp_password_created_at)
         VALUES ($1, $2, $3, $4, $5, true, true, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           role = EXCLUDED.role,
           department_id = EXCLUDED.department_id,
           must_change_password = true,
           is_active = true,
           temp_password_created_at = NOW(),
           updated_at = NOW();`,
        [profile.id, profile.name, profile.email, profile.role, profile.department_id]
      );
    } catch (dbErr: any) {
      if (isLiveSupabaseAuthConfigured() && supabase) {
        await supabase.auth.admin.deleteUser(authUserId).catch(() => { });
      }
      throw new Error(`Failed to record user profile in database: ${dbErr?.message || dbErr}`);
    }
  }

  // Sync to store.data.users to maintain full backward compatibility with existing views
  await store.transact((db) => {
    const existing = db.users.find((u) => u.email.toLowerCase() === cleanEmail);
    if (existing) {
      existing.id = profile.id;
      existing.name = profile.name;
      existing.role = profile.role;
      existing.department_id = profile.department_id;
      (existing as any).school = profile.school;
      (existing as any).must_change_password = true;
      (existing as any).is_active = true;
      (existing as any).temp_password_created_at = now;
      existing.password_hash = isLiveSupabaseAuthConfigured() ? '' : bcrypt.hashSync(temporaryPassword, 8);
    } else {
      db.users.push({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        password_hash: isLiveSupabaseAuthConfigured() ? '' : bcrypt.hashSync(temporaryPassword, 8),
        role: profile.role,
        department_id: profile.department_id,
        school: profile.school,
        created_at: now,
        must_change_password: true,
        is_active: true,
        temp_password_created_at: now,
      } as any);
    }
  });

  return { user: profile, temporaryPassword };
}

/**
 * Verify user email and password through Supabase Auth (or test adapter).
 * Loads authoritative profile, verifies active account status, and checks must_change_password.
 */
export async function authenticateInstitutionalUser(
  email: string,
  pass: string
): Promise<{ user: InstitutionalUserProfile; must_change_password: boolean }> {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const password = String(pass || '');

  if (!cleanEmail || !password) {
    throw new Error('Official Email ID and password are required');
  }

  // 1. DIRECT DEMO LOGIN (Local development only - uses local mock store)
  // Demo accounts (faculty, hod, dean, associate_dean, finance, director, etc.) authenticate directly without manual mode toggling
  if (isDemoAuthenticationAllowed(cleanEmail)) {
    const demoUser = store.data.users.find((u) => u.email.toLowerCase() === cleanEmail);
    if (!demoUser || !demoUser.password_hash || !bcrypt.compareSync(password, demoUser.password_hash)) {
      throw new Error('Invalid email or password');
    }

    const isActive = (demoUser as any).is_active !== false;
    if (!isActive) {
      throw new Error('This user account has been deactivated. Please contact the administrator.');
    }

    const profile: InstitutionalUserProfile = {
      id: demoUser.id,
      name: demoUser.name,
      email: demoUser.email,
      role: demoUser.role,
      department_id: demoUser.department_id,
      authorized_centre_ids: Array.isArray((demoUser as any).authorized_centre_ids) ? (demoUser as any).authorized_centre_ids : [],
      must_change_password: Boolean((demoUser as any).must_change_password),
      is_active: true,
      temp_password_created_at: (demoUser as any).temp_password_created_at || null,
      signature_image: demoUser.signature_image || null,
    };
    return { user: profile, must_change_password: profile.must_change_password };
  }

  // 2. INSTITUTIONAL AUTHENTICATION (Supabase Auth & PostgreSQL user_profiles - strictly isolated)
  const emailCheck = validateUniversityEmail(cleanEmail);
  if (!emailCheck.valid) {
    throw new Error(emailCheck.error);
  }

  let authUserId: string | null = null;
  const supabase = getSupabaseAdmin();
  const isProd = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';

  if (isLiveSupabaseAuthConfigured() && supabase) {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });
      if (error) {
        console.warn(`[Auth Failure] Category: INVALID_CREDENTIALS | Target: ${maskEmail(cleanEmail)} | Supabase: ${error.message}`);
        throw new Error('INVALID_CREDENTIALS');
      }
      if (!data?.user) {
        console.warn(`[Auth Failure] Category: INVALID_CREDENTIALS | Target: ${maskEmail(cleanEmail)} | Reason: No user data returned`);
        throw new Error('INVALID_CREDENTIALS');
      }
      authUserId = data.user.id;
    } catch (apiErr: any) {
      if (apiErr.message === 'INVALID_CREDENTIALS') {
        throw apiErr;
      }
      console.error(`[Auth Failure] Category: SUPABASE_API_ERROR | Target: ${maskEmail(cleanEmail)} | Detail: ${apiErr?.message || apiErr}`);
      throw new Error(`SUPABASE_API_ERROR: ${apiErr?.message || 'Verification failed'}`);
    }
  } else if (isProd) {
    console.error(`[Auth Failure] Category: AUTH_CONFIGURATION_ERROR | Target: ${maskEmail(cleanEmail)} | Reason: Supabase Auth credentials not configured in production.`);
    throw new Error('AUTH_CONFIGURATION_ERROR');
  } else {
    // Isolated unit test harness / mock auth (non-production only)
    const mockUser = mockAuthUsers.get(cleanEmail);
    if (!mockUser || !bcrypt.compareSync(password, mockUser.passwordHash)) {
      console.warn(`[Auth Failure] Category: INVALID_CREDENTIALS | Target: ${maskEmail(cleanEmail)} | Reason: Mock auth rejection`);
      throw new Error('INVALID_CREDENTIALS');
    }
    authUserId = mockUser.id;
  }

  // Authoritative user profile query from PostgreSQL
  let userRecord: any = null;
  if (process.env.DATABASE_URL && process.env.DATA_SOURCE !== 'json') {
    try {
      let dbRes;
      try {
        dbRes = await query(
          'SELECT id, name, email, role, department_id, authorized_centre_ids, must_change_password, is_active, temp_password_created_at, signature_image FROM user_profiles WHERE id = $1 OR lower(email) = $2 LIMIT 1;',
          [authUserId, cleanEmail]
        );
      } catch (colErr: any) {
        if (colErr?.code === '42703') {
          // Schema tolerance: column authorized_centre_ids does not exist yet in user_profiles (pre-migration 002)
          dbRes = await query(
            'SELECT id, name, email, role, department_id, must_change_password, is_active, temp_password_created_at, signature_image FROM user_profiles WHERE id = $1 OR lower(email) = $2 LIMIT 1;',
            [authUserId, cleanEmail]
          );
        } else {
          throw colErr;
        }
      }
      if (dbRes.rows.length > 0) {
        userRecord = dbRes.rows[0];
      }
    } catch (dbErr: any) {
      console.error(`[Auth Failure] Category: DATABASE_UNAVAILABLE | Target: ${maskEmail(cleanEmail)} | Code: ${dbErr?.code || 'ERR'}`);
      if (isProd) {
        throw new Error('DATABASE_UNAVAILABLE');
      }
    }
  } else if (isProd) {
    console.error(`[Auth Failure] Category: AUTH_CONFIGURATION_ERROR | Target: ${maskEmail(cleanEmail)} | Reason: DATABASE_URL missing in production.`);
    throw new Error('AUTH_CONFIGURATION_ERROR');
  }

  // Fallback to store only in non-production development/test
  if (!userRecord && !isProd) {
    userRecord = store.data.users.find((u) => u.id === authUserId || u.email.toLowerCase() === cleanEmail);
  }

  if (!userRecord) {
    console.warn(`[Auth Failure] Category: PROFILE_NOT_FOUND | Target: ${maskEmail(cleanEmail)}`);
    throw new Error('PROFILE_NOT_FOUND');
  }

  const isActive = userRecord.is_active !== false;
  if (!isActive) {
    throw new Error('This user account has been deactivated. Please contact the administrator.');
  }

  const mustChangePassword = Boolean(userRecord.must_change_password);

  const profile: InstitutionalUserProfile = {
    id: userRecord.id,
    name: userRecord.name,
    email: userRecord.email,
    role: userRecord.role,
    department_id: userRecord.department_id,
    authorized_centre_ids: Array.isArray(userRecord.authorized_centre_ids) ? userRecord.authorized_centre_ids : [],
    must_change_password: mustChangePassword,
    is_active: true,
    temp_password_created_at: userRecord.temp_password_created_at || null,
    signature_image: userRecord.signature_image || null,
  };

  return { user: profile, must_change_password: mustChangePassword };
}

/**
 * Execute mandatory first-time password change.
 * Validates complexity, updates Supabase Auth, and clears must_change_password in PostgreSQL.
 */
export async function updateUserPassword(
  userId: string,
  newPassword: string
): Promise<{ success: boolean }> {
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    throw new Error(strength.error);
  }

  const userRecord = store.data.users.find((u) => u.id === userId || u.email.toLowerCase() === userId.toLowerCase());
  const userEmail = userRecord?.email?.toLowerCase() || '';
  const supabase = getSupabaseAdmin();

  if (isLiveSupabaseAuthConfigured() && supabase) {
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (error) {
      throw new Error(`Failed to update password in Supabase: ${error.message}`);
    }
  } else {
    // Update mock user if present
    const hash = bcrypt.hashSync(newPassword, 8);
    for (const [emailKey, mockUser] of mockAuthUsers.entries()) {
      if (mockUser.id === userId || emailKey === userEmail || mockUser.email.toLowerCase() === userEmail) {
        mockUser.passwordHash = hash;
        mockUser.mustChangePassword = false;
        mockUser.tempPasswordCreatedAt = undefined;
        break;
      }
    }
  }

  // Update in PostgreSQL user_profiles if configured
  if (isPostgresPersistenceActive()) {
    try {
      await query(
        'UPDATE user_profiles SET must_change_password = false, temp_password_created_at = NULL, updated_at = NOW() WHERE id = $1;',
        [userId]
      );
    } catch { }
  }

  // Clear must_change_password on user record in store/database
  await store.transact((db) => {
    const u = db.users.find((usr) => usr.id === userId || usr.email.toLowerCase() === userEmail);
    if (u) {
      (u as any).must_change_password = false;
      (u as any).temp_password_created_at = null;
      if (!isLiveSupabaseAuthConfigured()) {
        u.password_hash = bcrypt.hashSync(newPassword, 8);
      }
    }
  });

  return { success: true };
}

/**
 * Super Admin resets temporary password for a user.
 */
export async function resetTemporaryPassword(
  userId: string
): Promise<{ temporaryPassword: string }> {
  const newTempPassword = generateTemporaryPassword();
  const userRecord = store.data.users.find((u) => u.id === userId || u.email.toLowerCase() === userId.toLowerCase());
  const userEmail = userRecord?.email?.toLowerCase() || '';
  const supabase = getSupabaseAdmin();

  if (isLiveSupabaseAuthConfigured() && supabase) {
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      password: newTempPassword,
    });
    if (error) {
      throw new Error(`Failed to reset password: ${error.message}`);
    }
  } else {
    const hash = bcrypt.hashSync(newTempPassword, 8);
    for (const [emailKey, mockUser] of mockAuthUsers.entries()) {
      if (mockUser.id === userId || emailKey === userEmail || mockUser.email.toLowerCase() === userEmail) {
        mockUser.passwordHash = hash;
        mockUser.mustChangePassword = true;
        mockUser.tempPasswordCreatedAt = new Date().toISOString();
        break;
      }
    }
  }

  const now = new Date().toISOString();

  // Update in PostgreSQL user_profiles
  if (isPostgresPersistenceActive()) {
    try {
      await query(
        'UPDATE user_profiles SET must_change_password = true, temp_password_created_at = NOW(), updated_at = NOW() WHERE id = $1;',
        [userId]
      );
    } catch { }
  }

  await store.transact((db) => {
    const u = db.users.find((usr) => usr.id === userId || usr.email.toLowerCase() === userEmail);
    if (u) {
      (u as any).must_change_password = true;
      (u as any).temp_password_created_at = now;
      if (!isLiveSupabaseAuthConfigured()) {
        u.password_hash = bcrypt.hashSync(newTempPassword, 8);
      }
    }
  });

  return { temporaryPassword: newTempPassword };
}

/**
 * Activate or deactivate an account.
 */
export async function updateAccountActiveStatus(
  userId: string,
  isActive: boolean
): Promise<{ success: boolean }> {
  const userRecord = store.data.users.find((u) => u.id === userId || u.email.toLowerCase() === userId.toLowerCase());
  const userEmail = userRecord?.email?.toLowerCase() || '';
  const supabase = getSupabaseAdmin();

  if (isLiveSupabaseAuthConfigured() && supabase) {
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      ban_duration: isActive ? 'none' : '876000h', // 100 years ban if deactivated
    });
    if (error) {
      throw new Error(`Failed to update account status in Supabase: ${error.message}`);
    }
  } else {
    for (const [emailKey, mockUser] of mockAuthUsers.entries()) {
      if (mockUser.id === userId || emailKey === userEmail || mockUser.email.toLowerCase() === userEmail) {
        mockUser.isActive = isActive;
        break;
      }
    }
  }

  // Update in PostgreSQL user_profiles
  if (isPostgresPersistenceActive()) {
    try {
      await query(
        'UPDATE user_profiles SET is_active = $1, updated_at = NOW() WHERE id = $2;',
        [isActive, userId]
      );
    } catch { }
  }

  await store.transact((db) => {
    const u = db.users.find((usr) => usr.id === userId || usr.email.toLowerCase() === userEmail);
    if (u) {
      (u as any).is_active = isActive;
    }
  });

  return { success: true };
}
