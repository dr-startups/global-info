/**
 * Run-scoped Arsenkin stage ledger (pure rules + CAS helpers).
 * Full First36: FIRST36_STAGE1 + FIRST36_STAGE2 on one reportRunId.
 */

import type { ArsenkinLiveStage } from "./arsenkin-execution-plan";

export type ArsenkinStageStatus = "PREPARED" | "RUNNING" | "DONE" | "FAILED";
export type ArsenkinWorkflow = "suggest-canary" | "first36-full";

export type StageLedgerRow = {
  id: string;
  reportRunId: string;
  caseId: string;
  stage: ArsenkinLiveStage;
  status: string;
  planDigest: string | null;
  leaseOwnerId: string | null;
  maxNewTasks?: number | null;
  maxEstimatedLimits?: number | null;
};

export function requiredStagesForWorkflow(workflow: ArsenkinWorkflow): ArsenkinLiveStage[] {
  if (workflow === "suggest-canary") return ["SUGGEST_RU_CANARY"];
  return ["FIRST36_STAGE1", "FIRST36_STAGE2"];
}

export function workflowForStage(stage: ArsenkinLiveStage): ArsenkinWorkflow {
  if (stage === "SUGGEST_RU_CANARY") return "suggest-canary";
  return "first36-full";
}

export function parseWorkflow(raw: string | null | undefined): ArsenkinWorkflow {
  const s = String(raw ?? "").trim();
  if (s === "suggest-canary" || s === "first36-full") return s;
  throw new Error(`invalid-workflow:${s || "empty"}`);
}

export type StageTransitionInput = {
  from: ArsenkinStageStatus;
  to: ArsenkinStageStatus;
  currentStatus: string;
  leaseOwnerId: string | null;
  expectedOwnerId: string | null;
};

export function transitionStageStatus(input: StageTransitionInput): {
  ok: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  const cur = String(input.currentStatus ?? "").toUpperCase();
  if (cur !== input.from) {
    blockers.push(`stage-status-mismatch:expected=${input.from}:got=${cur || "null"}`);
  }
  const allowed: Record<ArsenkinStageStatus, ArsenkinStageStatus[]> = {
    PREPARED: ["RUNNING", "FAILED"],
    RUNNING: ["DONE", "FAILED"],
    DONE: [],
    FAILED: [],
  };
  if (!(allowed[input.from] ?? []).includes(input.to)) {
    blockers.push(`illegal-stage-transition:${input.from}->${input.to}`);
  }
  if (input.from === "RUNNING" && input.to !== "RUNNING") {
    if (!input.expectedOwnerId || input.leaseOwnerId !== input.expectedOwnerId) {
      blockers.push("stage-lease-owner-mismatch");
    }
  }
  if (input.to === "RUNNING" && input.leaseOwnerId && input.expectedOwnerId) {
    if (input.leaseOwnerId !== input.expectedOwnerId) {
      blockers.push("stage-lease-owner-mismatch");
    }
  }
  return { ok: blockers.length === 0, blockers };
}

export function aggregateRunStatus(input: {
  workflow: ArsenkinWorkflow;
  stages: Array<{ stage: ArsenkinLiveStage; status: string }>;
}): "PREPARED" | "RUNNING" | "DONE" | "FAILED" {
  const required = requiredStagesForWorkflow(input.workflow);
  const byStage = new Map(input.stages.map((s) => [s.stage, String(s.status).toUpperCase()]));
  for (const st of required) {
    if (!byStage.has(st)) return "PREPARED";
  }
  if ([...byStage.values()].some((s) => s === "FAILED")) return "FAILED";
  if (required.every((st) => byStage.get(st) === "DONE")) return "DONE";
  if ([...byStage.values()].some((s) => s === "RUNNING")) return "RUNNING";
  if ([...byStage.values()].some((s) => s === "DONE" || s === "PREPARED")) {
    // Partial progress: keep run RUNNING once work started, else PREPARED
    if ([...byStage.values()].some((s) => s === "DONE" || s === "RUNNING")) return "RUNNING";
  }
  return "PREPARED";
}

export function assertStageAllowedOnRun(input: {
  workflow: ArsenkinWorkflow;
  stage: ArsenkinLiveStage;
  stages: Array<{ stage: ArsenkinLiveStage; status: string }>;
}): { ok: boolean; blockers: string[] } {
  const blockers: string[] = [];
  const required = requiredStagesForWorkflow(input.workflow);
  if (!required.includes(input.stage)) {
    blockers.push(`stage-not-in-workflow:${input.stage}`);
  }
  if (input.stage === "FIRST36_STAGE2") {
    const s1 = input.stages.find((s) => s.stage === "FIRST36_STAGE1");
    if (!s1 || String(s1.status).toUpperCase() !== "DONE") {
      blockers.push("stage2-requires-stage1-DONE");
    }
  }
  const self = input.stages.find((s) => s.stage === input.stage);
  if (self && String(self.status).toUpperCase() === "FAILED") {
    blockers.push("stage-FAILED-requires-explicit-retry-contract");
  }
  return { ok: blockers.length === 0, blockers };
}

/** Idempotent DONE stage re-execute: allow with zero new network when already DONE. */
export function isIdempotentDoneReplay(status: string): boolean {
  return String(status).toUpperCase() === "DONE";
}
