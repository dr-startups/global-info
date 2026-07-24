/**
 * Remap stale unified enrichmentRunIds to sibling CaseAgent runs that already
 * have reusable Arsenkin ProviderTasks (DONE / externalTaskId).
 *
 * Same failure mode as Suggestions: unified poll timed out on empty runs while
 * manual CaseAgent runs later completed. Ingest resume must REPLACE the stale
 * id (tick uses enrichmentRunIds.find per agent — first match wins).
 */

import { ARSENKIN_REAL_AGENT_NAMES } from "../agents/real/real-arsenkin-agents";
import type { UnifiedCollectionJob } from "./unified-collection-types";

export type SiblingRemapTaskRow = {
  id: string;
  state: string;
  toolName: string | null;
  externalTaskId: string | null;
  responseJson?: unknown;
  reportRunId?: string | null;
};

export type SiblingRemapDeps = {
  listProviderTasksForRuns?: (runIds: string[]) => Promise<SiblingRemapTaskRow[]>;
  listCaseArsenkinTasks?: (caseId: string) => Promise<SiblingRemapTaskRow[]>;
};

export type SiblingRemapEntry = {
  agentName: string;
  fromRunId: string;
  toRunId: string;
};

export type SiblingRemapResult = {
  enrichmentRunIds: string[];
  arsenkinEnrichmentState: UnifiedCollectionJob["arsenkinEnrichmentState"];
  remaps: SiblingRemapEntry[];
  changed: boolean;
};

const AGENT_RUN_RE: Record<string, RegExp> = {
  ARSENKIN_SEARCH_TOP_REAL: /search-top/i,
  ARSENKIN_SUGGESTIONS_REAL: /suggestions/i,
  ARSENKIN_PAA_REAL: /(?:^|-)paa(?:-|$)|paa-real/i,
  ARSENKIN_AI_SEARCH_REAL: /ai-search/i,
  ARSENKIN_URL_AUDIT_REAL: /url-audit/i,
};

const AGENT_TOOL_RE: Record<string, RegExp> = {
  ARSENKIN_SEARCH_TOP_REAL: /check-top/i,
  ARSENKIN_SUGGESTIONS_REAL: /suggest/i,
  ARSENKIN_PAA_REAL: /^paa$/i,
  ARSENKIN_AI_SEARCH_REAL: /ai-serp/i,
  ARSENKIN_URL_AUDIT_REAL: /check-h|indexation/i,
};

function isIngestibleResponse(responseJson: unknown): boolean {
  if (responseJson == null || typeof responseJson !== "object") return false;
  const o = responseJson as Record<string, unknown>;
  if (o._submitDiagnostics) return false;
  if (Array.isArray(o.items) || Array.isArray(o.results) || Array.isArray(o.suggestions)) {
    return true;
  }
  if (o.result != null || o.types != null) return true;
  return false;
}

export function agentNameFromEnrichmentRunId(runId: string): string | null {
  const lower = String(runId ?? "").toLowerCase();
  for (const name of ARSENKIN_REAL_AGENT_NAMES) {
    const re = AGENT_RUN_RE[name];
    if (re?.test(lower)) return name;
  }
  return null;
}

export function isReusableSiblingTask(t: SiblingRemapTaskRow): boolean {
  const state = String(t.state).toUpperCase();
  return (
    Boolean(String(t.externalTaskId ?? "").trim()) ||
    state === "DONE" ||
    isIngestibleResponse(t.responseJson)
  );
}

function toolMatchesAgent(toolName: string | null | undefined, agentName: string): boolean {
  const re = AGENT_TOOL_RE[agentName];
  if (!re) return false;
  return re.test(String(toolName ?? ""));
}

export function mergeAgentEnrichmentRunId(
  existing: readonly string[] | null | undefined,
  agentName: string,
  effectiveRunId: string
): string[] {
  const effective = String(effectiveRunId ?? "").trim();
  if (!effective) return [...(existing ?? [])];
  const re = AGENT_RUN_RE[agentName];
  if (!re) {
    const out = [...(existing ?? [])];
    if (!out.includes(effective)) out.push(effective);
    return out;
  }
  let replaced = false;
  const out = (existing ?? []).map((id) => {
    if (re.test(String(id))) {
      replaced = true;
      return effective;
    }
    return id;
  });
  if (!replaced) out.push(effective);
  return Array.from(new Set(out));
}

