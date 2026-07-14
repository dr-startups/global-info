/**
 * Production gate evaluation for canonical Arsenkin live runner (pure).
 */

import type { ArsenkinExecutionPlan, ArsenkinLiveStage } from "./arsenkin-execution-plan";
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
import {
  assertStageAllowedOnRun,
  isIdempotentDoneReplay,
  type ArsenkinWorkflow,
} from "./arsenkin-stage-ledger";

export type CanonicalLiveGateMode = "plan-only" | "execute-live" | "prepare";

export type StageRowForGate = { stage: ArsenkinLiveStage; status: string };

export type EvaluateCanonicalLiveGateInput = {
  mode: CanonicalLiveGateMode;
  caseId: string;
  reportRunId: string;
  stage: ArsenkinLiveStage;
  workflow: ArsenkinWorkflow;
  run: CanaryRunRow | null;
  stageRows: StageRowForGate[];
  currentStageStatus: string | null;
  counts: FreshCanaryCounts;
  /** Hard-fail: not supported in P0.5 happy path. */
  resumeExisting?: boolean;
  queryPlan: ArsenkinSubjectQueryPlan;
  executionPlan: ArsenkinExecutionPlan | null;
  content: ClientContentArtifact | null;
  binding: ClientContentBindingArtifact | null;
  adminDecisions: AdminReviewDecisionsArtifact | null;
  dbReadiness: ArsenkinDbReadinessArtifact | null;
  currentDbFingerprint: string;
  currentBuildCommit: string;
  currentSourceTreeHash: string;
  currentSchemaContentHash: string;
  currentDirtyTree: boolean;
  liveConfirm: boolean;
  confirmPlanDigest: string | null;
  tokenPresent: boolean;
  networkCalls: number;
  nowIso?: string;
};

export type EvaluateCanonicalLiveGateResult = {
  ok: boolean;
  verdict:
    | "PLAN_READY"
    | "PLAN_BLOCKED"
    | "EXECUTE_READY"
    | "EXECUTE_BLOCKED"
    | "PREPARE_READY"
    | "PREPARE_BLOCKED"
    | "IDEMPOTENT_DONE";
  blockers: string[];
};

export function evaluateCanonicalLiveGate(
  input: EvaluateCanonicalLiveGateInput
): EvaluateCanonicalLiveGateResult {
  const blockers: string[] = [];

  if (input.networkCalls !== 0) {
    blockers.push(`network-calls-nonzero:${input.networkCalls}`);
  }
  if (input.resumeExisting) {
    blockers.push("resume-existing-not-supported");
  }
  if (input.queryPlan.blockers.length) {
    blockers.push(...input.queryPlan.blockers.map((b) => `query:${b}`));
  }
  if (input.workflow === "suggest-canary" && input.stage !== "SUGGEST_RU_CANARY") {
    blockers.push("workflow-stage-mismatch");
  }
  if (input.workflow === "first36-full" && input.stage === "SUGGEST_RU_CANARY") {
    blockers.push("workflow-stage-mismatch");
  }

  if (input.mode === "prepare") {
    const isFirst =
      input.stage === "SUGGEST_RU_CANARY" || input.stage === "FIRST36_STAGE1";
    if (isFirst) {
      if (input.run) blockers.push("prepare-requires-absent-run");
    } else {
      // Stage 2 prepare
      if (!input.run) blockers.push("stage2-prepare-requires-existing-run");
      const stageGate = assertStageAllowedOnRun({
        workflow: input.workflow,
        stage: input.stage,
        stages: input.stageRows,
      });
      if (!stageGate.ok) blockers.push(...stageGate.blockers);
    }
    const verdict = blockers.length === 0 ? "PREPARE_READY" : "PREPARE_BLOCKED";
    return { ok: blockers.length === 0, verdict, blockers };
  }

  // Fresh empty counts required for first stage only
  const isFirstStage =
    input.stage === "SUGGEST_RU_CANARY" || input.stage === "FIRST36_STAGE1";
  if (isFirstStage) {
    const fresh = validateFreshCanaryRun({
      caseId: input.caseId,
      reportRunId: input.reportRunId,
      run: input.run,
      counts: input.counts,
      resumeExisting: false,
    });
    // Allow run status RUNNING if stage ledger is mid-workflow — but first stage shouldn't
    if (!fresh.ok) {
      // If run is RUNNING because we incorrectly validated — for first stage still require PREPARED
      blockers.push(...fresh.blockers);
    }
  } else {
    if (!input.run) blockers.push("run-absent");
    else if (input.run.caseId !== input.caseId) blockers.push("run-caseId-mismatch");
    const stageGate = assertStageAllowedOnRun({
      workflow: input.workflow,
      stage: input.stage,
      stages: input.stageRows,
    });
    if (!stageGate.ok) blockers.push(...stageGate.blockers);
  }

  if (input.currentStageStatus && isIdempotentDoneReplay(input.currentStageStatus)) {
    if (input.mode === "execute-live") {
      return { ok: true, verdict: "IDEMPOTENT_DONE", blockers: [] };
    }
  }

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
    currentBuildCommit: input.currentBuildCommit,
    currentSourceTreeHash: input.currentSourceTreeHash,
    currentSchemaContentHash: input.currentSchemaContentHash,
    currentDirtyTree: input.currentDirtyTree,
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
    if (input.executionPlan.stage !== input.stage) {
      blockers.push("plan-stage-mismatch");
    }
    const budget = evaluateExecutionPlanBudget(input.executionPlan);
    if (!budget.ok) blockers.push(...budget.blockers);
  }

  if (input.mode === "plan-only") {
    const verdict = blockers.length === 0 ? "PLAN_READY" : "PLAN_BLOCKED";
    return { ok: blockers.length === 0, verdict, blockers };
  }

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
  if (input.currentStageStatus && /^FAILED$/i.test(input.currentStageStatus)) {
    blockers.push("stage-FAILED-requires-explicit-retry-contract");
  }
  if (input.currentStageStatus && /^RUNNING$/i.test(input.currentStageStatus)) {
    blockers.push("stage-already-RUNNING");
  }

  const verdict = blockers.length === 0 ? "EXECUTE_READY" : "EXECUTE_BLOCKED";
  return { ok: blockers.length === 0, verdict, blockers };
}
