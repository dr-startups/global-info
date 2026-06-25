/**
 * Audit log service for the Digital Profile module.
 *
 * Records every meaningful action against a case. `actorId` is nullable at the
 * call site (no auth yet); it falls back to "system" to satisfy the non-null
 * schema column. When auth lands, pass the real user id.
 */

import { prisma } from "@/server/prisma/client";
import type { Prisma } from "@prisma/client";

export type AuditAction =
  | "CASE_CREATED"
  | "CASE_VIEWED"
  | "CASE_UPDATED"
  | "CASE_SOFT_DELETED"
  // Stage C — manual evidence input
  | "SEARCH_QUERY_ADDED"
  | "SEARCH_RESULT_ADDED"
  | "SEARCH_RESULT_CLASSIFIED"
  | "SCREENSHOT_ADDED"
  | "SCREENSHOT_DOWNLOADED"
  | "SCREENSHOT_SOFT_DELETED"
  | "DATABASE_PROFILE_IMPORTED"
  | "WIKIPEDIA_CHECK_ADDED"
  | "RISK_FINDING_CREATED"
  | "RISK_FINDING_REVIEWED"
  // Stage D — report_json builder
  | "REPORT_GENERATED"
  | "REPORT_VIEWED"
  // Stage E — report renderer
  | "REPORT_RENDERED"
  | "REPORT_DOWNLOADED"
  // Stage G — mock agents & orchestration
  | "AGENT_RUN_STARTED"
  | "AGENT_RUN_SUCCEEDED"
  | "AGENT_RUN_FAILED"
  | "FULL_AUDIT_STARTED"
  | "FULL_AUDIT_COMPLETED"
  | "FULL_AUDIT_FAILED"
  // Stage H3 — search surfaces
  | "SEARCH_SURFACE_ADDED"
  | "SEARCH_SURFACE_BULK_ADDED"
  | "SEARCH_SURFACE_REVIEWED"
  | "SEARCH_SURFACE_SOFT_DELETED";

export interface RecordAuditInput {
  caseId?: string | null;
  action: AuditAction | string;
  /** Nullable until auth exists; stored as "system" when absent. */
  actorId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

const SYSTEM_ACTOR = "system";

/**
 * Persist an audit log entry. Optionally runs inside a transaction client so it
 * stays consistent with the action being audited.
 */
export async function recordAudit(
  input: RecordAuditInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<void> {
  await tx.auditLog.create({
    data: {
      caseId: input.caseId ?? null,
      action: input.action,
      actorId: input.actorId ?? SYSTEM_ACTOR,
      metadata: input.metadata ?? undefined,
    },
  });
}
