/**
 * Password hashing using Node's built-in scrypt — no external/native dependencies.
 * Stored format: `scrypt$N$r$p$saltHex$keyHex`.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)));
  });
}

const N = 16384; // CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error("password must not be empty");
  const salt = randomBytes(SALT_BYTES);
  const key = (await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P })) as Buffer;
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Even-length hex with at least one byte — anything else is not a field this format wrote. */
const HEX = /^(?:[0-9a-fA-F]{2})+$/;
// Generous ceilings on the cost parameters, so a stored row can raise them later without a code
// change but cannot ask for a gigabyte of scratch space on a login attempt.
const MAX_N = 1 << 20, MAX_R = 32, MAX_P = 16;

/**
 * Check a password against a stored hash. Anything that is not a hash this module could have
 * written is a NO — never an error, and never a yes.
 *
 * That last part was not true. The parameters are read back out of the stored string (so the cost
 * can be raised later without invalidating existing hashes), and nothing checked what came out:
 *
 *   - `scrypt$16384$8$1$aabb$` — an empty key field — derived a zero-length key, compared it
 *     against a zero-length expectation, and returned TRUE. Every password authenticated.
 *   - a non-numeric or out-of-range cost threw a RangeError out of the function, so a single
 *     corrupt row turned a sign-in attempt into a 500 instead of "invalid credentials".
 *
 * Neither is reachable through the API as it stands — every write goes through `hashPassword`,
 * which always produces a 64-byte key. They are reachable through the paths nobody tests: a
 * restore that truncated a column, a hand-edited row, an importer written later. A function that
 * decides whether someone gets in has to fail closed on input it does not recognise, whether or
 * not today's callers can produce it.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, keyHex] = parts;

  // Both halves must be real hex. `Buffer.from` stops at the first bad character rather than
  // failing, so "aabbzz" would otherwise silently become a two-byte salt.
  if (!HEX.test(saltHex ?? "") || !HEX.test(keyHex ?? "")) return false;
  const salt = Buffer.from(saltHex!, "hex");
  const expected = Buffer.from(keyHex!, "hex");
  if (expected.length < KEYLEN) return false; // a short key is a truncated row, not a weak password

  const N = Number(nStr), r = Number(rStr), p = Number(pStr);
  const sane = (v: number, max: number) => Number.isInteger(v) && v >= 1 && v <= max;
  // N must additionally be a power of two — OpenSSL rejects anything else, and it rejects it by
  // throwing.
  if (!sane(N, MAX_N) || (N & (N - 1)) !== 0 || !sane(r, MAX_R) || !sane(p, MAX_P)) return false;

  let key: Buffer;
  try {
    key = (await scryptAsync(password, salt, expected.length, { N, r, p })) as Buffer;
  } catch {
    // Whatever the derivation objected to, the answer to "is this the right password" is no.
    return false;
  }
  return key.length === expected.length && timingSafeEqual(key, expected);
}
