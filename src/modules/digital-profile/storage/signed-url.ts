/**
 * HMAC-signed URLs for private evidence/report downloads.
 *
 * Tokens encode an expiry timestamp and a signature over `${storageKey}.${exp}`.
 * They are opaque, tamper-evident and time-limited. No file is ever served from
 * a public path — clients must present a valid token to the download route.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { digitalProfileConfig } from "../config";

function sign(payload: string): string {
  return createHmac("sha256", digitalProfileConfig.signedUrl.secret)
    .update(payload)
    .digest("base64url");
}

export interface SignedToken {
  token: string;
  expiresAt: number; // epoch seconds
}

/** Creates a signed token for a storage key, valid for `ttlSeconds`. */
export function createSignedToken(
  storageKey: string,
  ttlSeconds = digitalProfileConfig.signedUrl.ttlSeconds
): SignedToken {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = sign(`${storageKey}.${expiresAt}`);
  return { token: `${expiresAt}.${signature}`, expiresAt };
}

/** Verifies a token against a storage key. Returns true only if valid + unexpired. */
export function verifySignedToken(storageKey: string, token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expStr, signature] = parts;
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;

  const expected = sign(`${storageKey}.${expiresAt}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Builds the relative download URL for a screenshot with a fresh token. */
export function buildScreenshotDownloadUrl(
  screenshotId: string,
  storageKey: string,
  ttlSeconds?: number
): string {
  const { token } = createSignedToken(storageKey, ttlSeconds);
  return `/api/digital-profile/screenshots/${screenshotId}/download?token=${encodeURIComponent(
    token
  )}`;
}
