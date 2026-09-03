/**
 * Долговечный тик позиций Topvisor — второй провайдер задач шага
 * `ARSENKIN_ENRICHMENT`.
 *
 * Стоит **рядом** с тиком Arsenkin, а не внутри него: тот — машина пяти
 * именованных агентов с журналом приёма и своими воротами, и растягивать её
 * на второго провайдера значило бы переписать каждые из них. Один ответ на
 * «обогащение завершено» собирает обработчик шага: ждём, пока ждёт хоть один.
 *
 * Состояние — данные джобы (`topvisorEnrichmentState`) и строка задачи в
 * `dp_provider_tasks`; ожидание переживает деплой. После `DONE` наблюдения
 * пересобираются из сохранённых снимков на каждом обороте: пока Arsenkin ещё
 * ждёт, строки Topvisor обязаны доехать до итогового артефакта.
 *
 * Разрешение — ключ: без секретов отказ с именем переменной, без тихого отката
 * на прежний путь.
 */

import type { PrismaClient } from "@prisma/client";
import { topvisorAvailability } from "../providers/config";
import { topvisorCall, type TopvisorCallFn } from "../providers/topvisor/client";
import {
  checkStatusPayload,
  positionsCheckPayload,
  readCheckPercent,
  snapshotHistoryPayload,
  snapshotToObservations,
  type TopvisorObservation,
} from "../providers/topvisor/adapters/positions";
import { ensureTopvisorProject, TopvisorProjectError } from "../providers/topvisor/project";
import { TOPVISOR_AUDIT_REGIONS, type TopvisorAuditRegion } from "../providers/topvisor/regions";
import { createPrismaTopvisorTaskStore, type TopvisorTaskStore } from "../providers/topvisor/task-store";
import { SERP_AUDIT_DEPTH } from "./orion-search-profile-service";
import type { UnifiedCollectionJob } from "./unified-collection-types";

export const TOPVISOR_ENRICHMENT_STATE_VERSION = "topvisor-enrichment-state-v1" as const;

export type TopvisorEnrichmentState = {
  version: typeof TOPVISOR_ENRICHMENT_STATE_VERSION;
  phase: "NOT_STARTED" | "CHECKING" | "DONE" | "FAILED";
  projectId: number | null;
  reportRunId: string;
  providerTaskId: string | null;
  externalTaskId: string | null;
  /** День проверки в календаре Topvisor — ключ снимка. */
  checkDate: string | null;
  regions: Array<{ key: TopvisorAuditRegion["key"]; index: number; engine: "YANDEX" | "GOOGLE"; region: "RU" | "UAE"; rows: number }>;
  keywords: number;
  lastPercent: number | null;
  observationCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
};

export type TopvisorTickResult = {
  state: TopvisorEnrichmentState;
  observations: TopvisorObservation[];
  waiting: boolean;
  /** Проверка продвинулась с прошлого оборота — для бюджета ожидания. */
  advanced: boolean;
  blockPipeline: boolean;
  blockCode?: string;
  blockMessage?: string;
  warnings: string[];
  nextPollAt: string | null;
};

export type TopvisorKeywords = { ru: readonly string[]; uae: readonly string[] };

type EnvLike = Record<string, string | undefined>;

export function topvisorReportRunId(unifiedJobId: string): string {
  return `topvisor-positions-${unifiedJobId}`;
}

/** Пауза между опросами: проверка идёт минуты, чаще спрашивать незачем. */
const CHECK_POLL_MS = 30_000;

function emptyState(job: UnifiedCollectionJob, now: Date): TopvisorEnrichmentState {
  return {
    version: TOPVISOR_ENRICHMENT_STATE_VERSION,
    phase: "NOT_STARTED",
    projectId: null,
    reportRunId: topvisorReportRunId(job.unifiedJobId),
    providerTaskId: null,
    externalTaskId: null,
    checkDate: null,
    regions: [],
    keywords: 0,
    lastPercent: null,
    observationCount: 0,
    errorCode: null,
    errorMessage: null,
    updatedAt: now.toISOString(),
  };
}

/**
 * Набор запросов — из базы: базовый сбор уже записал план в `dp_search_queries`
 * (`createdBy: REAL_ORION_SEARCH_PROFILE`), где столбец `engine` кодирует
 * регион: `YANDEX` — RU, `GOOGLE` — UAE. Второго набора не заводится.
 */
