/**
 * Stateless, HMAC-signed session tokens for Digital Profile auth (Stage M1).
 *
 * Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256). The payload
 * carries the user id and expiry; the signature is verified with the session
 * secret. Signing lives in `signed-token.ts`, shared with the self-check visitor
 * token, so both are Web Crypto and the SAME code runs in Node route handlers
 * AND in edge middleware.
 *
 * This module is edge-safe: it must NOT import Node-only modules (node:crypto,
 * Prisma, scrypt). Role/active-state are re-checked against the DB in the guard.
 */

import { readSignedToken, signToken } from "./signed-token";

export const DP_SESSION_COOKIE = "dp_session";
export const DP_SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

export interface SessionPayload {
  uid: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
}

/** Creates a signed session token for a user id. */
export async function createSessionToken(
  uid: string,
  secret: string,
  ttlSeconds = DP_SESSION_TTL_SECONDS
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // Field order is part of the token bytes: sessions issued before the shared
  // signer must keep verifying after it.
  const payload: SessionPayload = { uid, iat: now, exp: now + ttlSeconds };
  return signToken(payload, secret);
}

/** Verifies signature + expiry. Returns the payload or null. */
export async function verifySessionToken(
  token: string | undefined | null,
  secret: string
): Promise<SessionPayload | null> {
  const payload = await readSignedToken(token, secret);
  if (!payload) return null;
  // The visitor token of the public site is signed with the same secret and
  // carries `kind`. A session never does, so a body with `kind` is not a
  // session — even if it happens to contain a `uid`.
  if ("kind" in payload) return null;
  if (typeof payload.uid !== "string" || !payload.uid || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload as unknown as SessionPayload;
}
