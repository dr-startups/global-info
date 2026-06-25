/**
 * Pure case-access rules (Stage M1) — no Prisma/Node imports, so they can be
 * unit-tested by smoke:auth and reused by the DB-backed access-service.
 */

import type { DpAccessLevel, DpRole } from "./roles";
import { isStaffRole } from "./roles";

const LEVEL_RANK: Record<DpAccessLevel, number> = {
  VIEWER: 1,
  REVIEWER: 2,
  EDITOR: 3,
  OWNER: 4,
};

/** True if `have` access level meets/exceeds `required`. */
export function accessLevelSatisfies(
  have: DpAccessLevel | null,
  required: DpAccessLevel
): boolean {
  if (!have) return false;
  return LEVEL_RANK[have] >= LEVEL_RANK[required];
}

export interface ResolvedAccess {
  canView: boolean;
  /** Effective level: staff are treated as OWNER; client viewers use their grant. */
  level: DpAccessLevel | null;
}

/**
 * Pure resolution given a role and the user's grant (if any) for one case.
 * `grantLevel` is the dp_case_access.accessLevel or null when no grant exists.
 */
export function resolveCaseAccess(
  role: DpRole,
  grantLevel: DpAccessLevel | null
): ResolvedAccess {
  if (isStaffRole(role)) {
    return { canView: true, level: "OWNER" };
  }
  if (grantLevel) return { canView: true, level: grantLevel };
  return { canView: false, level: null };
}
