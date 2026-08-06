import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * At-rest encryption for eBay OAuth tokens.
 *
 * A refresh token is, in practice, the seller account: it can list, reprice and
 * end items for as long as it lives. Storing it in plaintext means a database
 * leak alone is enough to take over the account. Encrypting with a key held
 * only in the environment means the attacker needs both.
 *
 * AES-256-GCM rather than CBC because it authenticates: a tampered ciphertext
 * fails to decrypt rather than yielding garbage that gets sent to eBay.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, the GCM standard
const KEY_LENGTH = 32;

export class TokenEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenEncryptionError';
  }
}

function loadKey(rawKey?: string): Buffer {
  const value = rawKey ?? process.env.TOKEN_ENCRYPTION_KEY;
  if (!value) {
    throw new TokenEncryptionError(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new TokenEncryptionError(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes, got ${key.length}`,
    );
  }
  return key;
}

/** Returns `iv.ciphertext.authTag`, all base64. */
export function encryptToken(plaintext: string, rawKey?: string): string {
  if (!plaintext) throw new TokenEncryptionError('refusing to encrypt an empty token');

  const key = loadKey(rawKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('base64'), ciphertext.toString('base64'), authTag.toString('base64')].join(
    '.',
  );
}

export function decryptToken(encrypted: string, rawKey?: string): string {
  const parts = encrypted.split('.');
  if (parts.length !== 3) {
    throw new TokenEncryptionError('ciphertext is not in the expected iv.data.tag form');
  }

  const key = loadKey(rawKey);
  const [ivPart, dataPart, tagPart] = parts as [string, string, string];

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM authentication failed: the ciphertext or the key is wrong. Either way
    // the right answer is to refuse, not to return whatever bytes came out.
    throw new TokenEncryptionError(
      'token failed authentication — it was tampered with, or the key has changed',
    );
  }
}

/** Redact a token for logging. Never log the token itself. */
export function maskToken(token: string): string {
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} chars)`;
}
