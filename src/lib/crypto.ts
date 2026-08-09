import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  scrypt as scryptCb,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { promisify } from 'node:util';
import { getEnv } from './env';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt parameters. N=2^15 with r=8 is a widely used interactive-login profile.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEY_LEN = 32;

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison that tolerates differing lengths without leaking. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function hmac(value: string, purpose: string): string {
  // Purpose-binding: a token minted for one use cannot be replayed as another.
  return createHmac('sha256', getEnv().APP_SECRET).update(`${purpose}:${value}`).digest('base64url');
}

// ---------------------------------------------------------------- passwords

/**
 * Password hashing uses Node's built-in scrypt (RFC 7914), a memory-hard KDF.
 * Argon2id would be marginally preferable but requires a native module; scrypt
 * keeps the deployment dependency-free. See LIMITATIONS.md.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length !== KEY_LEN) {
    return false;
  }
  const derived = await scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: SCRYPT.maxmem });
  return timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------- at-rest encryption

function documentKey(): Buffer {
  const raw = Buffer.from(getEnv().DOCUMENT_ENCRYPTION_KEY, 'base64');
  // Normalize whatever length was supplied to a 32-byte key deterministically.
  return createHash('sha256').update(raw).digest();
}

/**
 * AES-256-GCM envelope for document bytes at rest. Format:
 * `v1` | 12-byte IV | 16-byte auth tag | ciphertext.
 */
export function encryptBytes(plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', documentKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('v1'), iv, cipher.getAuthTag(), enc]);
}

export function decryptBytes(envelope: Buffer): Buffer {
  if (envelope.length < 30 || envelope.subarray(0, 2).toString() !== 'v1') {
    throw new Error('Unrecognized ciphertext envelope');
  }
  const iv = envelope.subarray(2, 14);
  const tag = envelope.subarray(14, 30);
  const decipher = createDecipheriv('aes-256-gcm', documentKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(envelope.subarray(30)), decipher.final()]);
}
