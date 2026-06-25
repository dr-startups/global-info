/**
 * Server-side auth guards for Digital Profile route handlers (Stage M1).
 *
 *   requireDigitalProfileUser(req)      -> AuthUser (401 if missing when enabled)
 *   requireRole(user, action)           -> throws 403 if not permitted
 *   requireCaseAccess(user, caseId, lvl)-> throws 403 if no case access
 *
 * When auth is DISABLED (DIGITAL_PROFILE_AUTH_ENABLED=false), a synthetic
 * SUPER_ADMIN actor is returned so the demo/smoke flow keeps working unchanged.
 * Node-only (Prisma) — never import into middleware/edge.
 */

import { ForbiddenError, UnauthorizedError } from "../http/errors";
import type { ActorContext } from "../services/case-service";
import { assertAuthConfigSafe, getAuthConfig } from "./auth-config";
import { DP_SESSION_COOKIE, verifySessionToken } from "./session";
import { findUserById, type AuthUser } from "./user-service";
import { hasCaseAccess } from "./access-service";
import { can, type DpAccessLevel, type DpAction } from "./roles";

export interface DpAuthUser extends AuthUser {
  /** True when produced by disabled-auth mode (not a real DB user). */
  synthetic?: boolean;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function syntheticActor(req: Request): DpAuthUser {
  const headerActor = req.headers.get("x-actor-id");
  return {
    id: headerActor && headerActor.trim() !== "" ? headerActor.trim() : "dev-no-auth",
    email: "dev@local",
    name: "Local Dev",
    role: "SUPER_ADMIN",
    isActive: true,
    synthetic: true,
  };
}

/** Resolves the current user from the session cookie, or null. */
export async function getOptionalUser(req: Request): Promise<DpAuthUser | null> {
  const cfg = getAuthConfig();
  if (!cfg.enabled) return syntheticActor(req);
  const token = readCookie(req, DP_SESSION_COOKIE);
  const payload = await verifySessionToken(token, cfg.sessionSecret);
  if (!payload) return null;
  const user = await findUserById(payload.uid);
  if (!user || !user.isActive) return null;
  return user;
}

/** Requires an authenticated user (or synthetic admin when auth disabled). */
export async function requireDigitalProfileUser(req: Request): Promise<DpAuthUser> {
  const cfg = getAuthConfig();
  if (!cfg.enabled) return syntheticActor(req);
  assertAuthConfigSafe();
  const user = await getOptionalUser(req);
  if (!user) throw new UnauthorizedError();
  return user;
}

/** Throws 403 unless the user may perform the action. */
export function requireRole(user: DpAuthUser, action: DpAction): void {
  if (!can(user.role, action)) {
    throw new ForbiddenError(`Role ${user.role} may not perform ${action}`);
  }
}

/** Throws 403 unless the user has the required access level on the case. */
export async function requireCaseAccess(
  user: DpAuthUser,
  caseId: string,
  level: DpAccessLevel = "VIEWER"
): Promise<void> {
  const ok = await hasCaseAccess(user, caseId, level);
  if (!ok) throw new ForbiddenError("No access to this case");
}

/** Convenience: build the audit ActorContext for a resolved user. */
export function actorOf(user: DpAuthUser): ActorContext {
  return { actorId: user.id };
}