export function clearFailedAgentsFromEnrichmentState(
  state: UnifiedCollectionJob["arsenkinEnrichmentState"],
  agentNames: readonly string[],
  remaps: ReadonlyMap<string, string>
): UnifiedCollectionJob["arsenkinEnrichmentState"] {
  if (!state || agentNames.length === 0) return state;
  const drop = new Set(agentNames.map((n) => n.toUpperCase()));
  const failedAgents = (state.failedAgents ?? []).filter(
    (n) => !drop.has(String(n).toUpperCase())
  );
  const agents = (state.agents ?? []).map((a) => {
    const name = String(a.agentName ?? "").toUpperCase();
    if (!drop.has(name)) return a;
    const nextRun = remaps.get(name) ?? a.enrichmentRunId;
    return {
      ...a,
      enrichmentRunId: nextRun,
      terminal: false,
      terminalKind: null,
      ingested: false,
      errorCode: null,
    };
  });
  return {
    ...state,
    failedAgents,
    agents,
    enrichmentComplete: false,
  };
}

function scoreSiblingRun(tasks: SiblingRemapTaskRow[], agentName: string): number {
  const relevant = tasks.filter((t) => toolMatchesAgent(t.toolName, agentName));
  const reusable = relevant.filter(isReusableSiblingTask);
  if (reusable.length === 0) return 0;
  let score = reusable.length * 10;
  if (agentName === "ARSENKIN_URL_AUDIT_REAL") {
    const tools = new Set(reusable.map((t) => String(t.toolName ?? "").toLowerCase()));
    if (tools.has("check-h")) score += 5;
    if (tools.has("indexation")) score += 5;
  }
  const done = reusable.filter((t) => String(t.state).toUpperCase() === "DONE").length;
  score += done;
  return score;
}

function pickSiblingRunId(
  caseTasks: SiblingRemapTaskRow[],
  agentName: string,
  primaryRunId: string
): string | null {
  const byRun = new Map<string, SiblingRemapTaskRow[]>();
  for (const t of caseTasks) {
    const runId = String(t.reportRunId ?? "").trim();
    if (!runId || runId === primaryRunId) continue;
    if (!toolMatchesAgent(t.toolName, agentName) && !AGENT_RUN_RE[agentName]?.test(runId)) {
      continue;
    }
    if (!toolMatchesAgent(t.toolName, agentName)) continue;
    const list = byRun.get(runId) ?? [];
    list.push(t);
    byRun.set(runId, list);
  }
  let bestId: string | null = null;
  let bestScore = 0;
  for (const [runId, tasks] of byRun) {
    const score = scoreSiblingRun(tasks, agentName);
    if (score > bestScore) {
      bestScore = score;
      bestId = runId;
    }
  }
  return bestId;
}

function primaryNeedsRemap(tasks: SiblingRemapTaskRow[], agentName: string): boolean {
  const relevant = tasks.filter((t) => toolMatchesAgent(t.toolName, agentName));
  return !relevant.some(isReusableSiblingTask);
}

async function defaultListProviderTasksForRuns(
  runIds: string[]
): Promise<SiblingRemapTaskRow[]> {
  if (runIds.length === 0) return [];
  try {
    const { prisma } = await import("@/server/prisma/client");
    const rows = await prisma.providerTask.findMany({
      where: { reportRunId: { in: runIds } },
      select: {
        id: true,
        state: true,
        toolName: true,
        externalTaskId: true,
        responseJson: true,
        reportRunId: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      state: String(r.state),
      toolName: r.toolName,
      externalTaskId: r.externalTaskId,
      responseJson: r.responseJson,
      reportRunId: r.reportRunId,
    }));
  } catch {
    return [];
  }
}

