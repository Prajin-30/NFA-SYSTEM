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

/** Minimum dimensions for a valid signature image */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 70;
const MIN_SIZE_BYTES = 1000; // 1 KB

/**
 * Read PNG IHDR chunk to extract image dimensions without loading the full image.
 * Returns null if file is not a valid PNG or cannot be read.
 * PNG layout: 8-byte signature + IHDR chunk (4 len + 4 "IHDR" + 4 width + 4 height + ...)
 * Width at offset 16, height at offset 20 (big-endian UInt32).
 */
function getPngDimensions(filePath: string): { width: number; height: number } | null {
  try {
    const buf = Buffer.alloc(24);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (bytesRead < 24) return null;
    // Validate PNG magic bytes
    const pngSig = buf.subarray(0, 8);
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!pngSig.equals(expected)) return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Returns true when the PNG file at filePath passes all validity checks:
 * - File exists
 * - Size >= MIN_SIZE_BYTES
 * - Valid PNG magic bytes
 * - Dimensions >= MIN_WIDTH × MIN_HEIGHT
 */
function isSignatureValid(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_SIZE_BYTES) return false;
    const dims = getPngDimensions(filePath);
    if (!dims) return false;
    return dims.width >= MIN_WIDTH && dims.height >= MIN_HEIGHT;
  } catch {
    return false;
  }
}

// Save uploads to a temporary filename so we can validate before committing
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, signaturesDir);
  },
  filename: (req: AuthedRequest, _file, cb) => {
    const targetId = req.params.id || req.user?.id || 'unknown';
    // Write to temp file first; we rename after validation
    cb(null, `${targetId}_upload_tmp.png`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype === 'image/png' || ext === '.png') {
      cb(null, true);
    } else {
      cb(new Error('Only PNG images are allowed for digital signatures (transparent background recommended).'));
    }
  },
});

export const usersRouter = Router();
usersRouter.use(requireAuth);

/**
 * GET /api/users/me — Current authenticated user profile with verified signature status.
 * `signature_valid` is true only when the PNG file exists, is ≥ 1 KB, is a valid PNG,
 * and has dimensions ≥ 200 × 70 px.
 */
usersRouter.get('/me', (req: AuthedRequest, res) => {
  const user = store.data.users.find((u) => u.id === req.user!.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const sigFile = path.join(signaturesDir, `${user.id}.png`);
  const hasSignature = fs.existsSync(sigFile);
  const signatureValid = hasSignature && isSignatureValid(sigFile);

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    department_id: user.department_id,
    has_signature: hasSignature,
    signature_valid: signatureValid,
    signature_url: signatureValid ? `/api/signatures/${user.id}.png` : null,
    signature_image: user.signature_image || (signatureValid ? `${user.id}.png` : null),
  });
});

/**
 * POST /api/users/:id/signature — Upload / update digital signature in PNG format.
 * Security: Only the account owner or super_admin may upload a signature.
 *
 * Validation pipeline:
 *  1. multer: MIME/extension check + 2 MB size limit
 *  2. File size >= 1 KB (rejects 1×1 placeholder PNGs that are ~68 bytes)
 *  3. Valid PNG magic bytes (rejects files renamed to .png)
 *  4. Dimensions >= 200 × 70 px (rejects tiny placeholder images)
 *
 * Save pipeline (preserves history correctly):
 *  1. multer writes to {userId}_upload_tmp.png
 *  2. Validation runs on tmp file
 *  3. If {userId}.png already exists, copy it to {userId}_{timestamp}.png (timestamped backup of PREVIOUS signature)
 *  4. Rename tmp file to {userId}.png
 *  5. Update user record in db
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

    const tmpPath = req.file.path; // {signaturesDir}/{userId}_upload_tmp.png
    const finalPath = path.join(signaturesDir, `${targetId}.png`);

    // ── VALIDATION ──────────────────────────────────────────────────────────
    const fileSize = req.file.size;
    if (fileSize < MIN_SIZE_BYTES) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return res.status(400).json({
        error: `Signature file is too small (${fileSize} bytes). Please upload a real PNG signature image. Minimum size: ${MIN_SIZE_BYTES} bytes.`,
      });
    }

    const dims = getPngDimensions(tmpPath);
    if (!dims) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return res.status(400).json({
        error: 'Uploaded file is not a valid PNG image. Please upload a genuine PNG signature.',
      });
    }

    if (dims.width < MIN_WIDTH || dims.height < MIN_HEIGHT) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return res.status(400).json({
        error: `Signature image is too small (${dims.width}×${dims.height} px). Minimum: ${MIN_WIDTH}×${MIN_HEIGHT} px. Recommended: 600×200 px with transparent background.`,
      });
    }
    // ── END VALIDATION ───────────────────────────────────────────────────────

    // ── BACKUP (copy the PREVIOUS file before overwriting it) ────────────────
    if (fs.existsSync(finalPath)) {
      try {
        const backupFilename = `${targetId}_${Date.now()}.png`;
        fs.copyFileSync(finalPath, path.join(signaturesDir, backupFilename));
      } catch {
        // Non-fatal: backup failure does not block the upload
      }
    }

    // ── COMMIT (rename tmp → {userId}.png) ──────────────────────────────────
    try {
      fs.renameSync(tmpPath, finalPath);
    } catch (renameErr: any) {
      // On some systems (cross-device) rename may fail; fall back to copy+delete
      try {
        fs.copyFileSync(tmpPath, finalPath);
        fs.unlinkSync(tmpPath);
      } catch {
        try { fs.unlinkSync(tmpPath); } catch {}
        return res.status(500).json({ error: 'Failed to save signature file. Please try again.' });
      }
    }

    const filename = `${targetId}.png`;
    await store.transact((db) => {
      const u = db.users.find((usr) => usr.id === targetId);
      if (u) {
        u.signature_image = filename;
      }
    });

    res.json({
      success: true,
      message: `Digital signature uploaded successfully (${dims.width}×${dims.height} px)`,
      signature_url: `/api/signatures/${filename}?v=${Date.now()}`,
      dimensions: dims,
    });
  });
});

/**
 * DELETE /api/users/:id/signature — Remove signature.
 * Does not delete timestamped backup files so historical approval records remain valid.
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
    // Archive as a timestamped backup before deleting (preserves history for existing approvals)
    try {
      const archiveFilename = `${targetId}_${Date.now()}.png`;
      fs.copyFileSync(sigFile, path.join(signaturesDir, archiveFilename));
      fs.unlinkSync(sigFile);
    } catch {
      try { fs.unlinkSync(sigFile); } catch {}
    }
  }

  await store.transact((db) => {
    const u = db.users.find((usr) => usr.id === targetId);
    if (u) {
      delete u.signature_image;
    }
  });

  res.json({ success: true, message: 'Signature removed (historical backup preserved)' });
});
