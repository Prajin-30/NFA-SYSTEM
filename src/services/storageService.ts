import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import { getSupabaseAdmin, isLiveSupabaseAuthConfigured } from './supabaseAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_STORAGE_DIR = path.join(__dirname, '..', '..', 'data', 'nfa-attachments');

export const STORAGE_CONFIG = {
  bucketName: 'nfa-attachments',
  maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB
  allowedMimeTypes: [
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ],
  allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png', '.xlsx', '.xls'],
  blockedExtensions: [
    '.exe', '.bat', '.cmd', '.sh', '.php', '.js', '.ts', '.py',
    '.vbs', '.ps1', '.msi', '.jar', '.scr', '.com', '.bin', '.pif', '.dll', '.so',
  ],
};

// Ensure local fallback storage directory exists
if (!fs.existsSync(LOCAL_STORAGE_DIR)) {
  fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
}

export interface AttachmentValidationResult {
  valid: boolean;
  error?: string;
}

export interface AttachmentUploadResult {
  file_id: string;
  original_filename: string;
  storage_path: string;
  file_size: number;
  file_hash: string;
  mime_type: string;
  uploaded_at: string;
  signed_url?: string;
}

/**
 * Validates file size, MIME type, and extension against institutional security rules.
 */
export function validateAttachmentFile(file: {
  originalname: string;
  mimetype: string;
  size: number;
}): AttachmentValidationResult {
  if (!file) {
    return { valid: false, error: 'File metadata is missing' };
  }

  // 1. Size check
  if (file.size > STORAGE_CONFIG.maxFileSizeBytes) {
    return {
      valid: false,
      error: `File size exceeds the 10 MB institutional limit (${(file.size / (1024 * 1024)).toFixed(2)} MB).`,
    };
  }
  if (file.size <= 0) {
    return { valid: false, error: 'File is empty (0 bytes).' };
  }

  // 2. Extension check
  const ext = path.extname(file.originalname).toLowerCase();
  if (STORAGE_CONFIG.blockedExtensions.includes(ext)) {
    return {
      valid: false,
      error: `Executable or script file type '${ext}' is strictly prohibited.`,
    };
  }

  if (!STORAGE_CONFIG.allowedExtensions.includes(ext)) {
    return {
      valid: false,
      error: `Unsupported file extension '${ext}'. Allowed types: PDF, JPG, PNG, XLSX, XLS.`,
    };
  }

  // 3. MIME type check
  const cleanMime = (file.mimetype || '').toLowerCase();
  if (!STORAGE_CONFIG.allowedMimeTypes.includes(cleanMime)) {
    return {
      valid: false,
      error: `Invalid file MIME type '${cleanMime}'. Allowed: PDF, JPEG, PNG, Excel spreadsheets.`,
    };
  }

  return { valid: true };
}

/**
 * Check if live Supabase Storage is configured and operational.
 */
export function isLiveStorageConfigured(): boolean {
  return isLiveSupabaseAuthConfigured();
}

/**
 * Inspect or ensure the private 'nfa-attachments' storage bucket exists in Supabase.
 */
export async function ensureAttachmentsBucket(): Promise<{ exists: boolean; error?: string }> {
  if (!isLiveStorageConfigured()) {
    // Local development fallback
    if (!fs.existsSync(LOCAL_STORAGE_DIR)) {
      fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
    }
    return { exists: true };
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return { exists: false, error: 'Supabase admin client unavailable' };
  }

  try {
    const { data: bucket, error: getErr } = await supabase.storage.getBucket(STORAGE_CONFIG.bucketName);
    if (!getErr && bucket) {
      return { exists: true };
    }

    // Attempt creation of private bucket if not found
    const { error: createErr } = await supabase.storage.createBucket(STORAGE_CONFIG.bucketName, {
      public: false,
      fileSizeLimit: STORAGE_CONFIG.maxFileSizeBytes,
      allowedMimeTypes: STORAGE_CONFIG.allowedMimeTypes,
    });

    if (createErr) {
      return { exists: false, error: createErr.message };
    }

    return { exists: true };
  } catch (err: any) {
    return { exists: false, error: err?.message || String(err) };
  }
}

/**
 * Upload an attachment file to Supabase Storage (or local storage fallback).
 */
