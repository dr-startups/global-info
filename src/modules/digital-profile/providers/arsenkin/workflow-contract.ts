/**
 * Strict Arsenkin workflow identity + Full First36 surface contract.
 * Canary and Full are independent; never mix run selection or counters.
 */

import { arsenkinTools } from "./flags";

export type ArsenkinWorkflowType = "SUGGEST_RU_CANARY" | "FIRST36_FULL";

export type ArsenkinWorkflowSlug = "suggest-canary" | "first36-full";

export type FullFirst36SurfaceSlot = {
  id: string;
  stage: 1 | 2;
  label: string;
  tool: "check-top" | "suggest" | "paa" | "ai-serp" | "check-h";
  engine: "YANDEX" | "GOOGLE" | "MULTI";
  region: "RU" | "UAE" | "MIXED";
  surface: "organic" | "autocomplete" | "paa" | "ai_answer" | "page_meta";
};

/** Canonical 12 reportable surfaces for FIRST36_FULL. */
export const FIRST36_FULL_SURFACE_SLOTS: FullFirst36SurfaceSlot[] = [
  { id: "ru-yandex-organic", stage: 1, label: "RU Yandex organic", tool: "check-top", engine: "YANDEX", region: "RU", surface: "organic" },
  { id: "ru-google-organic", stage: 1, label: "RU Google organic", tool: "check-top", engine: "GOOGLE", region: "RU", surface: "organic" },
  { id: "uae-google-organic", stage: 1, label: "UAE Google organic", tool: "check-top", engine: "GOOGLE", region: "UAE", surface: "organic" },
  { id: "ru-yandex-suggest", stage: 1, label: "RU Yandex suggestions", tool: "suggest", engine: "YANDEX", region: "RU", surface: "autocomplete" },
  { id: "ru-google-suggest", stage: 1, label: "RU Google suggestions", tool: "suggest", engine: "GOOGLE", region: "RU", surface: "autocomplete" },
  { id: "uae-google-suggest", stage: 1, label: "UAE Google suggestions", tool: "suggest", engine: "GOOGLE", region: "UAE", surface: "autocomplete" },
  { id: "ru-google-paa", stage: 1, label: "RU Google PAA", tool: "paa", engine: "GOOGLE", region: "RU", surface: "paa" },
  { id: "uae-google-paa", stage: 1, label: "UAE Google PAA", tool: "paa", engine: "GOOGLE", region: "UAE", surface: "paa" },
  { id: "ru-yandex-ai", stage: 2, label: "RU Yandex AI", tool: "ai-serp", engine: "YANDEX", region: "RU", surface: "ai_answer" },
  { id: "ru-google-ai", stage: 2, label: "RU Google AI", tool: "ai-serp", engine: "GOOGLE", region: "RU", surface: "ai_answer" },
  { id: "uae-google-ai", stage: 2, label: "UAE Google AI", tool: "ai-serp", engine: "GOOGLE", region: "UAE", surface: "ai_answer" },
  { id: "url-audit", stage: 2, label: "URL audit", tool: "check-h", engine: "MULTI", region: "MIXED", surface: "page_meta" },
];

export const FIRST36_FULL_EXPECTED_SURFACES = FIRST36_FULL_SURFACE_SLOTS.length; // 12

/**
 * Слоты, которых действительно ждут при текущем составе `ARSENKIN_TOOLS`.
 *
 * Ожидаемое число поверхностей было прибито к полному списку — двенадцати. С
 * отключённой второй стадией (ADR-0005) их может быть максимум восемь, поэтому
 * гейт завершения не выполнялся никогда: прогон ждал четыре недостающие
 * поверхности до самого потолка ожидания, и отчёт не начинал собираться.
 * Симптом выглядел издевательски — агенты помечены «Отключено», но прогон их
 * всё равно ждёт.
 *
 * Ждать надо ровно того, что включено. Состав инструментов — один ответ на
 * вопрос «что работает», и гейт обязан спрашивать его же.
 */
export function first36SlotsForEnabledTools(
  env: NodeJS.ProcessEnv = process.env
): FullFirst36SurfaceSlot[] {
  const enabled = arsenkinTools(env);
  return FIRST36_FULL_SURFACE_SLOTS.filter((slot) => enabled.includes(slot.tool));
}
export const SUGGEST_CANARY_EXPECTED_SURFACES = 2;

