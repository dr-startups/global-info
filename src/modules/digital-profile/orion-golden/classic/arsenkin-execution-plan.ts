/**
 * Immutable Arsenkin execution plan builder (no network).
 * One builder for plan-only and execute-live; digest is recomputed before spend.
 */

import { createHash } from "node:crypto";
import type { ArsenkinToolName } from "../../providers/arsenkin/flags";
import {
  planArsenkinExactTasks,
  type PlannedExactRequest,
} from "./plan-arsenkin-exact-tasks";
import { hashProviderRequest } from "../../providers/arsenkin/provider-task-store";

export type ArsenkinLiveStage = "SUGGEST_RU_CANARY" | "FIRST36_STAGE1" | "FIRST36_STAGE2";

export type ArsenkinExecutionRequest = {
  tool: ArsenkinToolName;
  engine: string | null;
  region: string | null;
  query: string | null;
  requestJson: { tools_name: string; data: Record<string, unknown> };
  requestHash: string;
  action: "REUSE" | "CREATE";
  existingTaskId: string | null;
  estimatedLimits: number | null;
};

export type ArsenkinExecutionPlan = {
  version: "arsenkin-execution-plan-v1";
  caseId: string;
  reportRunId: string;
  stage: ArsenkinLiveStage;
  queriesRu: string[];
  queriesUae: string[];
  regions: Array<"RU" | "UAE">;
  tools: ArsenkinToolName[];
  aiSerpTargets: Array<"yandex_ru" | "google_ru" | "google_uae">;
  urlsEnrichment: string[];
  requests: ArsenkinExecutionRequest[];
  plannedNewTasks: number;
  estimatedLimitsTotal: number | null;
  maxNewTasks: number;
  maxEstimatedLimits: number;
  digest: string;
  allowUnknownCost: boolean;
};

export type ExistingProviderTaskHint = {
  id: string;
  requestHash: string;
  state: string;
};

export type BuildArsenkinExecutionPlanInput = {
  caseId: string;
  reportRunId: string;
  stage: ArsenkinLiveStage;
  queriesRu: string[];
  queriesUae: string[];
  maxNewTasks: number;
  maxEstimatedLimits: number;
  /** Existing DONE tasks for this reportRunId (order must not affect digest). */
  existingTasks?: ExistingProviderTaskHint[];
  urlsEnrichment?: string[];
  aiSerpTargets?: Array<"yandex_ru" | "google_ru" | "google_uae">;
  allowUnknownCost?: boolean;
};

const STAGE_TOOLS: Record<ArsenkinLiveStage, ArsenkinToolName[]> = {
  SUGGEST_RU_CANARY: ["suggest"],
  FIRST36_STAGE1: ["check-top", "suggest", "paa"],
  FIRST36_STAGE2: ["ai-serp", "check-h", "indexation"],
};

const STAGE_DEFAULT_MAX: Record<ArsenkinLiveStage, { maxNewTasks: number; maxEstimatedLimits: number }> = {
  SUGGEST_RU_CANARY: { maxNewTasks: 2, maxEstimatedLimits: 2 },
  FIRST36_STAGE1: { maxNewTasks: 20, maxEstimatedLimits: 20 },
  FIRST36_STAGE2: { maxNewTasks: 10, maxEstimatedLimits: 10 },
};

function stageQueries(input: BuildArsenkinExecutionPlanInput): {
  queriesRu: string[];
  queriesUae: string[];
  regions: Array<"RU" | "UAE">;
  aiSerpTargets: Array<"yandex_ru" | "google_ru" | "google_uae">;
  urlsEnrichment: string[];
} {
  if (input.stage === "SUGGEST_RU_CANARY") {
    return {
      queriesRu: input.queriesRu.slice(0, 1),
      queriesUae: [],
      regions: ["RU"],
      aiSerpTargets: [],
      urlsEnrichment: [],
    };
  }
  if (input.stage === "FIRST36_STAGE1") {
    return {
      queriesRu: input.queriesRu,
      queriesUae: input.queriesUae,
      regions: input.queriesUae.length > 0 ? ["RU", "UAE"] : ["RU"],
      aiSerpTargets: [],
      urlsEnrichment: [],
    };
  }
  return {
    queriesRu: input.queriesRu,
    queriesUae: input.queriesUae,
    regions: input.queriesUae.length > 0 ? ["RU", "UAE"] : ["RU"],
    aiSerpTargets: input.aiSerpTargets ?? ["yandex_ru", "google_ru", "google_uae"],
    urlsEnrichment: input.urlsEnrichment ?? [],
  };
}

function toExecutionRequest(
  planned: PlannedExactRequest,
  existingByHash: Map<string, ExistingProviderTaskHint>
): ArsenkinExecutionRequest {
  const existing = existingByHash.get(planned.requestHash);
  const reusable = existing && /^DONE$/i.test(existing.state);
  return {
    tool: planned.tool as ArsenkinToolName,
    engine: planned.engine,
    region: planned.region,
    query: planned.query,
    requestJson: planned.requestJson,
    requestHash: planned.requestHash,
    action: reusable ? "REUSE" : "CREATE",
    existingTaskId: reusable ? existing!.id : null,
    estimatedLimits: planned.estimatedLimits,
  };
}

