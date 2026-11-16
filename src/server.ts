import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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
import { requireAuth, AuthedRequest } from './middleware/auth.js';
import { store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const signaturesDir = path.join(__dirname, '..', 'data', 'signatures');
export const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  const isSenior = ['super_admin', 'director', 'finance', 'dean', 'associate_dean'].includes(user.role);
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

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = Number(process.env.PORT) || 4000;
if (process.env.NODE_ENV !== 'test') {
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
}
