/**
 * Roles, actions and the permission matrix for the Digital Profile module
 * (Stage M1). This file is intentionally PURE (no Node/Prisma/server imports) so
 * it can be shared by both server guards and client UI gating.
 *
 * Roles mirror the Prisma `DpRole` enum. SUPER_ADMIN implicitly has every
 * permission. Raw evidence and internal-only data are never exposed to
 * CLIENT_VIEWER.
 */

export const DP_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "ANALYST",
  "REVIEWER",
  "CLIENT_VIEWER",
] as const;

export type DpRole = (typeof DP_ROLES)[number];

export const DP_ACCESS_LEVELS = ["OWNER", "EDITOR", "REVIEWER", "VIEWER"] as const;
export type DpAccessLevel = (typeof DP_ACCESS_LEVELS)[number];

/**
 * Every guarded capability in the module. Keep this list the single source of
 * truth; routes and UI reference these action keys rather than role lists.
 */
export type DpAction =
  | "case.list"
  | "case.view"
  | "case.create"
  | "case.update"
  | "case.delete"
  | "evidence.create"
  | "evidence.viewRaw"
  | "agents.run"
  | "agents.runReal"
  | "risk.classify"
  | "risk.review"
  | "report.generateInternal"
  | "report.generateClient"
  | "report.downloadInternal"
  | "report.downloadClient"
  | "users.manage"
  | "auditLogs.view";

/**
 * Action -> roles allowed. SUPER_ADMIN is granted everything implicitly in
 * `can()` and is therefore omitted from these lists for brevity.
 */
const PERMISSIONS: Record<DpAction, DpRole[]> = {
  "case.list": ["ADMIN", "ANALYST", "REVIEWER", "CLIENT_VIEWER"],
  "case.view": ["ADMIN", "ANALYST", "REVIEWER", "CLIENT_VIEWER"],
  "case.create": ["ADMIN", "ANALYST"],
  "case.update": ["ADMIN", "ANALYST"],
  "case.delete": ["ADMIN"],
  "evidence.create": ["ADMIN", "ANALYST"],
  "evidence.viewRaw": ["ADMIN", "ANALYST", "REVIEWER"],
  "agents.run": ["ADMIN", "ANALYST"],
  "agents.runReal": ["ADMIN"],
  "risk.classify": ["ADMIN", "ANALYST"],
  "risk.review": ["ADMIN", "REVIEWER"],
  "report.generateInternal": ["ADMIN", "ANALYST", "REVIEWER"],
  "report.generateClient": ["ADMIN", "REVIEWER"],
  "report.downloadInternal": ["ADMIN", "ANALYST", "REVIEWER"],
  "report.downloadClient": ["ADMIN", "REVIEWER", "CLIENT_VIEWER"],
  "users.manage": [],
  "auditLogs.view": [],
};

/** True if the role may perform the action. SUPER_ADMIN can do everything. */
export function can(role: DpRole, action: DpAction): boolean {
  if (role === "SUPER_ADMIN") return true;
  return PERMISSIONS[action]?.includes(role) ?? false;
}

/** Staff (internal) roles see all cases globally; CLIENT_VIEWER is case-scoped. */
export function isStaffRole(role: DpRole): boolean {
  return role !== "CLIENT_VIEWER";
}

/** Roles allowed to see soft-deleted cases / includeDeleted listings. */
export function canSeeDeletedCases(role: DpRole): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN";
}

export function isValidRole(value: unknown): value is DpRole {
  return typeof value === "string" && (DP_ROLES as readonly string[]).includes(value);
}