export function workflowTypeToSlug(t: ArsenkinWorkflowType): ArsenkinWorkflowSlug {
  return t === "SUGGEST_RU_CANARY" ? "suggest-canary" : "first36-full";
}

export function workflowSlugToType(s: ArsenkinWorkflowSlug | string): ArsenkinWorkflowType {
  if (s === "suggest-canary" || s === "SUGGEST_RU_CANARY") return "SUGGEST_RU_CANARY";
  return "FIRST36_FULL";
}

export function expectedSurfaceCountForWorkflow(
  t: ArsenkinWorkflowType,
  env: NodeJS.ProcessEnv = process.env
): number {
  return t === "SUGGEST_RU_CANARY"
    ? SUGGEST_CANARY_EXPECTED_SURFACES
    : first36SlotsForEnabledTools(env).length;
}

export function isFirst36FullReportRunId(reportRunId: string): boolean {
  return String(reportRunId ?? "").startsWith("orion-arsenkin-first36-full-");
}

export function isSuggestCanaryReportRunId(reportRunId: string): boolean {
  return String(reportRunId ?? "").startsWith("orion-arsenkin-suggest-canary-");
}

export function assertWorkflowRunMatch(input: {
  requestedWorkflowType: ArsenkinWorkflowType;
  jobWorkflowType: ArsenkinWorkflowType;
  jobReportRunId: string;
}): { ok: true } | { ok: false; code: "WORKFLOW_RUN_MISMATCH"; detail: string } {
  if (input.requestedWorkflowType !== input.jobWorkflowType) {
    return {
      ok: false,
      code: "WORKFLOW_RUN_MISMATCH",
      detail: `requested=${input.requestedWorkflowType} job=${input.jobWorkflowType}`,
    };
  }
  if (input.jobWorkflowType === "FIRST36_FULL" && !isFirst36FullReportRunId(input.jobReportRunId)) {
    return {
      ok: false,
      code: "WORKFLOW_RUN_MISMATCH",
      detail: `FIRST36_FULL requires orion-arsenkin-first36-full-* got=${input.jobReportRunId}`,
    };
  }
  if (input.jobWorkflowType === "SUGGEST_RU_CANARY" && !isSuggestCanaryReportRunId(input.jobReportRunId)) {
    return {
      ok: false,
      code: "WORKFLOW_RUN_MISMATCH",
      detail: `SUGGEST_RU_CANARY requires orion-arsenkin-suggest-canary-* got=${input.jobReportRunId}`,
    };
  }
  if (input.jobWorkflowType === "FIRST36_FULL" && isSuggestCanaryReportRunId(input.jobReportRunId)) {
    return {
      ok: false,
      code: "WORKFLOW_RUN_MISMATCH",
      detail: "FIRST36_FULL must never use suggest-canary reportRunId",
    };
  }
  return { ok: true };
}

const TERMINAL_SURFACE = /^(MEASURED|DONE|OK|NO[_\s]?RESULTS|FAILED_TERMINAL|FAILED PARSE|FAILED)$/i;
const NON_TERMINAL_SURFACE = /^(PLANNED|NOT[_\s]?STARTED|RUNNING|SUBMIT[_\s]?UNKNOWN|RESULT[_\s]?FETCH[_\s]?FAILED|FAILED_PARSE)$/i;

export function isTerminalSurfaceStatus(status: string): boolean {
  const s = String(status ?? "").trim();
  if (!s) return false;
  if (NON_TERMINAL_SURFACE.test(s) && !/^(FAILED_TERMINAL|FAILED PARSE|FAILED)$/i.test(s)) {
    // RESULT_FETCH_FAILED / SUBMIT UNKNOWN are not terminal for completion
    if (/RESULT[_\s]?FETCH|SUBMIT[_\s]?UNKNOWN|FAILED_PARSE/i.test(s)) return false;
  }
  return TERMINAL_SURFACE.test(s);
}

