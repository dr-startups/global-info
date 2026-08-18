/**
 * Arsenkin enrichment state contract for unified collection.
 * scheduledAgents ≠ completedAgents ≠ ingestedAgents.
 * Persists exactly-once ingestion dedupe (full resultHash).
 */

import { createHash } from "node:crypto";
import {
  ARSENKIN_AGENT_TOOLS,
  ARSENKIN_REAL_AGENT_NAMES,
  enabledArsenkinAgentNames,
} from "../agents/real/real-arsenkin-agents";
import { FIRST36_FULL_SURFACE_SLOTS } from "../providers/arsenkin/workflow-contract";
import { normalizeCoverageSurface } from "../orion-golden/deck-sections/scoped-input";
import type { CoverageCellStatusRow } from "../orion-golden/analytics/composite-dataset-builder";
import {
  emptyCoverage,
  FIRST36_PLANNED_SUPPORTED_SURFACES,
  type SurfaceCoverageBreakdown,
} from "./unified-collection-types";

export const ARSENKIN_ENRICHMENT_STATE_VERSION = "arsenkin-enrichment-state-v1" as const;

export type ArsenkinAgentTerminalKind =
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "NO_RESULTS"
  | "EMPTY_VALID"
  /**
   * Инструмент агента не входил в состав прогона: вопрос не задавали.
   *
   * Отдельное слово, потому что `EMPTY_VALID` уже значит «спросили, ответа
   * нет». Пока смыслы делили одно слово, отчёт печатал «проверено: материалов
   * нет» про поверхность, которую никто не спрашивал, а счётчики покрытия
   * записывали её в «спрошено, пусто».
   */
  | "DISABLED"
  | "REUSED"
  | "FAILED"
  | "SUBMIT_UNKNOWN_UNRECONCILED";

export type ArsenkinAgentProgress = {
  agentName: string;
  enrichmentRunId: string | null;
  scheduled: boolean;
  terminal: boolean;
  terminalKind: ArsenkinAgentTerminalKind | null;
  ingested: boolean;
  pendingTaskCount: number;
  doneTaskCount: number;
  submitUnknownCount: number;
  observationCount: number;
  errorCode?: string | null;
};

export type ArsenkinEnrichmentState = {
  version: typeof ARSENKIN_ENRICHMENT_STATE_VERSION;
  unifiedJobId: string;
  caseId: string;
  scheduledAgents: string[];
  completedAgents: string[];
  failedAgents: string[];
  pendingAgents: string[];
  ingestedAgents: string[];
  enrichmentObservationCount: number;
  enrichmentComplete: boolean;
  agents: ArsenkinAgentProgress[];
  updatedAt: string;
  /** Full sha256 hex digests of ingested result payloads (never truncated). */
  ingestedResultHashes: string[];
  /** Optional mapping resultHash → observation ids for forensic lineage. */
  resultHashToObservationIds: Record<string, string[]>;
  /** externalTaskId → last ingested resultHash (conflict if payload changes). */
  externalTaskIdToResultHash: Record<string, string>;
};

export type ArsenkinIngestedObservation = {
  region?: string;
  engine?: string;
  query?: string;
  url?: string;
  title?: string;
  snippet?: string;
  suggestion?: string;
  question?: string;
  /**
   * URL_FETCH_STATUS = provenance/diagnostic only (check-h boolean slots).
   * Never a client finding / KPI / summary evidence row.
   */
  kind?: "organic" | "suggestion" | "paa" | "other" | "URL_FETCH_STATUS";
  /** Fine-grained surface for composite/deck routing (ai_answer, organic, …). */
  surface?: string;
  /**
   * Позиция в выдаче (1-based). У Arsenkin позиция не приходит отдельным полем —
   * ею является порядок элементов в ответе `SEARCH_TOP`, и терять его нельзя:
   * по позиции определяется, попал ли материал в ТОП-20, который и есть
   * предмет аудита.
   */
  rank?: number;
  providerTaskId?: string | null;
  riskLabel?: string | null;
  /** Provenance required for ingested rows. */
  externalTaskId?: string | null;
  caseAgent?: string;
  tool?: string | null;
  enrichmentRunId?: string;
  unifiedJobId?: string;
  sourceUrlOrQuery?: string | null;
  /** Full sha256 hex — never truncated. */
  resultHash?: string | null;
  provider?: string | null;
  /** Original index in Arsenkin result array / resp map order (URL_AUDIT). */
  sourceIndex?: number | null;
  /** Arsenkin task_id from envelope when present. */
  taskId?: string | null;
  /** Boolean slot value for kind=URL_FETCH_STATUS. */
  fetchStatusValue?: boolean | null;
  diagnosticCode?: string | null;
  exclusionReason?: string | null;
  /** false for diagnostic rows; default true for evidence rows. */
  clientEvidence?: boolean;
  /** Indexation resp-map fields (status evidence, not synthesized findings). */
  yandexIndexed?: boolean | number | null;
  googleIndexed?: boolean | number | null;
  indexedAt?: string | null;
  yandexDoc?: string | null;
  respMapKey?: string | null;
};

