import fs from 'fs';
import path from 'path';

export type AllowedFileCategory = 'image' | 'pdf' | 'excel';

export interface FileValidationResult {
  valid: boolean;
  error?: string;
  detectedType?: string;
}

// Magic bytes definitions
const SIGNATURES = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG header
  jpeg: [0xff, 0xd8, 0xff], // JPEG SOI
  xlsx: [0x50, 0x4b, 0x03, 0x04], // ZIP / XLSX
  xlsLegacy: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // OLE2 Compound Doc (legacy XLS)
};

/**
 * Checks if the buffer starts with the expected magic bytes.
 */
function matchesSignature(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Inspects a buffer to determine its actual binary content type.
 */
export function detectBufferType(buffer: Buffer): 'pdf' | 'png' | 'jpeg' | 'excel' | 'unknown' {
  if (matchesSignature(buffer, SIGNATURES.pdf)) return 'pdf';
  if (matchesSignature(buffer, SIGNATURES.png)) return 'png';
  if (matchesSignature(buffer, SIGNATURES.jpeg)) return 'jpeg';
  if (matchesSignature(buffer, SIGNATURES.xlsx) || matchesSignature(buffer, SIGNATURES.xlsLegacy)) return 'excel';
  return 'unknown';
}

/**
 * Validates a file buffer against allowed file categories and extensions.
 * Enforces magic-byte verification to reject disguised files (e.g. .exe or .html renamed to .pdf).
 */
export function validateFileBuffer(
  buffer: Buffer,
  originalFilename: string,
  allowedCategories: AllowedFileCategory[]
): FileValidationResult {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'Empty file payload' };
  }

  // Prevent path traversal in filename
  const cleanName = path.basename(originalFilename).trim();
  if (cleanName.includes('..') || cleanName.includes('/') || cleanName.includes('\\')) {
    return { valid: false, error: 'Invalid filename containing path traversal characters' };
  }

  const ext = path.extname(cleanName).toLowerCase();
  const detected = detectBufferType(buffer);

  // Validate according to requested categories
  let categoryMatched = false;

  for (const cat of allowedCategories) {
    if (cat === 'image') {
      if ((detected === 'png' || detected === 'jpeg') && ['.png', '.jpg', '.jpeg'].includes(ext)) {
        categoryMatched = true;
        break;
      }
    } else if (cat === 'pdf') {
      if (detected === 'pdf' && ext === '.pdf') {
        categoryMatched = true;
        break;
      }
    } else if (cat === 'excel') {
      if (detected === 'excel' && ['.xlsx', '.xls'].includes(ext)) {
        categoryMatched = true;
        break;
      }
    }
  }

  if (!categoryMatched) {
    return {
      valid: false,
      error: `File failed security validation: detected binary format [${detected}] does not match allowed types [${allowedCategories.join(', ')}] with extension [${ext}]`,
      detectedType: detected,
    };
  }

  return { valid: true, detectedType: detected };
}

/**
 * Validates an already written file on disk. If invalid, the file is automatically deleted.
 */
export function validateDiskFile(
  filePath: string,
  originalFilename: string,
  allowedCategories: AllowedFileCategory[]
): FileValidationResult {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: 'File does not exist on disk' };
    }
    // Read the first 4KB to verify magic bytes without loading huge files into memory
    const fd = fs.openSync(filePath, 'r');
    const headerBuffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, headerBuffer, 0, 4096, 0);
    fs.closeSync(fd);

    const checkBuffer = headerBuffer.subarray(0, bytesRead);
    const result = validateFileBuffer(checkBuffer, originalFilename, allowedCategories);

    if (!result.valid) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore deletion error
      }
    }

    return result;
  } catch (err: any) {
    return { valid: false, error: `Validation exception: ${err.message}` };
  }
}

/**
 * Formula injection sanitizer for CSV / Excel exports and imports.
 * Protects against Dynamic Data Exchange (DDE) attacks by prepending an apostrophe (')
 * if a string value starts with dangerous characters (=, +, -, @, \t, \r).
 */
export function sanitizeFormulaInjection(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const dangerousPrefixes = ['=', '+', '-', '@', '\t', '\r'];
  if (dangerousPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
    // Avoid double prefixing if already escaped
    if (trimmed.startsWith("'")) return value;
    return `'${value}`;
  }
  return value;
}
