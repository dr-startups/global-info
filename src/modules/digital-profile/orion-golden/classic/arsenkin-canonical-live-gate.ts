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
  assertStage2PrepareAllowed,
  assertStageAllowedOnRun,
  isIdempotentDoneReplay,
  requiredStagesForWorkflow,
  workflowFromRunMetadata,
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
    | "IDEMPOTENT_DONE"
    | "IDEMPOTENT_REPLAY_DONE";
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
      if (input.currentStageStatus) {
        const st = String(input.currentStageStatus).toUpperCase();
        if (st === "PREPARED") {
          // idempotent prepare reuse handled by caller
        } else if (st) {
          blockers.push(`prepare-stage-conflict:${st}`);
        }
      }
    } else {
      const s2 = assertStage2PrepareAllowed({
        caseId: input.caseId,
        workflow: input.workflow,
        run: input.run
          ? {
              id: input.run.id,
              caseId: input.run.caseId,
              status: input.run.status,
              metadataJson: (input.run as { metadataJson?: unknown }).metadataJson,
            }
          : null,
        stages: input.stageRows,
        existingStageStatus: input.currentStageStatus,
      });
      if (!s2.ok) blockers.push(...s2.blockers);
    }
    const verdict = blockers.length === 0 ? "PREPARE_READY" : "PREPARE_BLOCKED";
    return { ok: blockers.length === 0, verdict, blockers };
  }

  // Fresh empty counts required for first stage only — skipped for DONE replay (no-op).
  const isReplayDone =
    Boolean(input.currentStageStatus) && isIdempotentDoneReplay(input.currentStageStatus!);
  const isFirstStage =
    input.stage === "SUGGEST_RU_CANARY" || input.stage === "FIRST36_STAGE1";

  if (isReplayDone && (input.mode === "execute-live" || input.mode === "plan-only")) {
    // Identity/integrity only — may not clear network/resume/query/workflow blockers above.
    if (!input.run) {
      blockers.push("run-absent");
    } else {
      if (input.run.caseId !== input.caseId) blockers.push("run-caseId-mismatch");
      if (input.run.id !== input.reportRunId) blockers.push("run-id-mismatch");
      const stored = workflowFromRunMetadata(input.run.metadataJson);
      if (!stored) {
        blockers.push("run-workflow-missing");
      } else if (stored !== input.workflow) {
        blockers.push(`workflow-mismatch:${stored}`);
      }
    }
    const required = requiredStagesForWorkflow(input.workflow);
    if (!required.includes(input.stage)) {
      blockers.push(`stage-not-in-workflow:${input.stage}`);
    }
    const self = input.stageRows.find((s) => s.stage === input.stage);
    if (!self) {
      blockers.push("idempotent-replay-stage-row-absent");
    } else if (String(self.status).toUpperCase() !== "DONE") {
      blockers.push(`idempotent-replay-stage-not-DONE:${self.status}`);
    }
    if (blockers.length > 0) {
      const verdict = input.mode === "plan-only" ? "PLAN_BLOCKED" : "EXECUTE_BLOCKED";
      return { ok: false, verdict, blockers };
    }
    return { ok: true, verdict: "IDEMPOTENT_REPLAY_DONE", blockers: [] };
  }

  if (isFirstStage) {
    const fresh = validateFreshCanaryRun({
      caseId: input.caseId,
      reportRunId: input.reportRunId,
      run: input.run,
      counts: input.counts,
      resumeExisting: false,
    });
    if (!fresh.ok) {
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
