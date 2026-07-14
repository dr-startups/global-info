/**
 * Pure helpers for safe canary / live preflight (no API).
 * Exact request-hash planning when queries are supplied; reuse-only when rerender-only.
 */

import {
  computePlanDigest,
  planArsenkinExactTasks,
  type PlannedExactRequest,
} from "./plan-arsenkin-exact-tasks";

export type ExistingProviderTask = {
  id?: string;
  toolName: string;
  requestHash: string;
  state: string;
  requestJson?: unknown;
  limitsSpent?: number | null;
};

export type PlannedTaskLine = {
  tool: string;
  region: string | null;
  engine: string | null;
  queries: string[];
  query: string | null;
  queryCount: number;
  requestHash: string;
  reuse: boolean;
  action: "REUSE" | "CREATE";
  existingTaskId: string | null;
  existingState: string | null;
  estimatedLimits: number | null;
};

export type PlannedTaskPreflight = {
  reportRunId: string;
  tools: string[];
  rerenderOnly: boolean;
  allowNewProviderTasks: boolean;
  existingDone: Array<{ toolName: string; requestHash: string; id?: string }>;
  existingIncomplete: Array<{ toolName: string; requestHash: string; state: string; id?: string }>;
  plannedHashes: string[];
  plannedLines: PlannedTaskLine[];
  plannedExactRequests?: PlannedExactRequest[];
  planDigest: string | null;
  plannedNewTasks: number;
  reusedTasks: number;
  wouldCreate: number;
  estimatedLimitsTotal: number | null;
  blocked: boolean;
  blockReason?: string;
};

const STAGE2 = new Set(["ai-serp", "check-h", "indexation"]);

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function parseTaskRequestMeta(
  toolName: string,
  requestJson: unknown
): {
  region: string | null;
  engine: string | null;
  queries: string[];
} {
  const body = asRecord(requestJson);
  const data = asRecord(body.data);
  const se = Number(data.se ?? body.se);
  let engine: string | null = null;
  if (toolName === "paa" || se === 2) engine = "GOOGLE";
  else if (se === 1) engine = "YANDEX";
  const googleFrom = String(data.google_from ?? "").toUpperCase();
  const domain = String(data.google_domain ?? "").toLowerCase();
  let region: string | null = "RU";
  if (googleFrom === "AE" || domain.includes(".ae")) region = "UAE";
  const q = data.queries ?? body.queries;
  const queries = Array.isArray(q) ? q.map(String) : [];
  return { region, engine, queries };
}

export function toolsFromExistingTasks(tasks: ExistingProviderTask[]): string[] {
  const tools = [...new Set(tasks.map((t) => t.toolName).filter(Boolean))];
  const stage1 = ["check-top", "suggest", "paa"].filter((t) => tools.includes(t));
  const stage2 = [...STAGE2].filter((t) => tools.includes(t));
  const rest = tools.filter((t) => !stage1.includes(t) && !stage2.includes(t));
  return [...stage1, ...stage2, ...rest];
}