/** Client KPI/findings must ignore diagnostic fetch-status rows. */
export function isArsenkinClientEvidenceObservation(obs: ArsenkinIngestedObservation): boolean {
  if (obs.kind === "URL_FETCH_STATUS") return false;
  if (obs.clientEvidence === false) return false;
  return true;
}

export type ArsenkinEnrichmentTickResult = {
  state: ArsenkinEnrichmentState;
  observations: ArsenkinIngestedObservation[];
  enrichmentRunIds: string[];
  arsenkinReportRunId: string | null;
  coverageMeasured?: number;
  warnings: string[];
  /** When true, fail-closed (do not advance to composite). */
  blockPipeline: boolean;
  blockCode?: string;
  blockMessage?: string;
  /** Stay on ARSENKIN_ENRICHMENT waiting for next tick. */
  waiting: boolean;
  /** Earliest ProviderTask.nextPollAt (or computed backoff) while waiting. */
  nextPollAt?: string | null;
};

export function emptyArsenkinEnrichmentState(input: {
  caseId: string;
  unifiedJobId: string;
  now?: string;
}): ArsenkinEnrichmentState {
  return {
    version: ARSENKIN_ENRICHMENT_STATE_VERSION,
    unifiedJobId: input.unifiedJobId,
    caseId: input.caseId,
    scheduledAgents: [],
    completedAgents: [],
    failedAgents: [],
    // Ждём тех, кто в составе прогона; отключённого составом агента не ждём
    // вовсе (0f0b2b1), поэтому и в pending ему делать нечего.
    pendingAgents: enabledArsenkinAgentNames(),
    ingestedAgents: [],
    enrichmentObservationCount: 0,
    enrichmentComplete: false,
    agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName) => ({
      agentName,
      enrichmentRunId: null,
      scheduled: false,
      terminal: false,
      terminalKind: null,
      ingested: false,
      pendingTaskCount: 0,
      doneTaskCount: 0,
      submitUnknownCount: 0,
      observationCount: 0,
    })),
    updatedAt: input.now ?? new Date().toISOString(),
    ingestedResultHashes: [],
    resultHashToObservationIds: {},
    externalTaskIdToResultHash: {},
  };
}

/** Full sha256 hex (64 chars). Truncation is forbidden for persisted dedupe. */
export function hashArsenkinResultPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/**
 * Backward-compatible normalize for jobs persisted before dedupe fields existed.
 */
export function normalizeArsenkinEnrichmentState(
  raw: Partial<ArsenkinEnrichmentState> | null | undefined,
  fallback: { caseId: string; unifiedJobId: string }
): ArsenkinEnrichmentState {
  const base = emptyArsenkinEnrichmentState(fallback);
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    ...raw,
    version: ARSENKIN_ENRICHMENT_STATE_VERSION,
    caseId: String(raw.caseId ?? fallback.caseId),
    unifiedJobId: String(raw.unifiedJobId ?? fallback.unifiedJobId),
    scheduledAgents: Array.isArray(raw.scheduledAgents) ? raw.scheduledAgents : base.scheduledAgents,
    completedAgents: Array.isArray(raw.completedAgents) ? raw.completedAgents : base.completedAgents,
    failedAgents: Array.isArray(raw.failedAgents) ? raw.failedAgents : base.failedAgents,
    pendingAgents: Array.isArray(raw.pendingAgents) ? raw.pendingAgents : base.pendingAgents,
    ingestedAgents: Array.isArray(raw.ingestedAgents) ? raw.ingestedAgents : base.ingestedAgents,
    agents: Array.isArray(raw.agents) && raw.agents.length > 0 ? raw.agents : base.agents,
    enrichmentObservationCount: Number(raw.enrichmentObservationCount ?? 0),
    enrichmentComplete: Boolean(raw.enrichmentComplete),
    updatedAt: String(raw.updatedAt ?? base.updatedAt),
    ingestedResultHashes: Array.isArray(raw.ingestedResultHashes) ? [...raw.ingestedResultHashes] : [],
    resultHashToObservationIds:
      raw.resultHashToObservationIds && typeof raw.resultHashToObservationIds === "object"
        ? { ...raw.resultHashToObservationIds }
        : {},
    externalTaskIdToResultHash:
      raw.externalTaskIdToResultHash && typeof raw.externalTaskIdToResultHash === "object"
        ? { ...raw.externalTaskIdToResultHash }
        : {},
  };
}