export async function loadTopvisorKeywordsFromDb(prisma: PrismaClient, caseId: string): Promise<TopvisorKeywords> {
  const rows = await prisma.searchQuery.findMany({
    where: { caseId, source: "GENERATED", createdBy: "REAL_ORION_SEARCH_PROFILE" },
    select: { engine: true, queryText: true },
  });
  const dedupe = (list: string[]) => [...new Set(list.map((q) => q.trim()).filter(Boolean))];
  return {
    ru: dedupe(rows.filter((r) => r.engine === "YANDEX").map((r) => r.queryText)),
    uae: dedupe(rows.filter((r) => r.engine === "GOOGLE").map((r) => r.queryText)),
  };
}

function regionQueries(region: TopvisorAuditRegion, keywords: TopvisorKeywords): readonly string[] {
  return region.region === "RU" ? keywords.ru : keywords.uae;
}

function rebuildObservations(input: {
  state: TopvisorEnrichmentState;
  snapshots: Record<string, unknown>;
  keywords: TopvisorKeywords;
  caseId: string;
  unifiedJobId: string;
}): { observations: TopvisorObservation[]; warnings: string[]; rowsByRegion: Record<string, number> } {
  const observations: TopvisorObservation[] = [];
  const warnings: string[] = [];
  const rowsByRegion: Record<string, number> = {};
  for (const region of TOPVISOR_AUDIT_REGIONS) {
    const index = input.state.regions.find((r) => r.key === region.key)?.index;
    const body = input.snapshots[region.key];
    if (index == null || body == null) {
      warnings.push(`topvisor-snapshot-missing:${region.key}`);
      continue;
    }
    const built = snapshotToObservations({
      body,
      region,
      regionIndex: index,
      queries: regionQueries(region, input.keywords),
      depth: SERP_AUDIT_DEPTH,
      provenance: {
        caseId: input.caseId,
        unifiedJobId: input.unifiedJobId,
        enrichmentRunId: input.state.reportRunId,
        providerTaskId: input.state.providerTaskId,
        externalTaskId: input.state.externalTaskId,
      },
    });
    observations.push(...built.observations);
    rowsByRegion[region.key] = built.observations.length;
    warnings.push(...built.warnings.map((w) => `topvisor:${w}`));
  }
  return { observations, warnings, rowsByRegion };
}

/** Дата текущей/последней проверки проекта из ответа `get/projects_2/projects`. */
function readCheckDate(body: unknown): string | null {
  const rows = (body as { result?: unknown } | null)?.result;
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const date = String(row?.status_positions_date ?? "").trim();
  return date || null;
}

/** Платный запуск проверки; строка задачи уже заведена и ждёт внешнего идентификатора. */
async function startCheck(input: {
  call: TopvisorCallFn;
  taskStore: TopvisorTaskStore;
  task: { id: string };
  state: TopvisorEnrichmentState;
  now: Date;
}): Promise<{ ok: true; state: TopvisorEnrichmentState } | { ok: false; message: string }> {
  const projectId = input.state.projectId!;
  const go = await input.call({
    action: "edit",
    service: "positions_2",
    method: "checker/go",
    payload: positionsCheckPayload(projectId),
  });
  if (!go.ok) {
    // Отказ запуска — не «запущено»: иначе ждём проверки, которой нет.
    return { ok: false, message: `Topvisor: проверка не запущена — ${go.errors.join("; ")}` };
  }
  const externalTaskId = `${projectId}:${input.state.checkDate}`;
  await input.taskStore.update(input.task.id, { state: "RUNNING", externalTaskId });
  return { ok: true, state: { ...input.state, externalTaskId } };
}