export async function uploadAttachment(params: {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  nfaId?: string;
  userId?: string;
}): Promise<AttachmentUploadResult> {
  const { buffer, originalname, mimetype, nfaId } = params;

  // Validate file
  const val = validateAttachmentFile({
    originalname,
    mimetype,
    size: buffer.length,
  });
  if (!val.valid) {
    throw new Error(val.error);
  }

  const ext = path.extname(originalname).toLowerCase();
  const fileId = uuid();
  const safeBase = path.basename(originalname, ext).replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 50);
  const safeFilename = `${fileId}_${safeBase}${ext}`;
  const folder = nfaId ? `nfa-${nfaId}` : 'general';
  const storagePath = `${folder}/${safeFilename}`;

  // Compute SHA-256 hash
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const now = new Date().toISOString();

  if (isLiveStorageConfigured()) {
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error('Supabase admin client not initialized');

    const { error: uploadErr } = await supabase.storage
      .from(STORAGE_CONFIG.bucketName)
      .upload(storagePath, buffer, {
        contentType: mimetype,
        upsert: false,
      });

    if (uploadErr) {
      throw new Error(`Supabase Storage upload failed: ${uploadErr.message}`);
    }

    // Generate short-lived signed download URL (5 minutes)
    let signedUrl = '';
    const { data: signedData } = await supabase.storage
      .from(STORAGE_CONFIG.bucketName)
      .createSignedUrl(storagePath, 300);
    if (signedData?.signedUrl) {
      signedUrl = signedData.signedUrl;
    }

    return {
      file_id: fileId,
      original_filename: originalname,
      storage_path: storagePath,
      file_size: buffer.length,
      file_hash: hash,
      mime_type: mimetype,
      uploaded_at: now,
      signed_url: signedUrl,
    };
  }

  // Local filesystem fallback
  const localTargetFolder = path.join(LOCAL_STORAGE_DIR, folder);
  if (!fs.existsSync(localTargetFolder)) {
    fs.mkdirSync(localTargetFolder, { recursive: true });
  }
  const localFilePath = path.join(LOCAL_STORAGE_DIR, storagePath);
  fs.writeFileSync(localFilePath, buffer);

  // Also maintain root flat file for backward compatibility with existing routes
  const flatFilePath = path.join(LOCAL_STORAGE_DIR, safeFilename);
  fs.writeFileSync(flatFilePath, buffer);

  return {
    file_id: fileId,
    original_filename: originalname,
    storage_path: safeFilename,
    file_size: buffer.length,
    file_hash: hash,
    mime_type: mimetype,
    uploaded_at: now,
    signed_url: `/api/nfas/attachment-preview/${encodeURIComponent(safeFilename)}`,
  };
}

/**
 * Generate a short-lived (default 5 min / 300s) signed URL for private attachment access.
 */
export async function createSignedAttachmentUrl(
  storagePath: string,
  expiresInSeconds: number = 300
): Promise<string> {
  if (isLiveStorageConfigured()) {
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error('Supabase client unavailable');

    const { data, error } = await supabase.storage
      .from(STORAGE_CONFIG.bucketName)
      .createSignedUrl(storagePath, expiresInSeconds);

    if (error || !data?.signedUrl) {
      throw new Error(`Failed to generate signed attachment URL: ${error?.message || 'Unknown'}`);
    }

    return data.signedUrl;
  }

  // Local fallback preview URL
  const baseName = path.basename(storagePath);
  return `/api/nfas/attachment-preview/${encodeURIComponent(baseName)}`;
}

/**
 * Retrieve binary buffer of an attachment file.
 */
export async function getAttachmentBuffer(storagePath: string): Promise<Buffer> {
  if (isLiveStorageConfigured()) {
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error('Supabase client unavailable');

    const { data, error } = await supabase.storage
      .from(STORAGE_CONFIG.bucketName)
      .download(storagePath);

    if (error || !data) {
      throw new Error(`Failed to download attachment from storage: ${error?.message || 'Not found'}`);
    }

    const arrayBuf = await data.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  // Local file read
  const baseName = path.basename(storagePath);
  const possiblePaths = [
    path.join(LOCAL_STORAGE_DIR, storagePath),
    path.join(LOCAL_STORAGE_DIR, baseName),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p);
    }
  }

  throw new Error(`Attachment file not found locally: ${storagePath}`);
}

/**
 * Delete an attachment file from storage.
 */
export async function deleteAttachment(storagePath: string): Promise<boolean> {
  if (isLiveStorageConfigured()) {
    const supabase = getSupabaseAdmin();
    if (!supabase) return false;

    const { error } = await supabase.storage
      .from(STORAGE_CONFIG.bucketName)
      .remove([storagePath]);

    return !error;
  }

  // Local file delete
  const baseName = path.basename(storagePath);
  const possiblePaths = [
    path.join(LOCAL_STORAGE_DIR, storagePath),
    path.join(LOCAL_STORAGE_DIR, baseName),
  ];

  let deleted = false;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      deleted = true;
    }
  }
  return deleted;
}
