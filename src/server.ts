import 'dotenv/config';
import WebSocket from 'ws';

// Ensure global WebSocket is available across Node.js runtime environments
if (typeof (globalThis as any).WebSocket === 'undefined') {
  (globalThis as any).WebSocket = WebSocket;
}

import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { authRouter } from './routes/auth.js';
import { nfasRouter } from './routes/nfas.js';
import { budgetsRouter } from './routes/budgets.js';
import { projectsRouter } from './routes/projects.js';
import { auditRouter } from './routes/audit.js';
import { excelRouter } from './routes/excel.js';
import { adminRouter } from './routes/admin.js';
import { usersRouter } from './routes/users.js';
import { invoicesRouter } from './routes/invoices.js';
import { revenueRouter } from './routes/revenue.js';
import { reportsRouter } from './routes/reports.js';
import { requireAuth, AuthedRequest } from './middleware/auth.js';
import { emergencyModeGuard } from './middleware/emergencyMode.js';
import { securityService } from './services/securityService.js';
import { store } from './store.js';
import { query, closeDbPool } from './db/pool.js';
import { isLiveSupabaseAuthConfigured, getSupabaseAdmin } from './services/supabaseAuth.js';
import { isEmailTestingEnabled } from './services/resendService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const signaturesDir = path.join(__dirname, '..', 'data', 'signatures');
export const app = express();

// Trust reverse proxy (Render cloud infrastructure) to correctly resolve client IP addresses
app.set('trust proxy', 1);

// HTTP Security Headers and Content Security Policy
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'https://*.supabase.co', 'https://*.supabase.com'],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
);

app.use(cors());

// Rate Limiting Protection Layer
const isTestEnv = process.env.NODE_ENV === 'test';

const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10000 : 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'TOO_MANY_REQUESTS',
    message: 'Too many requests from this IP address. Please try again after 15 minutes.',
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10000 : 25,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    securityService.logEvent({
      ip_address: req.ip,
      action: 'RATE_LIMIT_EXCEEDED',
      resource_type: 'auth',
      status: 'blocked',
      severity: 'medium',
    });
    res.status(429).json({
      error: 'TOO_MANY_AUTH_ATTEMPTS',
      message: 'Too many authentication attempts from this IP address. Access temporarily limited for 15 minutes.',
    });
  },
});

const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTestEnv ? 10000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'EXPORT_RATE_LIMIT',
    message: 'Too many export or generation requests. Please slow down and try again.',
  },
});

app.use('/api', globalApiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/mfa', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/reports/*/pdf', exportLimiter);
app.use('/api/reports/*/excel', exportLimiter);
app.use(emergencyModeGuard);
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  },
}));

// Request timeout protection: 45s for export and import endpoints, 15s for general API queries
app.use((req, res, next) => {
  const isExportOrImport = req.path.includes('/export/') || req.path.includes('/import/');
  const timeoutMs = isExportOrImport ? 45000 : 15000;

  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'GATEWAY_TIMEOUT', message: 'Request execution exceeded timeout threshold.' });
    }
  }, timeoutMs);

  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

app.use(async (_req, res, next) => {
  if (store.initPromise) {
    try {
      await store.initPromise;
    } catch (err: any) {
      if (process.env.NODE_ENV !== 'production') {
        return next();
      }
      return res.status(503).json({ error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
  }
  next();
});
app.use(express.json({ limit: '5mb' }));
// Serve favicon.ico directly with fallback
app.get('/favicon.ico', (_req, res) => {
  const icoPath = path.join(__dirname, '..', 'public', 'favicon.ico');
  const logoFallback = path.join(__dirname, '..', 'public', 'christ-logo.png');
  if (fs.existsSync(icoPath)) {
    return res.sendFile(icoPath);
  }
  return res.sendFile(logoFallback);
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
    }
  },
}));

// Dedicated NFA Creation route aliases
app.get(['/nfa/new', '/nfa-create'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'nfa-create.html'));
});

/**
 * GET /api/signatures/:filename — Authenticated, role-validated digital signature retrieval.
 * Unauthenticated requests receive 401; unauthorized access to another user's signature receives 403.
 */
