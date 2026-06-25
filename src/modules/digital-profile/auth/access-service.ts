/**
 * Per-case access resolution (Stage M1).
 *
 * Staff roles (SUPER_ADMIN/ADMIN/ANALYST/REVIEWER) have global case access.
 * CLIENT_VIEWER is restricted to cases explicitly granted via dp_case_access.
 *
 * The pure helpers (`resolveCaseAccess`, `accessLevelSatisfies`) are unit-tested
 * by smoke:auth without touching the database.
 */

import { prisma } from "@/server/prisma/client";
import type { AuthUser } from "./user-service";
import type { DpAccessLevel } from "./roles";
import { isStaffRole } from "./roles";
import {
  accessLevelSatisfies,
  resolveCaseAccess,
} from "./access-rules";

export {
  accessLevelSatisfies,
  resolveCaseAccess,
  type ResolvedAccess,
} from "./access-rules";

async function grantLevelFor(
  userId: string,
  caseId: string
): Promise<DpAccessLevel | null> {
  const row = await prisma.dpCaseAccess.findUnique({
    where: { caseId_userId: { caseId, userId } },
  });
  return row ? (row.accessLevel as DpAccessLevel) : null;
}

/** Whether the user can access the case at the required level (DB-backed). */
export async function hasCaseAccess(
  user: AuthUser,
  caseId: string,
  required: DpAccessLevel = "VIEWER"
): Promise<boolean> {
  if (isStaffRole(user.role)) return true;
  const grant = await grantLevelFor(user.id, caseId);
  const resolved = resolveCaseAccess(user.role, grant);
  return resolved.canView && accessLevelSatisfies(resolved.level, required);
}

/**
 * Case ids a user may see. Returns null for staff (meaning "all cases"), or an
 * explicit id list for CLIENT_VIEWER (possibly empty).
 */
export async function accessibleCaseIds(
  user: AuthUser
): Promise<string[] | null> {
  if (isStaffRole(user.role)) return null;
  const rows = await prisma.dpCaseAccess.findMany({
    where: { userId: user.id },
    select: { caseId: true },
  });
  return rows.map((r) => r.caseId);
}
