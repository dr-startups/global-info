/**
 * R10.10a — Fail-closed ORION Golden admin auth helpers.
 *
 * Production/staging-like environments never accept synthetic SUPER_ADMIN.
 * Local/dev may allow an explicit auth-disabled bypass with a warning.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  actorOf,
  getOptionalUser,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
  type DpAuthUser,
} from "@/modules/digital-profile/auth/guard";
import {
  assertAuthConfigSafe,
  getAuthConfig,
  isAuthEnabled,
  isDeployLikeEnvironment,
  isSyntheticAuthBypassAllowed,
} from "@/modules/digital-profile/auth/auth-config";
import { ForbiddenError, UnauthorizedError } from "@/modules/digital-profile/http/errors";
import { can } from "@/modules/digital-profile/auth/roles";

const LOGIN_PATH = "/admin/digital-profile/login";

/** Roles that may view ORION manual-review evidence (via evidence.viewRaw). */
export const ORION_ADMIN_VIEW_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "ANALYST",
  "REVIEWER",
] as const;

/** Roles that may submit decisions / regenerate (via risk.review). */
export const ORION_ADMIN_REVIEW_ROLES = ["SUPER_ADMIN", "ADMIN", "REVIEWER"] as const;

export type OrionAdminAccessKind = "view" | "review";

/**
 * Fail-closed policy for ORION admin surfaces.
 * Deploy-like + auth off → block. Synthetic bypass only when explicitly allowed.
 */
export function assertOrionAdminAuthPolicy(): void {
  const cfg = getAuthConfig();
  if (isDeployLikeEnvironment() && !cfg.enabled) {
    throw new UnauthorizedError(
      "DIGITAL_PROFILE_AUTH_ENABLED must be true in production/staging for ORION admin access"
    );
  }
  if (cfg.enabled) {
    assertAuthConfigSafe();
  }
}

export function assertNotSyntheticInDeployLike(user: DpAuthUser): void {
  if (user.synthetic && isDeployLikeEnvironment()) {
    throw new ForbiddenError("Synthetic SUPER_ADMIN is not allowed in production/staging");
  }
  if (user.synthetic && !isSyntheticAuthBypassAllowed()) {
    throw new ForbiddenError("Synthetic SUPER_ADMIN bypass is not enabled");
  }
}

function requestFromCookieHeader(cookieHeader: string): Request {
  return new Request("http://localhost/admin/digital-profile", {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

async function cookieHeaderFromNext(): Promise<string> {
  const store = await cookies();
  return store
    .getAll()
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join("; ");
}

export async function getCurrentOrionAdminUser(req?: Request): Promise<DpAuthUser | null> {
  assertOrionAdminAuthPolicy();
  const request = req ?? requestFromCookieHeader(await cookieHeaderFromNext());
  const user = await getOptionalUser(request);
  if (!user) return null;
  if (user.synthetic) {
    if (isDeployLikeEnvironment() || !isSyntheticAuthBypassAllowed()) return null;
  }
  return user;
}

export async function requireOrionAdminApiAccess(
  req: Request,
  caseId: string,
  kind: OrionAdminAccessKind = "view"
): Promise<DpAuthUser> {
  assertOrionAdminAuthPolicy();
  const user = await requireDigitalProfileUser(req);
  assertNotSyntheticInDeployLike(user);
  if (kind === "view") {
    requireRole(user, "evidence.viewRaw");
    await requireCaseAccess(user, caseId, "VIEWER");
  } else {
    requireRole(user, "risk.review");
    await requireCaseAccess(user, caseId, "REVIEWER");
  }
  return user;
}

export async function requireOrionAdminPageAccess(caseId: string): Promise<DpAuthUser> {
  assertOrionAdminAuthPolicy();
  const cookieHeader = await cookieHeaderFromNext();
  const req = requestFromCookieHeader(cookieHeader);
  const cfg = getAuthConfig();

  if (!cfg.enabled) {
    if (!isSyntheticAuthBypassAllowed()) {
      redirect(`${LOGIN_PATH}?next=${encodeURIComponent(`/admin/digital-profile/${caseId}/orion-golden/manual-review`)}`);
    }
  }

  let user: DpAuthUser;
  try {
    user = await requireDigitalProfileUser(req);
  } catch {
    redirect(
      `${LOGIN_PATH}?next=${encodeURIComponent(`/admin/digital-profile/${caseId}/orion-golden/manual-review`)}`
    );
  }

  try {
    assertNotSyntheticInDeployLike(user);
    requireRole(user, "evidence.viewRaw");
    await requireCaseAccess(user, caseId, "VIEWER");
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      redirect(
        `${LOGIN_PATH}?next=${encodeURIComponent(`/admin/digital-profile/${caseId}/orion-golden/manual-review`)}`
      );
    }
    throw err;
  }
  return user;
}

export function assertCanReviewEvidence(user: DpAuthUser): void {
  requireRole(user, "risk.review");
}

export function assertCanRegenerateClientContent(user: DpAuthUser): void {
  requireRole(user, "risk.review");
}

export function describeOrionAdminAuthState(): {
  authEnabled: boolean;
  deployLike: boolean;
  syntheticBypassAllowed: boolean;
  viewRoles: readonly string[];
  reviewRoles: readonly string[];
} {
  return {
    authEnabled: isAuthEnabled(),
    deployLike: isDeployLikeEnvironment(),
    syntheticBypassAllowed: isSyntheticAuthBypassAllowed(),
    viewRoles: ORION_ADMIN_VIEW_ROLES,
    reviewRoles: ORION_ADMIN_REVIEW_ROLES,
  };
}

export function userMayViewOrionAdmin(user: DpAuthUser): boolean {
  return can(user.role, "evidence.viewRaw");
}

export function userMayReviewOrionAdmin(user: DpAuthUser): boolean {
  return can(user.role, "risk.review");
}

export { actorOf };
