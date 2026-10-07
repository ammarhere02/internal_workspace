import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: { N: number }) => Promise<Buffer>;
const N = 16384, KEYLEN = 64;

/** scrypt (built into Node, no native dependency). Stored as `scrypt$<salt hex>$<hash hex>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-time compare; a malformed stored hash verifies false instead of throwing. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), KEYLEN, { N });
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}