export function buildPlannedTaskPreflight(input: {
  reportRunId: string;
  tasks: ExistingProviderTask[];
  requestedTools: string[] | null;
  rerenderOnly: boolean;
  allowNewProviderTasks: boolean;
  liveConfirm: boolean;
  /** When set, build exact request bodies and compare by hash (not tool name). */
  queriesRu?: string[];
  queriesUae?: string[];
  urlsEnrichment?: string[];
  /** Required for non-rerender live runs: must match computePlanDigest(planned). */
  confirmPlanDigest?: string | null;
}): PlannedTaskPreflight {
  const existingDone = input.tasks
    .filter((t) => /^DONE$/i.test(t.state))
    .map((t) => ({ toolName: t.toolName, requestHash: t.requestHash, id: t.id }));
  const existingIncomplete = input.tasks
    .filter((t) => !/^DONE$/i.test(t.state))
    .map((t) => ({ toolName: t.toolName, requestHash: t.requestHash, state: t.state, id: t.id }));

  const defaultTools = toolsFromExistingTasks(input.tasks.filter((t) => /^DONE$/i.test(t.state)));
  const tools =
    input.requestedTools && input.requestedTools.length > 0 ? input.requestedTools : defaultTools;

  const doneByHash = new Map(
    existingDone.map((t) => [t.requestHash, t] as const)
  );
  const taskByHash = new Map(input.tasks.map((t) => [t.requestHash, t] as const));

  const useExactPlan =
    Boolean(input.queriesRu?.length || input.queriesUae?.length) && !input.rerenderOnly;

  let plannedExactRequests: PlannedExactRequest[] | undefined;
  let plannedLines: PlannedTaskLine[] = [];
  let plannedHashes: string[] = [];
  let plannedNewTasks = 0;
  let planDigest: string | null = null;

  if (useExactPlan) {
    plannedExactRequests = planArsenkinExactTasks({
      queriesRu: input.queriesRu ?? [],
      queriesUae: input.queriesUae ?? [],
      tools,
      urlsEnrichment: input.urlsEnrichment,
    });
    planDigest = computePlanDigest(plannedExactRequests);
    plannedHashes = plannedExactRequests.map((p) => p.requestHash);
    plannedLines = plannedExactRequests.map((p) => {
      const existing = taskByHash.get(p.requestHash);
      const reuse = Boolean(existing && /^DONE$/i.test(existing.state));
      return {
        tool: p.tool,
        region: p.region,
        engine: p.engine,
        queries: p.query ? [p.query] : [],
        query: p.query,
        queryCount: p.queryCount,
        requestHash: p.requestHash,
        reuse,
        action: reuse ? ("REUSE" as const) : ("CREATE" as const),
        existingTaskId: existing?.id ?? null,
        existingState: existing?.state ?? null,
        estimatedLimits: reuse ? existing?.limitsSpent ?? p.estimatedLimits : p.estimatedLimits,
      };
    });
    plannedNewTasks = plannedLines.filter((l) => l.action === "CREATE").length;
  } else if (input.rerenderOnly) {
    // Rerender-only: reuse existing DONE tasks for selected tools (by hash of stored requests).
    const doneTasks = input.tasks.filter((t) => /^DONE$/i.test(t.state) && tools.includes(t.toolName));
    plannedHashes = doneTasks.map((t) => t.requestHash);
    plannedLines = doneTasks.map((t) => {
      const meta = parseTaskRequestMeta(t.toolName, t.requestJson);
      return {
        tool: t.toolName,
        region: meta.region,
        engine: meta.engine,
        queries: meta.queries,
        query: meta.queries[0] ?? null,
        queryCount: meta.queries.length,
        requestHash: t.requestHash,
        reuse: true,
        action: "REUSE" as const,
        existingTaskId: t.id ?? null,
        existingState: t.state,
        estimatedLimits: t.limitsSpent ?? null,
      };
    });
    // If caller explicitly requested tools not present in DONE set → would-create by tool gap
    // (no exact bodies without queries). Count missing tools as CREATE blockers for safety.
    if (input.requestedTools && input.requestedTools.length > 0) {
      const doneByTool = new Set(existingDone.map((t) => t.toolName));
      const missingTools = tools.filter((t) => !doneByTool.has(t));
      plannedNewTasks = missingTools.length;
      for (const tool of missingTools) {
        plannedLines.push({
          tool,
          region: null,
          engine: null,
          queries: [],
          query: null,
          queryCount: 0,
          requestHash: `missing-tool:${tool}`,
          reuse: false,
          action: "CREATE",
          existingTaskId: null,
          existingState: null,
          estimatedLimits: null,
        });
      }
    } else {
      plannedNewTasks = 0;
    }
    planDigest = computePlanDigest(plannedLines.filter((l) => l.action === "REUSE"));
  } else {
    // Live without queries: cannot build exact bodies — block rather than guess by tool name.
    plannedNewTasks = 0;
    plannedHashes = [];
    plannedLines = [];
    planDigest = null;
  }

  const reusedTasks = plannedLines.filter((l) => l.action === "REUSE").length;
  const wouldCreate = plannedNewTasks;

  const estimatedKnown = plannedLines
    .map((l) => l.estimatedLimits)
    .filter((v): v is number => v != null);
  const estimatedLimitsTotal = estimatedKnown.length
    ? estimatedKnown.reduce((a, b) => a + b, 0)
    : null;

  let blocked = false;
  let blockReason: string | undefined;

  if (!input.rerenderOnly && !useExactPlan) {
    blocked = true;
    blockReason = "exact live preflight requires queriesRu/queriesUae to build request bodies";
  }
  if (existingIncomplete.length > 0 && input.rerenderOnly) {
    blocked = true;
    blockReason = `incomplete provider tasks: ${existingIncomplete.map((t) => `${t.toolName}:${t.state}`).join(",")}`;
  }
  if (plannedNewTasks > 0) {
    if (input.rerenderOnly) {
      blocked = true;
      blockReason = `plannedNewTasks=${plannedNewTasks} (by requestHash); rerender-only forbids CREATE`;
    } else if (!(input.allowNewProviderTasks && input.liveConfirm)) {
      blocked = true;
      blockReason = `plannedNewTasks=${plannedNewTasks} (by requestHash); need --allow-new-provider-tasks and ARSENKIN_LIVE_CONFIRM=1`;
    } else if (!input.confirmPlanDigest) {
      blocked = true;
      blockReason =
        "non-rerender CREATE requires --confirm-plan-digest=<digest> matching canonical planned requests";
    } else if (planDigest && input.confirmPlanDigest !== planDigest) {
      blocked = true;
      blockReason = `plan digest mismatch: confirmed=${input.confirmPlanDigest} current=${planDigest}`;
    }
  }
  if (tools.length === 0) {
    blocked = true;
    blockReason = "no existing DONE provider tools for this reportRunId";
  }

  return {
    reportRunId: input.reportRunId,
    tools,
    rerenderOnly: input.rerenderOnly,
    allowNewProviderTasks: input.allowNewProviderTasks && input.liveConfirm,
    existingDone,
    existingIncomplete,
    plannedHashes,
    plannedLines,
    plannedExactRequests,
    planDigest,
    plannedNewTasks,
    reusedTasks,
    wouldCreate,
    estimatedLimitsTotal,
    blocked,
    blockReason,
  };
}

export function formatRerenderNetworkSummary(input: {
  reused: number;
  wouldCreate: number;
  created: number;
  networkCalls: number;
}): string {
  return `REUSED ${input.reused}, WOULD_CREATE ${input.wouldCreate}, CREATED ${input.created}, NETWORK_CALLS ${input.networkCalls}`;
}

export { computePlanDigest, planArsenkinExactTasks };