/**
 * Build enrichment state from per-agent snapshots (tests + live poller).
 * enrichmentComplete requires all five agents terminal + ingested (or EMPTY_VALID).
 */
export function buildArsenkinEnrichmentState(input: {
  caseId: string;
  unifiedJobId: string;
  agents: ArsenkinAgentProgress[];
  now?: string;
  ingestedResultHashes?: string[];
  resultHashToObservationIds?: Record<string, string[]>;
  externalTaskIdToResultHash?: Record<string, string>;
}): ArsenkinEnrichmentState {
  const byName = new Map(input.agents.map((a) => [a.agentName, a]));
  // Список агентов прогона — это его **состав**, а не каталог.
  //
  // Здесь список дополнялся до всех пяти каталожных имён заглушками
  // `{scheduled: false, terminal: false, ingested: false}`. При составе по
  // умолчанию (ADR-0005 — работают трое) двое таких фантомов навсегда
  // оставались нетерминальными, поэтому `allTerminal` и `allIngested` не
  // становились истинными никогда, а `pendingAgents` показывал пятерых.
  //
  // Боевой прогон 28.07: три агента отдали 522 наблюдения, все задачи DONE, а
  // состояние — `pendingAgents` из пяти, `completedAgents` пустой,
  // `enrichmentComplete: false`. Стадия ждала того, что уже случилось, и упала
  // по счётчику простоя.
  //
  // Отработавший агент остаётся в списке, даже если состав потом изменили:
  // оплаченный сбор не перестаёт быть оплаченным.
  const composition = enabledArsenkinAgentNames();
  const expectedNames = (composition.length > 0 ? composition : [...ARSENKIN_REAL_AGENT_NAMES]).filter(
    (n) => (ARSENKIN_REAL_AGENT_NAMES as readonly string[]).includes(n)
  );
  const names = [...new Set([...expectedNames, ...input.agents.map((a) => a.agentName)])];
  const agents = names.map((name) => {
    return (
      byName.get(name) ?? {
        agentName: name,
        enrichmentRunId: null,
        scheduled: false,
        terminal: false,
        terminalKind: null,
        ingested: false,
        pendingTaskCount: 0,
        doneTaskCount: 0,
        submitUnknownCount: 0,
        observationCount: 0,
      }
    );
  });

  const scheduledAgents = agents.filter((a) => a.scheduled).map((a) => a.agentName);
  const completedAgents = agents
    .filter(
      (a) =>
        a.terminal &&
        a.terminalKind != null &&
        a.terminalKind !== "FAILED" &&
        a.terminalKind !== "SUBMIT_UNKNOWN_UNRECONCILED"
    )
    .map((a) => a.agentName);
  const failedAgents = agents
    .filter(
      (a) =>
        a.terminalKind === "FAILED" || a.terminalKind === "SUBMIT_UNKNOWN_UNRECONCILED"
    )
    .map((a) => a.agentName);
  const pendingAgents = agents.filter((a) => !a.terminal).map((a) => a.agentName);
  const ingestedAgents = agents.filter((a) => a.ingested).map((a) => a.agentName);
  const enrichmentObservationCount = agents.reduce((n, a) => n + a.observationCount, 0);

  const allTerminal = agents.every((a) => a.terminal);
  const noneFailed = failedAgents.length === 0;
  const allIngested = agents.every((a) => a.ingested);
  const enrichmentComplete = allTerminal && noneFailed && allIngested;

  return {
    version: ARSENKIN_ENRICHMENT_STATE_VERSION,
    unifiedJobId: input.unifiedJobId,
    caseId: input.caseId,
    scheduledAgents,
    completedAgents,
    failedAgents,
    pendingAgents,
    ingestedAgents,
    enrichmentObservationCount,
    enrichmentComplete,
    agents,
    updatedAt: input.now ?? new Date().toISOString(),
    ingestedResultHashes: input.ingestedResultHashes ?? [],
    resultHashToObservationIds: input.resultHashToObservationIds ?? {},
    externalTaskIdToResultHash: input.externalTaskIdToResultHash ?? {},
  };
}

/** True when schedule-only (length===5) must NOT be treated as complete. */
export function isScheduleOnlyEnrichment(state: ArsenkinEnrichmentState | null | undefined): boolean {
  if (!state) return true;
  return state.scheduledAgents.length >= 5 && !state.enrichmentComplete;
}

