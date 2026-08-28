import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { authRouter } from './routes/auth.js';
import { nfasRouter } from './routes/nfas.js';
import { budgetsRouter } from './routes/budgets.js';
import { projectsRouter } from './routes/projects.js';
import { auditRouter } from './routes/audit.js';
import { excelRouter } from './routes/excel.js';
import { adminRouter } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRouter);
app.use('/api/nfas', nfasRouter);
app.use('/api/budgets', excelRouter); // /api/budgets/import/* (mounted first so it isn't shadowed)
app.use('/api/budgets', budgetsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  console.log(`\n  University NFA & Budget System API running on http://localhost:${PORT}`);
  console.log(`  Frontend served from the same origin: http://localhost:${PORT}\n`);
});
