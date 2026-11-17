import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { query, getDbPool } from './pool.js';
import {
  generateTemporaryPassword,
  validateUniversityEmail,
  getSupabaseAdmin,
  isLiveSupabaseAuthConfigured,
  getMockAuthUsers,
  InstitutionalUserProfile,
} from '../services/supabaseAuth.js';
import { store } from '../store.js';

dotenv.config();

export interface BootstrapResult {
  success: boolean;
  code?: 'ALREADY_EXISTS' | 'INVALID_EMAIL' | 'AUTH_ERROR' | 'DB_ERROR' | 'SUCCESS';
  message: string;
  user?: InstitutionalUserProfile;
  temporaryPassword?: string;
}

/**
 * Bootstraps the first institutional Super Admin account.
 * 
 * Safety & Security Guarantees:
 * 1. Checks if an active Super Admin already exists in the database. If so, aborts immediately.
 * 2. Enforces approved university email domain validation (@christuniversity.in, @christ.edu).
 * 3. Generates a high-entropy 14-character cryptographic temporary password.
 * 4. Creates user in Supabase Auth via Admin API with email_confirm = true.
 * 5. Atomically records profile in PostgreSQL user_profiles table.
 * 6. Rolls back Supabase Auth user if PostgreSQL insert fails to avoid orphaned auth accounts.
 * 7. Enforces must_change_password = true on first login.
 */
export async function bootstrapSuperAdmin(options: {
  email: string;
  name?: string;
  enforceDomain?: boolean;
}): Promise<BootstrapResult> {
  const cleanEmail = String(options.email || '').trim().toLowerCase();
  const cleanName = String(options.name || 'System Super Administrator').trim();
  const enforceDomain = options.enforceDomain !== false;

  // 1. Validate email
  if (!cleanEmail) {
    return {
      success: false,
      code: 'INVALID_EMAIL',
      message: 'Email address is required for Super Admin bootstrap.',
    };
  }

  if (enforceDomain) {
    const emailCheck = validateUniversityEmail(cleanEmail);
    if (!emailCheck.valid) {
      return {
        success: false,
        code: 'INVALID_EMAIL',
        message: emailCheck.error || 'Invalid university email domain.',
      };
    }
  }

  // 2. Check for existing active Super Admin in PostgreSQL
  const isPostgresActive = Boolean(
    process.env.DATABASE_URL &&
    process.env.NODE_ENV !== 'test' &&
    process.env.MOCK_AUTH !== 'true'
  );
  if (isPostgresActive) {
    try {
      const existingRes = await query(
        `SELECT id, email, name, is_active FROM user_profiles WHERE role = 'super_admin' AND is_active = true LIMIT 1;`
      );
      if (existingRes.rows.length > 0) {
        const existing = existingRes.rows[0];
        return {
          success: false,
          code: 'ALREADY_EXISTS',
          message: `Bootstrap aborted: An active Super Admin already exists in the database (${existing.email}). Duplicate Super Admin bootstrap is strictly prohibited.`,
        };
      }

      // Check if email already belongs to another role
      const emailRes = await query(
        `SELECT id, email, role FROM user_profiles WHERE lower(email) = $1 LIMIT 1;`,
        [cleanEmail]
      );
      if (emailRes.rows.length > 0) {
        return {
          success: false,
          code: 'ALREADY_EXISTS',
          message: `Bootstrap aborted: Email '${cleanEmail}' is already registered with role '${emailRes.rows[0].role}'.`,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        code: 'DB_ERROR',
        message: `Database verification failed: ${err?.message || err}`,
      };
    }
  } else {
    // Check in-memory store in demo mode
    const existingStoreAdmin = store.data.users.find(
      (u) => u.role === 'super_admin' && (u as any).is_active !== false
    );
    if (existingStoreAdmin) {
      return {
        success: false,
        code: 'ALREADY_EXISTS',
        message: `Bootstrap aborted: An active Super Admin already exists in local store (${existingStoreAdmin.email}).`,
      };
    }
  }

  // 3. Generate high-entropy 14-char cryptographic password
  const temporaryPassword = generateTemporaryPassword();
  const supabase = getSupabaseAdmin();
  let authUserId: string;

  // 4. Provision in Supabase Auth
  if (isLiveSupabaseAuthConfigured() && supabase) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: {
        name: cleanName,
        role: 'super_admin',
        bootstrapped_at: new Date().toISOString(),
      },
    });

    if (error || !data.user) {
      return {
        success: false,
        code: 'AUTH_ERROR',
        message: `Supabase Auth Admin user creation failed: ${error?.message || 'Unknown error'}`,
      };
    }

    authUserId = data.user.id;
  } else {
    // Isolated Mock Auth for testing / sandbox harness
    authUserId = crypto.randomUUID();
    const mockUsers = getMockAuthUsers();
    mockUsers.set(cleanEmail, {
      id: authUserId,
      email: cleanEmail,
      passwordHash: bcrypt.hashSync(temporaryPassword, 8),
      mustChangePassword: true,
      isActive: true,
      tempPasswordCreatedAt: new Date().toISOString(),
    });
  }

  const now = new Date().toISOString();
  const profile: InstitutionalUserProfile = {
    id: authUserId,
    name: cleanName,
    email: cleanEmail,
    role: 'super_admin',
    department_id: null,
    must_change_password: true,
    is_active: true,
    temp_password_created_at: now,
  };

  // 5. Insert into PostgreSQL user_profiles with rollback guarantee
  if (isPostgresActive) {
    try {
      await query(
        `INSERT INTO user_profiles (id, name, email, role, department_id, must_change_password, is_active, temp_password_created_at)
         VALUES ($1, $2, $3, 'super_admin', NULL, true, true, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           role = 'super_admin',
           department_id = NULL,
           must_change_password = true,
           is_active = true,
           temp_password_created_at = NOW(),
           updated_at = NOW();`,
        [authUserId, cleanName, cleanEmail]
      );

      // Record audit log entry if table is available
      try {
        await query(
          `INSERT INTO audit_logs (entity_type, entity_id, department_id, changed_by, role, reason, source, approval_status, created_at)
           VALUES ('user_account', $1, 'SYSTEM', $1, 'super_admin', 'Initial system Super Admin bootstrap', 'system', 'APPROVED', NOW());`,
          [authUserId]
        );
      } catch {
        // Non-fatal audit log insertion
      }
    } catch (dbErr: any) {
      // Transactional rollback: Remove created Supabase Auth user if DB persistence fails
      if (isLiveSupabaseAuthConfigured() && supabase) {
        await supabase.auth.admin.deleteUser(authUserId).catch(() => {});
      }
      return {
        success: false,
        code: 'DB_ERROR',
        message: `Database insertion failed: ${dbErr?.message || dbErr}. Auth account was safely rolled back.`,
      };
    }
  }

  // 6. Sync in-memory store for backward compatibility
  await store.transact((db) => {
    const existingIdx = db.users.findIndex((u) => u.email.toLowerCase() === cleanEmail);
    const userRecord = {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      password_hash: isLiveSupabaseAuthConfigured() ? '' : bcrypt.hashSync(temporaryPassword, 8),
      role: profile.role,
      department_id: null,
      created_at: now,
      must_change_password: true,
      is_active: true,
      temp_password_created_at: now,
    } as any;

    if (existingIdx >= 0) {
      db.users[existingIdx] = userRecord;
    } else {
      db.users.push(userRecord);
    }
  });

  return {
    success: true,
    code: 'SUCCESS',
    message: `Super Admin account for ${cleanEmail} successfully bootstrapped.`,
    user: profile,
    temporaryPassword,
  };
}