async function defaultListCaseArsenkinTasks(caseId: string): Promise<SiblingRemapTaskRow[]> {
  try {
    const { prisma } = await import("@/server/prisma/client");
    const rows = await prisma.providerTask.findMany({
      where: {
        caseId,
        provider: "arsenkin",
        toolName: {
          in: ["suggest", "paa", "ai-serp", "check-top", "check-h", "indexation"],
        },
        OR: [
          { externalTaskId: { not: null } },
          { state: { in: ["DONE", "RUNNING", "SUBMITTED", "RATE_LIMITED", "WAITING", "POLLING"] } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: {
        id: true,
        state: true,
        toolName: true,
        externalTaskId: true,
        responseJson: true,
        reportRunId: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      state: String(r.state),
      toolName: r.toolName,
      externalTaskId: r.externalTaskId,
      responseJson: r.responseJson,
      reportRunId: r.reportRunId,
    }));
  } catch {
    return [];
  }
}

/**
 * For each failed/empty enrichment agent on the unified job, if a sibling
 * CaseAgent run already has reusable tasks, replace that agent's run id.
 */
export async function remapFailedEnrichmentRunsToSiblings(input: {
  caseId: string;
  job: UnifiedCollectionJob;
  deps?: SiblingRemapDeps;
}): Promise<SiblingRemapResult> {
  const existingIds = [...(input.job.enrichmentRunIds ?? [])];
  const failed = new Set(
    (input.job.arsenkinEnrichmentState?.failedAgents ?? []).map((n) => String(n).toUpperCase())
  );
  const agentsNeedingHelp = ARSENKIN_REAL_AGENT_NAMES.filter((name) => {
    if (failed.has(name)) return true;
    const progress = input.job.arsenkinEnrichmentState?.agents?.find(
      (a) => String(a.agentName).toUpperCase() === name
    );
    return (
      progress?.terminal === true &&
      String(progress.terminalKind ?? "").toUpperCase() === "FAILED" &&
      Number(progress.doneTaskCount ?? 0) === 0
    );
  });

  if (agentsNeedingHelp.length === 0 || existingIds.length === 0) {
    return {
      enrichmentRunIds: existingIds,
      arsenkinEnrichmentState: input.job.arsenkinEnrichmentState,
      remaps: [],
      changed: false,
    };
  }

  const primaryTasks =
    (await input.deps?.listProviderTasksForRuns?.(existingIds)) ??
    (await defaultListProviderTasksForRuns(existingIds));

  // Injected primary list without case-wide lookup → keep smoke scope.
  if (input.deps?.listProviderTasksForRuns && !input.deps.listCaseArsenkinTasks) {
    return {
      enrichmentRunIds: existingIds,
      arsenkinEnrichmentState: input.job.arsenkinEnrichmentState,
      remaps: [],
      changed: false,
    };
  }

  const caseTasks =
    (await input.deps?.listCaseArsenkinTasks?.(input.caseId)) ??
    (await defaultListCaseArsenkinTasks(input.caseId));

  let nextIds = existingIds;
  const remaps: SiblingRemapEntry[] = [];
  const remapByAgent = new Map<string, string>();

  for (const agentName of agentsNeedingHelp) {
    const primaryRunId =
      nextIds.find((id) => agentNameFromEnrichmentRunId(id) === agentName) ?? "";
    if (!primaryRunId) continue;
    const primaryForAgent = primaryTasks.filter((t) => t.reportRunId === primaryRunId);
    if (!primaryNeedsRemap(primaryForAgent, agentName)) continue;
    const siblingRunId = pickSiblingRunId(caseTasks, agentName, primaryRunId);
    if (!siblingRunId || siblingRunId === primaryRunId) continue;
    nextIds = mergeAgentEnrichmentRunId(nextIds, agentName, siblingRunId);
    remaps.push({ agentName, fromRunId: primaryRunId, toRunId: siblingRunId });
    remapByAgent.set(agentName, siblingRunId);
  }

  if (remaps.length === 0) {
    return {
      enrichmentRunIds: existingIds,
      arsenkinEnrichmentState: input.job.arsenkinEnrichmentState,
      remaps: [],
      changed: false,
    };
  }

  return {
    enrichmentRunIds: nextIds,
    arsenkinEnrichmentState: clearFailedAgentsFromEnrichmentState(
      input.job.arsenkinEnrichmentState,
      remaps.map((r) => r.agentName),
      remapByAgent
    ),
    remaps,
    changed: true,
  };
}
