/**
 * Production gate evaluation for canonical Arsenkin live runner (pure).
 */

import type { ArsenkinExecutionPlan } from "./arsenkin-execution-plan";
import { evaluateExecutionPlanBudget } from "./arsenkin-execution-plan";
import {
  validateFreshCanaryRun,
  type FreshCanaryCounts,
  type CanaryRunRow,
} from "./arsenkin-canary-run-lifecycle";
import {
  validateClientBindingArtifacts,
  type AdminReviewDecisionsArtifact,
  type ClientContentArtifact,
  type ClientContentBindingArtifact,
} from "./arsenkin-client-binding-gate";
import {
  validateDbReadinessArtifact,
  type ArsenkinDbReadinessArtifact,
} from "../../providers/arsenkin/arsenkin-db-readiness";
import type { ArsenkinSubjectQueryPlan } from "./arsenkin-subject-query-plan";

export type CanonicalLiveGateMode = "plan-only" | "execute-live" | "prepare";

export type EvaluateCanonicalLiveGateInput = {
  mode: CanonicalLiveGateMode;
  caseId: string;
  reportRunId: string;
  stage: string;
  run: CanaryRunRow | null;
  counts: FreshCanaryCounts;
  resumeExisting?: boolean;
  queryPlan: ArsenkinSubjectQueryPlan;
  executionPlan: ArsenkinExecutionPlan | null;
  content: ClientContentArtifact | null;
  binding: ClientContentBindingArtifact | null;
  adminDecisions: AdminReviewDecisionsArtifact | null;
  dbReadiness: ArsenkinDbReadinessArtifact | null;
  currentDbFingerprint: string;
  currentGitCommit: string;
  currentSchemaChecksum: string;
  liveConfirm: boolean;
  confirmPlanDigest: string | null;
  tokenPresent: boolean;
  networkCalls: number;
  nowIso?: string;
};

export type EvaluateCanonicalLiveGateResult = {
  ok: boolean;
  verdict: "PLAN_READY" | "PLAN_BLOCKED" | "EXECUTE_READY" | "EXECUTE_BLOCKED" | "PREPARE_READY" | "PREPARE_BLOCKED";
  blockers: string[];
};

export function evaluateCanonicalLiveGate(
  input: EvaluateCanonicalLiveGateInput
): EvaluateCanonicalLiveGateResult {
  const blockers: string[] = [];

  if (input.networkCalls !== 0) {
    blockers.push(`network-calls-nonzero:${input.networkCalls}`);
  }

  if (input.queryPlan.blockers.length) {
    blockers.push(...input.queryPlan.blockers.map((b) => `query:${b}`));
  }

  if (input.mode === "prepare") {
    if (input.run) {
      blockers.push("prepare-requires-absent-run");
    }
    const verdict = blockers.length === 0 ? "PREPARE_READY" : "PREPARE_BLOCKED";
    return { ok: blockers.length === 0, verdict, blockers };
  }

  const fresh = validateFreshCanaryRun({
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    run: input.run,
    counts: input.counts,
    resumeExisting: input.resumeExisting,
  });
  if (!fresh.ok) blockers.push(...fresh.blockers);

  const binding = validateClientBindingArtifacts({
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    content: input.content,
    binding: input.binding,
    adminDecisions: input.adminDecisions,
    requireAdminDecisions: true,
  });
  if (!binding.ok) blockers.push(...binding.blockers);

  const db = validateDbReadinessArtifact({
    artifact: input.dbReadiness,
    currentFingerprint: input.currentDbFingerprint,
    currentGitCommit: input.currentGitCommit,
    currentSchemaChecksum: input.currentSchemaChecksum,
    nowIso: input.nowIso,
  });
  if (!db.ok) blockers.push(...db.blockers);

  if (!input.executionPlan) {
    blockers.push("execution-plan-missing");
  } else {
    if (input.executionPlan.caseId !== input.caseId) {
      blockers.push("plan-caseId-mismatch");
    }
    if (input.executionPlan.reportRunId !== input.reportRunId) {
      blockers.push("plan-reportRunId-mismatch");
    }
    const budget = evaluateExecutionPlanBudget(input.executionPlan);
    if (!budget.ok) blockers.push(...budget.blockers);
  }

  if (input.mode === "plan-only") {
    const verdict = blockers.length === 0 ? "PLAN_READY" : "PLAN_BLOCKED";
    return { ok: blockers.length === 0, verdict, blockers };
  }

  // execute-live extras
  if (!input.liveConfirm) blockers.push("ARSENKIN_LIVE_CONFIRM!=1");
  if (!input.confirmPlanDigest) blockers.push("missing-confirm-plan-digest");
  if (
    input.executionPlan &&
    input.confirmPlanDigest &&
    input.confirmPlanDigest !== input.executionPlan.digest
  ) {
    blockers.push("confirm-plan-digest-mismatch");
  }
  if (!input.tokenPresent) blockers.push("ARSENKIN_API_TOKEN-missing");
  if (fresh.lifecycle === "DONE") blockers.push("execute-blocked-DONE");
  if (fresh.lifecycle === "FAILED") blockers.push("execute-blocked-FAILED");
  if (fresh.lifecycle === "RUNNING" && !input.resumeExisting) {
    blockers.push("execute-blocked-already-RUNNING");
  }

  const verdict = blockers.length === 0 ? "EXECUTE_READY" : "EXECUTE_BLOCKED";
  return { ok: blockers.length === 0, verdict, blockers };
}