export type CompletionGateInput = {
  workflowType: ArsenkinWorkflowType;
  expectedSurfaceCount: number;
  terminalSurfaceCount: number;
  surfaceStatuses: string[];
  stage1Done: boolean;
  stage2Done: boolean;
  bindingMatchesJob: boolean;
  renderDone: boolean;
  acceptancePass?: boolean;
};

export type CompletionGateResult =
  | { ok: true }
  | { ok: false; code: string; detail: string };

export function evaluateFullAuditCompletionGate(input: CompletionGateInput): CompletionGateResult {
  if (input.workflowType !== "FIRST36_FULL") {
    return { ok: false, code: "WORKFLOW_NOT_FULL", detail: input.workflowType };
  }
  // Ждём ровно те поверхности, инструменты которых включены (см.
  // `first36SlotsForEnabledTools`), а не весь список из двенадцати.
  const needed = first36SlotsForEnabledTools().length;
  if (input.expectedSurfaceCount !== needed) {
    return {
      ok: false,
      code: "EXPECTED_SURFACE_MISMATCH",
      detail: `expected=${input.expectedSurfaceCount} need=${needed}`,
    };
  }
  if (input.terminalSurfaceCount < needed) {
    return {
      ok: false,
      code: "TERMINAL_SURFACE_INCOMPLETE",
      detail: `${input.terminalSurfaceCount}/${needed}`,
    };
  }
  if (input.terminalSurfaceCount === 0) {
    return { ok: false, code: "TERMINAL_SURFACE_ZERO", detail: "0/12 cannot complete" };
  }
  const nonTerminal = input.surfaceStatuses.filter((s) => !isTerminalSurfaceStatus(s));
  if (nonTerminal.length > 0) {
    return {
      ok: false,
      code: "NON_TERMINAL_SURFACES_REMAIN",
      detail: nonTerminal.slice(0, 5).join(","),
    };
  }
  if (!input.stage1Done) {
    return { ok: false, code: "STAGE1_NOT_TERMINAL", detail: "Stage 1 incomplete" };
  }
  if (!input.stage2Done) {
    return { ok: false, code: "STAGE2_NOT_TERMINAL", detail: "Stage 2 incomplete" };
  }
  if (!input.bindingMatchesJob) {
    return { ok: false, code: "BINDING_RUN_MISMATCH", detail: "binding not on jobReportRunId" };
  }
  if (!input.renderDone) {
    return { ok: false, code: "RENDER_INCOMPLETE", detail: "report render not done" };
  }
  if (input.acceptancePass === false) {
    return { ok: false, code: "ACCEPTANCE_FAIL", detail: "acceptance/provenance/geometry fail" };
  }
  return { ok: true };
}

/** Progress scale for FIRST36_FULL (never 100% before completion gate). */
export function computeFullAuditPercent(input: {
  state: string;
  stage1Terminal: number;
  stage2Terminal: number;
  completed?: boolean;
}): number {
  if (input.completed) return 100;
  const state = String(input.state ?? "").toUpperCase();
  if (state === "PREFLIGHT" || state === "WAITING_INFRASTRUCTURE") return 3;
  if (state === "PLANNING") return 8;
  if (state.startsWith("STAGE1") || state === "WAITING_PROVIDER") {
    const frac = Math.min(1, Math.max(0, input.stage1Terminal / 8));
    return Math.round(10 + frac * 45); // 10–55
  }
  if (state.startsWith("STAGE2")) {
    const frac = Math.min(1, Math.max(0, input.stage2Terminal / 4));
    return Math.round(55 + frac * 25); // 55–80
  }
  if (state === "BINDING") return 85;
  if (state === "RENDERING") return 95;
  if (state === "FAILED_RETRYABLE" || state === "FAILED_TERMINAL") {
    const done = input.stage1Terminal + input.stage2Terminal;
    return Math.min(99, Math.round(10 + (done / 12) * 80));
  }
  return 5;
}

export function stage1Slots(): FullFirst36SurfaceSlot[] {
  return FIRST36_FULL_SURFACE_SLOTS.filter((s) => s.stage === 1);
}

export function stage2Slots(): FullFirst36SurfaceSlot[] {
  return FIRST36_FULL_SURFACE_SLOTS.filter((s) => s.stage === 2);
}
