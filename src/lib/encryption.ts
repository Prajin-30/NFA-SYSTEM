import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Derives a dedicated 32-byte AES-256 encryption key from BANK_DETAILS_ENCRYPTION_KEY.
 * The previous fallback to JWT_SECRET has been permanently removed to eliminate
 * the risk of data corruption upon session secret rotation.
 * A dedicated key is strictly required when the bank details feature is enabled.
 */
function getEncryptionKey(): Buffer {
  const secret = process.env.BANK_DETAILS_ENCRYPTION_KEY;
  if (!secret || !secret.trim()) {
    if (process.env.NODE_ENV === 'test') {
      // Deterministic key for automated unit/integration test runners
      return crypto.createHash('sha256').update('cu-nfa-test-only-bank-encryption-key-32chars!').digest();
    }
    throw new Error(
      'FATAL CONFIGURATION ERROR: BANK_DETAILS_ENCRYPTION_KEY is required when the bank details feature is enabled. ' +
      'Please configure a dedicated, cryptographically strong encryption secret (minimum 32 characters) in your environment variables. ' +
      'Fallback to JWT_SECRET has been permanently deprecated for security compliance.'
    );
  }
  if (secret.trim().length < 16) {
    throw new Error('BANK_DETAILS_ENCRYPTION_KEY must be at least 16 characters (recommended 32+ characters).');
  }
  return crypto.createHash('sha256').update(secret.trim()).digest();
}

export interface EncryptedData {
  encrypted_account_number: string;
  iv: string;
  auth_tag: string;
  masked_account_number: string;
}

/**
 * Validates an Indian Financial System Code (IFSC).
 * Format: 4 uppercase alphabets, 0, followed by 6 alphanumeric characters.
 * Example: SBIN0001234, HDFC0000123, CNRB0002540
 */
export function validateIfsc(ifsc: string): boolean {
  if (!ifsc || typeof ifsc !== 'string') return false;
  const clean = ifsc.trim().toUpperCase();
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(clean);
}

/**
 * Masks a bank account number, displaying only the last 4 digits.
 * E.g. "123456789012" -> "••••••••9012"
 */
export function maskAccountNumber(accountNumber: string): string {
  if (!accountNumber) return '';
  const clean = String(accountNumber).trim();
  if (clean.length <= 4) {
    return '••••' + clean;
  }
  const lastFour = clean.slice(-4);
  const maskedPrefix = '•'.repeat(Math.max(4, clean.length - 4));
  return `${maskedPrefix}${lastFour}`;
}

/**
 * Encrypts an account number using authenticated AES-256-GCM.
 */
export function encryptAccountNumber(plaintext: string): EncryptedData {
  const clean = String(plaintext).trim();
  if (!clean) {
    throw new Error('Account number is required for encryption');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(clean, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted_account_number: encrypted,
    iv: iv.toString('hex'),
    auth_tag: authTag,
    masked_account_number: maskAccountNumber(clean),
  };
}

/**
 * Decrypts an AES-256-GCM encrypted account number.
 */
export function decryptAccountNumber(encryptedHex: string, ivHex: string, authTagHex: string): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