app.get('/api/signatures/:filename', requireAuth, (req: AuthedRequest, res) => {
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(signaturesDir, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Signature file not found' });
  }

  const user = req.user!;
  const isSenior = ['super_admin', 'director', 'finance', 'finance_head', 'dean', 'associate_dean', 'deans_office'].includes(user.role);
  const isSelf = safeFilename.startsWith(user.id);

  if (!isSenior && !isSelf) {
    const nfaMatch = store.data.nfas.find((n) => {
      const isCreator = n.created_by === user.id;
      const isDept = user.role === 'hod' && n.department_id === user.department_id;
      if (!isCreator && !isDept) return false;
      if (n.proposer_signature && safeFilename.includes(n.created_by)) return true;
      const approvals = store.data.approvals.filter((a) => a.nfa_id === n.id);
      return approvals.some((a) => a.signature_image && safeFilename.includes(a.approver_id));
    });

    if (!nfaMatch) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to access this signature' });
    }
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(filePath).pipe(res);
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/nfas', nfasRouter);
app.use('/api/budgets', excelRouter); // /api/budgets/import/* (mounted first so it isn't shadowed)
app.use('/api/budgets', budgetsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/admin', adminRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/revenue', revenueRouter);
app.use('/api/reports', reportsRouter);

app.get('/api/health', async (_req, res) => {
  let dbConnected = false;
  let dbError: string | null = null;
  if (process.env.DATABASE_URL) {
    try {
      await query('SELECT 1;');
      dbConnected = true;
    } catch (err: any) {
      dbError = err?.code || err?.message || 'DB_ERROR';
    }
  }

  let supabaseAuthOk = false;
  let supabaseAuthError: string | null = null;
  const supabase = getSupabaseAdmin();
  if (supabase) {
    try {
      const { error } = await supabase.auth.admin.listUsers({ perPage: 1 });
      if (error) {
        supabaseAuthError = error.message;
      } else {
        supabaseAuthOk = true;
      }
    } catch (err: any) {
      supabaseAuthError = err?.message || 'FETCH_FAILED';
    }
  }

  res.json({
    ok: true,
    time: new Date().toISOString(),
    env: {
      has_supabase_url: Boolean(process.env.SUPABASE_URL),
      has_supabase_service_role_key: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      has_supabase_service_key: Boolean(process.env.SUPABASE_SERVICE_KEY),
      has_supabase_key: Boolean(process.env.SUPABASE_KEY),
      has_supabase_anon_key: Boolean(process.env.SUPABASE_ANON_KEY),
      has_database_url: Boolean(process.env.DATABASE_URL),
      has_data_source: Boolean(process.env.DATA_SOURCE),
      data_source_value: process.env.DATA_SOURCE || null,
      app_env: process.env.APP_ENV || null,
      node_env: process.env.NODE_ENV || null,
      email_test_mode: isEmailTestingEnabled(),
      email_provider: (process.env.EMAIL_PROVIDER || 'mock').trim().toLowerCase(),
      node_version: process.version,
      has_websocket: typeof (globalThis as any).WebSocket !== 'undefined',
      live_auth_configured: isLiveSupabaseAuthConfigured(),
      supabase_auth_ok: supabaseAuthOk,
      supabase_auth_error: supabaseAuthError,
      db_connected: dbConnected,
      db_error: dbError,
    },
  });
});

const PORT = Number(process.env.PORT) || 4000;
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain && process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`\n  University NFA & Budget System API running on http://localhost:${PORT}`);
    console.log(`  Frontend served from the same origin: http://localhost:${PORT}\n`);
  });
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      const fallbackPort = 4050;
      console.log(`  Port ${PORT} in use, trying fallback port ${fallbackPort}...`);
      app.listen(fallbackPort, () => {
        console.log(`\n  University NFA & Budget System API running on http://localhost:${fallbackPort}`);
      });
    } else {
      console.error(err);
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[SERVER] Received ${signal}. Draining connections and shutting down gracefully...`);
    server.close(async () => {
      await closeDbPool();
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[SERVER] Forced shutdown after timeout.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
