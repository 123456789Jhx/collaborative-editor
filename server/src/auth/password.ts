import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with the `scrypt` that ships in Node — no native addon, so it
 * works unchanged under `tsx` in development and in the alpine runtime image.
 *
 * scrypt is memory-hard, which is the property that matters here: a GPU farm
 * gains far less against it than against a plain salted SHA.
 */

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/**
 * `maxmem` is not optional. scrypt needs `128 * N * r` bytes, so N=2^15 with
 * r=8 wants 33.5 MB while Node's default `maxmem` is 32 MB — every call would
 * throw ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Measured at ~58 ms per hash in the
 * container, which is the intended cost.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/**
 * Four, not eight, because the operator's own admin password has to pass this
 * same check and this deployment is deliberately using a short one. It is a
 * single constant rather than a special case for the seed so that the rule the
 * registration form advertises is the rule the server enforces.
 */
export const MIN_PASSWORD_LENGTH = 4;

export interface PasswordRecord {
  /** Hex-encoded derived key. */
  hash: string;
  /** Hex-encoded per-user salt. */
  salt: string;
}

export function hashPassword(password: string): PasswordRecord {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_LENGTH, PARAMS);
  return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

/**
 * Constant-time comparison. Returns false rather than throwing on a malformed
 * record, because `timingSafeEqual` throws on differing lengths and a corrupt
 * row should read as "wrong password", not as a 500.
 *
 * The length guard is what catches a corrupt record: `Buffer.from(x, "hex")`
 * silently stops at the first non-hex character instead of throwing, so a
 * truncated hash arrives here as a short buffer.
 */
export function verifyPassword(password: string, record: PasswordRecord): boolean {
  const expected = Buffer.from(record.hash, "hex");
  const salt = Buffer.from(record.salt, "hex");
  if (expected.length !== KEY_LENGTH || salt.length !== SALT_BYTES) return false;

  const actual = scryptSync(password, salt, KEY_LENGTH, PARAMS);
  return timingSafeEqual(actual, expected);
}
