/**
 * File-based Arsenkin recovery decisions (no migration).
 * Also intended to be mirrored via recordAudit at call sites.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "./arsenkin-db-readiness";

export type ArsenkinRecoveryDecisionKind =
  | "LINK_EXISTING_TASK"
  | "CONFIRM_NOT_CREATED"
  | "RETRY_UNCONFIRMED_SUBMIT"
  | "RECONCILE_DONE_ZERO_OBS"
  | "CONTINUE_STAGE1";

export type ArsenkinRecoveryDecision = {
  id: string;
  kind: ArsenkinRecoveryDecisionKind;
  reportRunId: string;
  providerTaskId: string;
  requestHash: string;
  toolName: string;
  actorId: string;
  createdAt: string;
  reason?: string;
  evidenceNote?: string;
  externalTaskId?: string | null;
  /** For CONFIRM_NOT_CREATED: allows exactly one controlled /set retry. */
  allowsOneRetry?: boolean;
  retryUsed?: boolean;
  metadata?: Record<string, unknown>;
};

export type ArsenkinRecoveryDecisionSet = {
  version: "arsenkin-recovery-decisions-v1";
  caseId: string;
  reportRunId: string;
  updatedAt: string;
  decisions: ArsenkinRecoveryDecision[];
};

export function arsenkinRecoveryDecisionsPath(outRoot: string): string {
  return join(outRoot, "arsenkin-recovery-decisions.json");
}

export function loadArsenkinRecoveryDecisions(outRoot: string): ArsenkinRecoveryDecisionSet | null {
  const path = arsenkinRecoveryDecisionsPath(outRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ArsenkinRecoveryDecisionSet;
  } catch {
    return null;
  }
}

export function saveArsenkinRecoveryDecisions(
  outRoot: string,
  set: ArsenkinRecoveryDecisionSet
): void {
  mkdirSync(dirname(arsenkinRecoveryDecisionsPath(outRoot)), { recursive: true });
  writeJsonAtomic(arsenkinRecoveryDecisionsPath(outRoot), set);
}

export function appendArsenkinRecoveryDecision(
  outRoot: string,
  input: {
    caseId: string;
    reportRunId: string;
    decision: Omit<ArsenkinRecoveryDecision, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    };
  }
): ArsenkinRecoveryDecisionSet {
  const prev =
    loadArsenkinRecoveryDecisions(outRoot) ??
    ({
      version: "arsenkin-recovery-decisions-v1",
      caseId: input.caseId,
      reportRunId: input.reportRunId,
      updatedAt: new Date().toISOString(),
      decisions: [],
    } satisfies ArsenkinRecoveryDecisionSet);

  const decision: ArsenkinRecoveryDecision = {
    id: input.decision.id ?? `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: input.decision.createdAt ?? new Date().toISOString(),
    kind: input.decision.kind,
    reportRunId: input.decision.reportRunId,
    providerTaskId: input.decision.providerTaskId,
    requestHash: input.decision.requestHash,
    toolName: input.decision.toolName,
    actorId: input.decision.actorId,
    reason: input.decision.reason,
    evidenceNote: input.decision.evidenceNote,
    externalTaskId: input.decision.externalTaskId,
    allowsOneRetry: input.decision.allowsOneRetry,
    retryUsed: input.decision.retryUsed,
    metadata: input.decision.metadata,
  };

  const next: ArsenkinRecoveryDecisionSet = {
    ...prev,
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    updatedAt: new Date().toISOString(),
    decisions: [...prev.decisions, decision],
  };
  saveArsenkinRecoveryDecisions(outRoot, next);
  return next;
}

export function findConfirmNotCreatedDecision(
  set: ArsenkinRecoveryDecisionSet | null,
  providerTaskId: string
): ArsenkinRecoveryDecision | null {
  if (!set) return null;
  const matches = set.decisions.filter(
    (d) => d.kind === "CONFIRM_NOT_CREATED" && d.providerTaskId === providerTaskId
  );
  return matches.length ? matches[matches.length - 1]! : null;
}

export function markConfirmRetryUsed(
  outRoot: string,
  providerTaskId: string
): ArsenkinRecoveryDecisionSet | null {
  const set = loadArsenkinRecoveryDecisions(outRoot);
  if (!set) return null;
  let changed = false;
  const decisions = set.decisions.map((d) => {
    if (d.kind === "CONFIRM_NOT_CREATED" && d.providerTaskId === providerTaskId && d.allowsOneRetry && !d.retryUsed) {
      changed = true;
      return { ...d, retryUsed: true };
    }
    return d;
  });
  if (!changed) return set;
  const next = { ...set, updatedAt: new Date().toISOString(), decisions };
  saveArsenkinRecoveryDecisions(outRoot, next);
  return next;
}

export function hasOpenSubmitUnknownRetry(set: ArsenkinRecoveryDecisionSet | null, providerTaskId: string): boolean {
  const d = findConfirmNotCreatedDecision(set, providerTaskId);
  return Boolean(d?.allowsOneRetry && !d.retryUsed);
}
