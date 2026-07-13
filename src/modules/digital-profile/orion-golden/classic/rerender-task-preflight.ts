/**
 * Pure helpers for safe canary rerender preflight (no API).
 */

export type ExistingProviderTask = {
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
  requestHash: string;
  reuse: boolean;
  estimatedLimits: number | null;
};

export type PlannedTaskPreflight = {
  reportRunId: string;
  tools: string[];
  rerenderOnly: boolean;
  allowNewProviderTasks: boolean;
  existingDone: Array<{ toolName: string; requestHash: string }>;
  existingIncomplete: Array<{ toolName: string; requestHash: string; state: string }>;
  plannedHashes: string[];
  plannedLines: PlannedTaskLine[];
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

export function parseTaskRequestMeta(toolName: string, requestJson: unknown): {
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
}): PlannedTaskPreflight {
  const existingDone = input.tasks
    .filter((t) => /^DONE$/i.test(t.state))
    .map((t) => ({ toolName: t.toolName, requestHash: t.requestHash }));
  const existingIncomplete = input.tasks
    .filter((t) => !/^DONE$/i.test(t.state))
    .map((t) => ({ toolName: t.toolName, requestHash: t.requestHash, state: t.state }));

  const defaultTools = toolsFromExistingTasks(input.tasks.filter((t) => /^DONE$/i.test(t.state)));
  const tools =
    input.requestedTools && input.requestedTools.length > 0 ? input.requestedTools : defaultTools;

  const doneByTool = new Set(existingDone.map((t) => t.toolName));
  const doneTasks = input.tasks.filter((t) => /^DONE$/i.test(t.state) && tools.includes(t.toolName));
  const plannedHashes = doneTasks.map((t) => t.requestHash);

  const plannedLines: PlannedTaskLine[] = doneTasks.map((t) => {
    const meta = parseTaskRequestMeta(t.toolName, t.requestJson);
    return {
      tool: t.toolName,
      region: meta.region,
      engine: meta.engine,
      queries: meta.queries,
      requestHash: t.requestHash,
      reuse: true,
      estimatedLimits: t.limitsSpent ?? null,
    };
  });

  const missingTools = tools.filter((t) => !doneByTool.has(t));
  let plannedNewTasks = missingTools.length;
  if (!input.requestedTools) {
    plannedNewTasks = 0;
  }

  const estimatedKnown = plannedLines
    .map((l) => l.estimatedLimits)
    .filter((v): v is number => v != null);
  const estimatedLimitsTotal = estimatedKnown.length
    ? estimatedKnown.reduce((a, b) => a + b, 0)
    : null;

  let blocked = false;
  let blockReason: string | undefined;
  if (existingIncomplete.length > 0 && input.rerenderOnly) {
    blocked = true;
    blockReason = `incomplete provider tasks: ${existingIncomplete.map((t) => `${t.toolName}:${t.state}`).join(",")}`;
  }
  if (plannedNewTasks > 0) {
    if (input.rerenderOnly || !(input.allowNewProviderTasks && input.liveConfirm)) {
      blocked = true;
      blockReason = `plannedNewTasks=${plannedNewTasks} tools=${missingTools.join(",")}; need --allow-new-provider-tasks and ARSENKIN_LIVE_CONFIRM=1`;
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
    plannedNewTasks,
    reusedTasks: plannedLines.length,
    wouldCreate: plannedNewTasks,
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
