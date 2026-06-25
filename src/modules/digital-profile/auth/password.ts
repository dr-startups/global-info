/**
 * Password hashing for Digital Profile users (Stage M1).
 *
 * Uses Node's built-in scrypt (no external dependency). Hashes are stored as
 *   scrypt$N$r$p$<saltB64url>$<hashB64url>
 * Plain passwords are never stored or logged. Verification is constant-time.
 *
 * Node-only module — must not be imported into edge/middleware or client code.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

const N = 16384; // CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N2 = Number(parts[1]);
    const R2 = Number(parts[2]);
    const P2 = Number(parts[3]);
    const salt = Buffer.from(parts[4], "base64url");
    const expected = Buffer.from(parts[5], "base64url");
    if (!Number.isFinite(N2) || !Number.isFinite(R2) || !Number.isFinite(P2)) {
      return false;
    }
    const derived = await scrypt(password, salt, expected.length, {
      N: N2,
      r: R2,
      p: P2,
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