export async function runTopvisorPositionsTick(input: {
  job: UnifiedCollectionJob;
  keywords: TopvisorKeywords;
  call?: TopvisorCallFn;
  taskStore?: TopvisorTaskStore;
  prisma?: PrismaClient | null;
  now?: () => Date;
  env?: EnvLike;
}): Promise<TopvisorTickResult> {
  const now = input.now?.() ?? new Date();
  const env = input.env ?? process.env;
  const job = input.job;
  const previous = job.topvisorEnrichmentState ?? emptyState(job, now);
  const warnings: string[] = [];

  const finish = (
    state: TopvisorEnrichmentState,
    rest: Partial<Omit<TopvisorTickResult, "state">> & { observations?: TopvisorObservation[] }
  ): TopvisorTickResult => ({
    state: { ...state, updatedAt: now.toISOString() },
    observations: rest.observations ?? [],
    waiting: rest.waiting ?? false,
    advanced: rest.advanced ?? false,
    blockPipeline: rest.blockPipeline ?? false,
    blockCode: rest.blockCode,
    blockMessage: rest.blockMessage,
    warnings: [...warnings, ...(rest.warnings ?? [])],
    nextPollAt: rest.nextPollAt ?? null,
  });
  const fail = (state: TopvisorEnrichmentState, code: string, message: string): TopvisorTickResult =>
    finish(
      { ...state, phase: "FAILED", errorCode: code, errorMessage: message },
      { blockPipeline: true, blockCode: code, blockMessage: message }
    );

  // Разрешение — ключ. Проверяется на каждом обороте: секрет мог исчезнуть.
  const availability = topvisorAvailability(env);
  if (availability.status !== "ENABLED") {
    return fail(
      previous,
      "TOPVISOR_NOT_CONFIGURED",
      availability.message ?? `Topvisor не настроен: нет ${availability.missing.join(", ")}.`
    );
  }

  const call: TopvisorCallFn = input.call ?? ((req) => topvisorCall(req, { env }));
  let taskStore = input.taskStore ?? null;
  if (!taskStore) {
    const prisma = input.prisma ?? null;
    if (!prisma) {
      return fail(previous, "TOPVISOR_TASK_STORE_MISSING", "Topvisor: нет хранилища задач (ни базы, ни подстановки).");
    }
    taskStore = createPrismaTopvisorTaskStore(prisma);
  }

  /*
   * Где возобновляться, говорят данные, а не слово фазы. `FAILED` в состоянии
   * — вердикт прошлого оборота, и следующий оборот пробует снова с того места,
   * которое видно по строке задачи: нет строки — запуска не было; строка без
   * внешнего идентификатора — запуск не подтверждён; `DONE` — снимки на месте.
   * Липкий отказ превращал кнопку «Возобновить» в тот же отказ навсегда.
   */
  const stored = await taskStore.findByReportRun(previous.reportRunId);
  const liveTask = stored && stored.state !== "FAILED" ? stored : null;
  const request = (liveTask?.requestJson ?? {}) as {
    projectId?: number;
    checkDate?: string;
    regions?: TopvisorEnrichmentState["regions"];
  };
  // Фаза здесь не читается: каждая ветка ниже ставит свою. Слово прошлого
  // оборота — в том числе FAILED — на выбор ветки не влияет намеренно.
  const resumed: TopvisorEnrichmentState = {
    ...previous,
    errorCode: null,
    errorMessage: null,
    projectId: previous.projectId ?? request.projectId ?? null,
    checkDate: previous.checkDate ?? request.checkDate ?? null,
    regions: previous.regions.length > 0 ? previous.regions : (request.regions ?? []),
    providerTaskId: previous.providerTaskId ?? liveTask?.id ?? null,
    externalTaskId: previous.externalTaskId ?? liveTask?.externalTaskId ?? null,
  };

  // --- Снимки на месте: наблюдения пересобираются из сохранённого снимка. ---
  if (liveTask?.state === "DONE") {
    const doneState: TopvisorEnrichmentState = { ...resumed, phase: "DONE", lastPercent: 100 };
    const snapshots = (liveTask.responseJson?.snapshots ?? {}) as Record<string, unknown>;
    const rebuilt = rebuildObservations({
      state: doneState,
      snapshots,
      keywords: input.keywords,
      caseId: job.caseId,
      unifiedJobId: job.unifiedJobId,
    });
    return finish(
      { ...doneState, observationCount: rebuilt.observations.length },
      { observations: rebuilt.observations, warnings: rebuilt.warnings, waiting: false }
    );
  }

  // --- Запуска не было: проект, фразы, настройки, строка задачи, запуск. ---
  if (!liveTask) {
    if (input.keywords.ru.length === 0 && input.keywords.uae.length === 0) {
      return fail(resumed, "TOPVISOR_NO_KEYWORDS", "Topvisor: базовый сбор не оставил ни одного запроса — проверять нечего.");
    }
    let project;
    try {
      project = await ensureTopvisorProject({ caseId: job.caseId, keywords: input.keywords, call });
    } catch (err) {
      const code = err instanceof TopvisorProjectError ? err.code : "TOPVISOR_PROJECT_FAILED";
      return fail(resumed, code, err instanceof Error ? err.message : String(err));
    }
    warnings.push(...project.warnings, `topvisor-project:${project.projectId}:${project.created ? "created" : "found"}`);

    const checkDate = now.toISOString().slice(0, 10);
    const regions = TOPVISOR_AUDIT_REGIONS.map((region) => ({
      key: region.key,
      index: project.regions.find((r) => r.key === region.key)!.index,
      engine: region.engine,
      region: region.region,
      rows: 0,
    }));
    // Строка — до платного запуска: оборвись оборот после `checker/go`, следующий
    // найдёт её без внешнего идентификатора и сверится с проектом.
    const task = await taskStore.create({
      caseId: job.caseId,
      reportRunId: resumed.reportRunId,
      externalTaskId: null,
      requestJson: {
        projectId: project.projectId,
        checkDate,
        regions,
        keywords: { ru: [...input.keywords.ru], uae: [...input.keywords.uae] },
        depth: SERP_AUDIT_DEPTH,
      },
      submittedAt: now,
    });
    const queued: TopvisorEnrichmentState = {
      ...resumed,
      phase: "CHECKING",
      projectId: project.projectId,
      providerTaskId: task.id,
      externalTaskId: null,
      checkDate,
      regions,
      keywords: input.keywords.ru.length + input.keywords.uae.length,
      lastPercent: 0,
    };
    const started = await startCheck({ call, taskStore, task, state: queued, now });
    if (!started.ok) return fail(queued, "TOPVISOR_CHECK_START_FAILED", started.message);
    return finish(started.state, {
      waiting: true,
      advanced: true,
      nextPollAt: new Date(now.getTime() + CHECK_POLL_MS).toISOString(),
    });
  }

  // --- Проверка идёт: опрос, при 100 % — чтение снимков и приём. ---
  const checking: TopvisorEnrichmentState = { ...resumed, phase: "CHECKING" };
  const projectId = checking.projectId;
  if (projectId == null || !checking.checkDate) {
    return fail(checking, "TOPVISOR_TASK_INCOMPLETE", "Topvisor: у строки задачи нет проекта или даты проверки.");
  }
  const status = await call({
    action: "get",
    service: "projects_2",
    method: "projects",
    payload: checkStatusPayload(projectId),
  });
  if (!status.ok) {
    warnings.push(`topvisor-status-error:${status.errors.join("; ")}`);
    return finish(checking, { waiting: true, nextPollAt: new Date(now.getTime() + CHECK_POLL_MS).toISOString() });
  }

  if (!liveTask.externalTaskId) {
    /*
     * Запуск не подтверждён. Сверяемся с проектом: если у него идёт (или уже
     * прошла) проверка за нашу дату — запуск был, и второй не нужен; иначе
     * запускаем. Проверка за дату — и есть внешняя задача Topvisor.
     */
    if (readCheckDate(status.body) === checking.checkDate) {
      const externalTaskId = `${projectId}:${checking.checkDate}`;
      await taskStore.update(liveTask.id, { state: "RUNNING", externalTaskId });
      checking.externalTaskId = externalTaskId;
      warnings.push("topvisor-check-reconciled:already-running");
    } else {
      const started = await startCheck({ call, taskStore, task: liveTask, state: checking, now });
      if (!started.ok) return fail(checking, "TOPVISOR_CHECK_START_FAILED", started.message);
      return finish(started.state, {
        waiting: true,
        advanced: true,
        nextPollAt: new Date(now.getTime() + CHECK_POLL_MS).toISOString(),
      });
    }
  }

  const percent = readCheckPercent(status.body);
  const advanced = percent != null && percent > (checking.lastPercent ?? -1);
  if (percent == null || percent < 100) {
    return finish(
      { ...checking, lastPercent: percent ?? checking.lastPercent },
      { waiting: true, advanced, nextPollAt: new Date(now.getTime() + CHECK_POLL_MS).toISOString() }
    );
  }

  const snapshots: Record<string, unknown> = {};
  for (const region of TOPVISOR_AUDIT_REGIONS) {
    const res = await call({
      action: "get",
      service: "snapshots_2",
      method: "history",
      payload: snapshotHistoryPayload(projectId, region, checking.checkDate, SERP_AUDIT_DEPTH),
    });
    if (!res.ok) {
      return fail(checking, "TOPVISOR_SNAPSHOT_READ_FAILED", `Topvisor: снимок ${region.key} не прочитан — ${res.errors.join("; ")}`);
    }
    snapshots[region.key] = res.body;
  }

  const doneState: TopvisorEnrichmentState = { ...checking, phase: "DONE", lastPercent: 100 };
  const rebuilt = rebuildObservations({
    state: doneState,
    snapshots,
    keywords: input.keywords,
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
  });
  await taskStore.update(liveTask.id, {
    state: "DONE",
    completedAt: now,
    responseJson: { status: status.body, snapshots, observationCount: rebuilt.observations.length },
  });
  return finish(
    {
      ...doneState,
      regions: doneState.regions.map((r) => ({ ...r, rows: rebuilt.rowsByRegion[r.key] ?? 0 })),
      observationCount: rebuilt.observations.length,
    },
    { observations: rebuilt.observations, warnings: rebuilt.warnings, waiting: false, advanced: true }
  );
}
