import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { store } from '../store.js';
import { requireAuth, AuthedRequest } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const signaturesDir = path.join(__dirname, '..', '..', 'data', 'signatures');

if (!fs.existsSync(signaturesDir)) {
  fs.mkdirSync(signaturesDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, signaturesDir);
  },
  filename: (req: AuthedRequest, file, cb) => {
    const targetUserId = req.params.id || req.user?.id || 'unknown';
    // Preserve PNG format
    cb(null, `${targetUserId}.png`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype === 'image/png' || ext === '.png') {
      cb(null, true);
    } else {
      cb(new Error('Only PNG images are allowed for digital signatures (preferably with transparent background).'));
    }
  },
});

export const usersRouter = Router();
usersRouter.use(requireAuth);

/**
 * GET /api/users/me — Current authenticated user profile with signature status
 */
usersRouter.get('/me', (req: AuthedRequest, res) => {
  const user = store.data.users.find((u) => u.id === req.user!.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const sigFile = path.join(signaturesDir, `${user.id}.png`);
  const hasSignature = fs.existsSync(sigFile);

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    department_id: user.department_id,
    has_signature: hasSignature,
    signature_url: hasSignature ? `/api/signatures/${user.id}.png` : null,
    signature_image: user.signature_image || (hasSignature ? `${user.id}.png` : null),
  });
});

/**
 * POST /api/users/:id/signature — Upload / update digital signature in PNG format.
 * Security: Only account owner or super_admin may manage a user's signature.
 */
usersRouter.post('/:id/signature', (req: AuthedRequest, res) => {
  const targetId = req.params.id;
  const isOwner = req.user!.id === targetId;
  const isSuperAdmin = req.user!.role === 'super_admin';

  if (!isOwner && !isSuperAdmin) {
    return res.status(403).json({ error: 'Only the account owner or super administrator may manage this signature' });
  }

  upload.single('signature')(req, res, async (err: any) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Failed to upload signature' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Signature file (PNG format) is required' });
    }

    const filename = `${targetId}.png`;

    // Also save an immutable timestamped backup for historical verification
    try {
      const backupFilename = `${targetId}_${Date.now()}.png`;
      fs.copyFileSync(path.join(signaturesDir, filename), path.join(signaturesDir, backupFilename));
    } catch {}

    await store.transact((db) => {
      const u = db.users.find((usr) => usr.id === targetId);
      if (u) {
        u.signature_image = filename;
      }
    });

    res.json({
      success: true,
      message: 'Digital signature uploaded successfully',
      signature_url: `/api/signatures/${filename}?v=${Date.now()}`,
    });
  });
});

/**
 * DELETE /api/users/:id/signature — Remove signature.
 */
usersRouter.delete('/:id/signature', async (req: AuthedRequest, res) => {
  const targetId = req.params.id;
  const isOwner = req.user!.id === targetId;
  const isSuperAdmin = req.user!.role === 'super_admin';

  if (!isOwner && !isSuperAdmin) {
    return res.status(403).json({ error: 'Only the account owner or super administrator may manage this signature' });
  }

  const sigFile = path.join(signaturesDir, `${targetId}.png`);
  if (fs.existsSync(sigFile)) {
    try {
      fs.unlinkSync(sigFile);
    } catch {}
  }

  await store.transact((db) => {
    const u = db.users.find((usr) => usr.id === targetId);
    if (u) {
      delete u.signature_image;
    }
  });

  res.json({ success: true, message: 'Signature removed' });
});