export function assertEnrichmentReadyForComposite(state: ArsenkinEnrichmentState): {
  ok: boolean;
  code: string | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (state.scheduledAgents.length < ARSENKIN_REAL_AGENT_NAMES.length) {
    errors.push(
      `scheduledAgents ${state.scheduledAgents.length} < ${ARSENKIN_REAL_AGENT_NAMES.length}`
    );
  }
  if (state.pendingAgents.length > 0) {
    errors.push(`pendingAgents: ${state.pendingAgents.join(",")}`);
  }
  if (state.failedAgents.length > 0) {
    errors.push(`failedAgents: ${state.failedAgents.join(",")}`);
  }
  if (state.ingestedAgents.length < ARSENKIN_REAL_AGENT_NAMES.length) {
    errors.push(
      `ingestedAgents ${state.ingestedAgents.length} < ${ARSENKIN_REAL_AGENT_NAMES.length}`
    );
  }
  if (!state.enrichmentComplete) {
    errors.push("enrichmentComplete=false");
  }
  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? null : "ARSENKIN_ENRICHMENT_INCOMPLETE",
    errors,
  };
}

/**
 * «Поверхность этого агента в прогоне не спрашивали» — один ответ на весь
 * конвейер, и он берётся из данных прогона, а не из состава инструментов
 * сейчас: иначе пересборка старого отчёта на машине с другой конфигурацией
 * переписала бы историю.
 *
 * Легаси-форма нужна прогонам, записанным до появления `DISABLED` (до v91):
 * у выключенного агента там `EMPTY_VALID` без прогона и без задач. Второе
 * условие — «прогон вообще говорил с провайдером» — обязательно: в оффлайне
 * отправка пропускается целиком, и точно так же (EMPTY_VALID, runId=null)
 * завершаются **все** агенты, включая включённых. Без него страницы
 * оффлайн-смоков заговорили бы «не проверялись».
 */
export function agentWasDisabled(
  agent: {
    terminalKind?: ArsenkinAgentTerminalKind | string | null;
    enrichmentRunId?: string | null;
    doneTaskCount?: number;
  },
  state: { agents: Array<{ enrichmentRunId?: string | null }> }
): boolean {
  if (agent.terminalKind === "DISABLED") return true;
  if (agent.terminalKind !== "EMPTY_VALID") return false;
  if (agent.enrichmentRunId != null || agent.doneTaskCount !== 0) return false;
  return (state.agents ?? []).some((a) => a.enrichmentRunId != null);
}

/**
 * Ячейки покрытия по поверхностям, вопрос о которых в прогоне не задавали.
 *
 * Это единственный канал, которым дека узнаёт о не собиравшихся поверхностях:
 * `coverageRows` строятся из существующих наблюдений и про отсутствующие не
 * знают ничего. Поверхность называется тем же ключом, что и в деке
 * (`ai_answers`, `url_audit`): сырой токен слота попал бы в клиентский текст
 * резюме («Не закрыты направления: …»).
 */
export function disabledSurfaceCoverageCells(rawState: unknown): CoverageCellStatusRow[] {
  const raw = (rawState as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(raw)) return [];
  const agents = raw as Array<Partial<ArsenkinAgentProgress>>;
  const cells: CoverageCellStatusRow[] = [];
  for (const agent of agents) {
    const tools = (ARSENKIN_AGENT_TOOLS as Record<string, readonly string[]>)[
      String(agent.agentName ?? "")
    ];
    if (!tools) continue;
    if (!agentWasDisabled(agent, { agents })) continue;
    for (const slot of FIRST36_FULL_SURFACE_SLOTS) {
      if (!tools.includes(slot.tool)) continue;
      cells.push({
        region: slot.region,
        engine: slot.engine,
        surface: normalizeCoverageSurface(slot.surface),
        status: "NOT_COLLECTED",
        provider: "arsenkin",
        errorCode: "DISABLED_BY_TOOLS",
      });
    }
  }
  return cells;
}

/**
 * Покрытие поверхностей по состоянию обогащения — один ответ на вопрос
 * «сколько поверхностей спрошено, пусто, не поддержано составом».
 *
 * Выключенный составом агент идёт в `notSupported`: в `noResults` он означал
 * бы пустой ответ на заданный вопрос.
 */
export function surfaceCoverageFromEnrichmentState(
  state: ArsenkinEnrichmentState
): SurfaceCoverageBreakdown {
  const planned = FIRST36_PLANNED_SUPPORTED_SURFACES.length;
  return {
    ...emptyCoverage(planned),
    inFlight: state.pendingAgents.length,
    measured:
      state.enrichmentObservationCount > 0 ? Math.min(planned, state.completedAgents.length) : 0,
    noResults: state.agents.filter(
      (a) => a.terminalKind === "EMPTY_VALID" || a.terminalKind === "NO_RESULTS"
    ).length,
    notSupported: state.agents.filter((a) => a.terminalKind === "DISABLED").length,
    failedRetryable: state.failedAgents.length,
    progressRatio: state.completedAgents.length / ARSENKIN_REAL_AGENT_NAMES.length,
  };
}