// CLI handler
async function runCli() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
CU-NFA Super Admin Bootstrap Utility
===================================
Usage:
  npx tsx src/db/bootstrapSuperAdmin.ts <official-email> [full-name]

Requirements:
  - Official university email domain (@christuniversity.in or @christ.edu)
  - Database connection configured in .env
  - Supabase service role key configured in .env

Safety:
  - Aborts if an active Super Admin account already exists.
  - Automatically rolls back Auth user if database record cannot be created.
    `);
    process.exit(0);
  }

  const email = args[0];
  const name = args[1] || 'Super Administrator';

  console.log(`[BOOTSTRAP] Initiating Super Admin bootstrap for: ${email}`);
  const result = await bootstrapSuperAdmin({ email, name });

  if (!result.success) {
    console.error(`[BOOTSTRAP FAILED] ${result.message}`);
    process.exit(1);
  }

  console.log(`[BOOTSTRAP SUCCESS] ${result.message}`);
  console.log(`[USER ID] ${result.user?.id}`);
  console.log(`[ROLE] ${result.user?.role}`);
  console.log(`[MUST CHANGE PASSWORD] ${result.user?.must_change_password}`);

  // Secure local credential delivery (masked from console/transcripts per institutional security policy)
  const credentialDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(credentialDir)) {
    fs.mkdirSync(credentialDir, { recursive: true });
  }
  const credentialPath = path.join(credentialDir, '.super_admin_temp_credential.txt');
  fs.writeFileSync(
    credentialPath,
    `CU-NFA Temporary Administrator Credential\n=========================================\nEmail: ${email}\nTemporary Password: ${result.temporaryPassword}\nGenerated At: ${new Date().toISOString()}\n\nIMPORTANT: Log into http://localhost:4000 and update your password immediately.\nThis file must be deleted upon successful password rotation.\n`,
    { mode: 0o600 }
  );

  console.log(`[TEMPORARY PASSWORD] Securely delivered to local file: data/.super_admin_temp_credential.txt (NOT printed to terminal)`);
  console.log(`\nIMPORTANT: Retrieve the temporary password from data/.super_admin_temp_credential.txt and log into http://localhost:4000. It must be rotated immediately upon first login.`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  runCli().catch((err) => {
    console.error('[UNHANDLED ERROR]', err);
    process.exit(1);
  });
}
