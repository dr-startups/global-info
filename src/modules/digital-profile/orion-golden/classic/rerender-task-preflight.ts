/**
 * Pure helpers for safe canary rerender preflight (no API).
 */

export type ExistingProviderTask = {
  toolName: string;
  requestHash: string;
  state: string;
};

export type PlannedTaskPreflight = {
  reportRunId: string;
  tools: string[];
  rerenderOnly: boolean;
  allowNewTasks: boolean;
  existingDone: Array<{ toolName: string; requestHash: string }>;
  existingIncomplete: Array<{ toolName: string; requestHash: string; state: string }>;
  plannedHashes: string[];
  plannedNewTasks: number;
  blocked: boolean;
  blockReason?: string;
};

const STAGE2 = new Set(["ai-serp", "check-h", "indexation"]);

export function toolsFromExistingTasks(tasks: ExistingProviderTask[]): string[] {
  const tools = [...new Set(tasks.map((t) => t.toolName).filter(Boolean))];
  // Stable order: stage1 first, then stage2 if present.
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
  allowNewTasks: boolean;
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
  const plannedHashes = existingDone
    .filter((t) => tools.includes(t.toolName))
    .map((t) => t.requestHash);

  // Any requested tool without an existing DONE task implies a new paid submit.
  const missingTools = tools.filter((t) => !doneByTool.has(t));
  let plannedNewTasks = missingTools.length;
  // Default must never invent stage-2 when absent.
  if (!input.requestedTools) {
    plannedNewTasks = 0;
  }

  let blocked = false;
  let blockReason: string | undefined;
  if (existingIncomplete.length > 0 && input.rerenderOnly) {
    blocked = true;
    blockReason = `incomplete provider tasks: ${existingIncomplete.map((t) => `${t.toolName}:${t.state}`).join(",")}`;
  }
  if (plannedNewTasks > 0) {
    if (input.rerenderOnly || !(input.allowNewTasks && input.liveConfirm)) {
      blocked = true;
      blockReason = `plannedNewTasks=${plannedNewTasks} tools=${missingTools.join(",")}; need --allow-new-tasks and ARSENKIN_LIVE_CONFIRM=1`;
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
    allowNewTasks: input.allowNewTasks && input.liveConfirm,
    existingDone,
    existingIncomplete,
    plannedHashes,
    plannedNewTasks,
    blocked,
    blockReason,
  };
}