/** Stable digest: reportRunId + stage + sorted request hashes + budget caps (no timestamps). */
export function computeExecutionPlanDigest(input: {
  reportRunId: string;
  stage: ArsenkinLiveStage;
  requestHashes: readonly string[];
  maxNewTasks: number;
  maxEstimatedLimits: number;
  queriesRu: readonly string[];
  queriesUae: readonly string[];
  urlsEnrichment: readonly string[];
  aiSerpTargets: readonly string[];
}): string {
  const payload = {
    version: "arsenkin-execution-plan-v1",
    reportRunId: input.reportRunId,
    stage: input.stage,
    queriesRu: [...input.queriesRu],
    queriesUae: [...input.queriesUae],
    urlsEnrichment: [...input.urlsEnrichment],
    aiSerpTargets: [...input.aiSerpTargets].sort(),
    requestHashes: [...input.requestHashes].sort(),
    maxNewTasks: input.maxNewTasks,
    maxEstimatedLimits: input.maxEstimatedLimits,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function evaluateExecutionPlanBudget(plan: ArsenkinExecutionPlan): {
  ok: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  if (plan.plannedNewTasks > plan.maxNewTasks) {
    blockers.push(`plannedNewTasks=${plan.plannedNewTasks}>maxNewTasks=${plan.maxNewTasks}`);
  }
  if (plan.estimatedLimitsTotal == null && !plan.allowUnknownCost) {
    blockers.push("unknown-estimated-limits-total");
  }
  if (
    plan.estimatedLimitsTotal != null &&
    plan.estimatedLimitsTotal > plan.maxEstimatedLimits
  ) {
    blockers.push(
      `estimatedLimitsTotal=${plan.estimatedLimitsTotal}>maxEstimatedLimits=${plan.maxEstimatedLimits}`
    );
  }
  if (plan.requests.some((r) => r.estimatedLimits == null) && !plan.allowUnknownCost) {
    blockers.push("unknown-request-cost");
  }
  return { ok: blockers.length === 0, blockers };
}

export function buildArsenkinExecutionPlan(
  input: BuildArsenkinExecutionPlanInput
): ArsenkinExecutionPlan {
  const tools = STAGE_TOOLS[input.stage];
  const scoped = stageQueries(input);
  const defaults = STAGE_DEFAULT_MAX[input.stage];
  const maxNewTasks = input.maxNewTasks > 0 ? input.maxNewTasks : defaults.maxNewTasks;
  const maxEstimatedLimits =
    input.maxEstimatedLimits > 0 ? input.maxEstimatedLimits : defaults.maxEstimatedLimits;

  const planned = planArsenkinExactTasks({
    queriesRu: scoped.queriesRu,
    queriesUae: scoped.queriesUae,
    tools,
    urlsEnrichment: scoped.urlsEnrichment,
    aiSerpTargets: scoped.aiSerpTargets.length ? scoped.aiSerpTargets : undefined,
  });

  const existingByHash = new Map<string, ExistingProviderTaskHint>();
  for (const t of input.existingTasks ?? []) {
    // First DONE wins; digest ignores map insertion order via sorted hashes.
    if (!existingByHash.has(t.requestHash)) {
      existingByHash.set(t.requestHash, t);
    }
  }

  const requests = planned
    .map((p) => toExecutionRequest(p, existingByHash))
    .sort((a, b) => a.requestHash.localeCompare(b.requestHash));

  const plannedNewTasks = requests.filter((r) => r.action === "CREATE").length;
  const limitValues = requests.map((r) => r.estimatedLimits);
  const estimatedLimitsTotal = limitValues.every((v) => v != null)
    ? limitValues.reduce((a, b) => a + (b as number), 0)
    : null;

  const digest = computeExecutionPlanDigest({
    reportRunId: input.reportRunId,
    stage: input.stage,
    requestHashes: requests.map((r) => r.requestHash),
    maxNewTasks,
    maxEstimatedLimits,
    queriesRu: scoped.queriesRu,
    queriesUae: scoped.queriesUae,
    urlsEnrichment: scoped.urlsEnrichment,
    aiSerpTargets: scoped.aiSerpTargets,
  });

  return {
    version: "arsenkin-execution-plan-v1",
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    stage: input.stage,
    queriesRu: scoped.queriesRu,
    queriesUae: scoped.queriesUae,
    regions: scoped.regions,
    tools,
    aiSerpTargets: scoped.aiSerpTargets,
    urlsEnrichment: scoped.urlsEnrichment,
    requests,
    plannedNewTasks,
    estimatedLimitsTotal,
    maxNewTasks,
    maxEstimatedLimits,
    digest,
    allowUnknownCost: Boolean(input.allowUnknownCost),
  };
}

export function assertPlanRequestHashesMatchBodies(plan: ArsenkinExecutionPlan): void {
  for (const r of plan.requests) {
    const h = hashProviderRequest(r.requestJson);
    if (h !== r.requestHash) {
      throw new Error(`plan-request-hash-drift:${r.tool}:${r.requestHash}!=${h}`);
    }
  }
}

export { STAGE_TOOLS, STAGE_DEFAULT_MAX };
