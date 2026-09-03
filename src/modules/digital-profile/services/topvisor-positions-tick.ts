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
import { topvisorSecrets } from "../providers/config";
import { topvisorCall, type TopvisorCallFn } from "../providers/topvisor/client";
import {
  checkStatusPayload,
  positionsCheckPayload,
  positionsHistoryPayload,
  readCheckPercent,
  snapshotHistoryPayload,
  snapshotToObservations,
  type TopvisorObservation,
} from "../providers/topvisor/adapters/positions";
import { aiAnswersFromPositions } from "../providers/topvisor/adapters/ai-answers";
import {
  suggestionsFromKeywords,
  TOPVISOR_HINT_DEPTH,
  TOPVISOR_HINT_GENERATORS,
} from "../providers/topvisor/adapters/suggestions";
import { stringSetting } from "../config/defaults";
import { ensureTopvisorProject, TopvisorProjectError } from "../providers/topvisor/project";
import { TOPVISOR_AUDIT_REGIONS, type TopvisorAuditRegion } from "../providers/topvisor/regions";
import { createPrismaTopvisorTaskStore, type TopvisorTaskStore } from "../providers/topvisor/task-store";
import { SERP_AUDIT_DEPTH } from "./orion-search-profile-service";
import type { UnifiedCollectionJob } from "./unified-collection-types";

export const TOPVISOR_ENRICHMENT_STATE_VERSION = "topvisor-enrichment-state-v1" as const;

export type TopvisorEnrichmentState = {
  version: typeof TOPVISOR_ENRICHMENT_STATE_VERSION;
  /**
   * `COLLECTING` — позиции прочитаны, идёт подбор подсказок. Отдельная фаза, а
   * не признак: подбор оплачивается своей задачей и может отказать, не отнимая
   * уже оплаченной выдачи.
   */
  phase: "NOT_STARTED" | "CHECKING" | "COLLECTING" | "DONE" | "FAILED";
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
  /** Сколько AI-ответов (тел, не ссылок) собрано; `0` — ответов не было. */
  aiAnswerCount: number;
  /** Запросы, у которых AI-ответа не оказалось: пустота названа, а не молчит. */
  aiAbsentQueries: string[];
  /** Подбор подсказок: поверхность, исходная фраза и группа, куда сервис их сложил. */
  suggest: Array<{
    key: TopvisorAuditRegion["key"];
    sourceQuery: string;
    groupId: number | null;
    ready: boolean;
  }>;
  suggestionCount: number;
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

/** Пауза между опросами подбора: он идёт секунды, а не минуты. */
const COLLECT_POLL_MS = 10_000;

/**
 * Поверхности подсказок, которые собираем, — из настройки: цена решения
 * (0,90 ₽ за поверхность) названа там же, где значение.
 */
function suggestRegions(env: EnvLike): TopvisorAuditRegion[] {
  /*
   * Пустая строка в окружении — это «не задано», и `stringSetting` вернёт
   * умолчание. Явное «ничего не собирать» пишется значением, которое не
   * называет ни одной поверхности, — например `none`: отдельной проверки для
   * него нет, потому что отбор по ключам и так вернёт пустой список.
   */
  const raw = stringSetting("TOPVISOR_SUGGEST_REGIONS", env);
  const keys = new Set(
    String(raw ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
  );
  return TOPVISOR_AUDIT_REGIONS.filter((r) => keys.has(r.key));
}

/** Исходная фраза поверхности — первая из набора её региона: имя субъекта. */
function sourceQueryFor(region: TopvisorAuditRegion, keywords: TopvisorKeywords): string | null {
  return regionQueries(region, keywords)[0] ?? null;
}

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
    aiAnswerCount: 0,
    aiAbsentQueries: [],
    suggest: [],
    suggestionCount: 0,
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

/**
 * Наблюдения из сохранённых ответов — выдача из снимков, AI-ответы из истории
 * позиций. Пересобираются на каждом обороте после `DONE`: пока Arsenkin ещё
 * ждёт, строки Topvisor обязаны доехать до итогового артефакта, и держать их в
 * памяти тика нельзя.
 */
function rebuildObservations(input: {
  state: TopvisorEnrichmentState;
  snapshots: Record<string, unknown>;
  positions: unknown;
  /** Ответы чтения групп подбора: ключ поверхности → список фраз группы. */
  suggestions: Record<string, unknown>;
  keywords: TopvisorKeywords;
  caseId: string;
  unifiedJobId: string;
}): {
  observations: TopvisorObservation[];
  warnings: string[];
  rowsByRegion: Record<string, number>;
  aiAnswerCount: number;
  aiAbsentQueries: string[];
  suggestionCount: number;
} {
  const observations: TopvisorObservation[] = [];
  const warnings: string[] = [];
  const rowsByRegion: Record<string, number> = {};
  const provenance = {
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId,
    enrichmentRunId: input.state.reportRunId,
    providerTaskId: input.state.providerTaskId,
    externalTaskId: input.state.externalTaskId,
  };
  let aiAnswerCount = 0;
  const aiAbsentQueries = new Set<string>();

  for (const region of TOPVISOR_AUDIT_REGIONS) {
    const index = input.state.regions.find((r) => r.key === region.key)?.index;
    const body = input.snapshots[region.key];
    if (index == null || body == null) {
      warnings.push(`topvisor-snapshot-missing:${region.key}`);
      continue;
    }
    const queries = regionQueries(region, input.keywords);
    const built = snapshotToObservations({
      body,
      region,
      regionIndex: index,
      queries,
      depth: SERP_AUDIT_DEPTH,
      provenance,
    });
    observations.push(...built.observations);
    rowsByRegion[region.key] = built.observations.length;
    warnings.push(...built.warnings.map((w) => `topvisor:${w}`));

    if (input.positions == null) {
      warnings.push(`topvisor-positions-missing:${region.key}`);
      continue;
    }
    const ai = aiAnswersFromPositions({
      body: input.positions,
      region,
      regionIndex: index,
      queries,
      provenance,
    });
    observations.push(...ai.observations);
    aiAnswerCount += ai.observations.filter((o) => !o.url).length;
    for (const q of ai.absentQueries) aiAbsentQueries.add(`${region.key}:${q}`);
    warnings.push(...ai.warnings.map((w) => `topvisor:${w}`));
  }
  let suggestionCount = 0;
  for (const planned of input.state.suggest) {
    const region = TOPVISOR_AUDIT_REGIONS.find((r) => r.key === planned.key);
    const body = input.suggestions[planned.key];
    if (!region || planned.groupId == null || body == null) continue;
    const built = suggestionsFromKeywords({
      body,
      groupId: planned.groupId,
      region,
      sourceQuery: planned.sourceQuery,
      provenance,
    });
    observations.push(...built.observations);
    suggestionCount += built.observations.length;
    warnings.push(...built.warnings.map((w) => `topvisor:${w}`));
  }

  return {
    observations,
    warnings,
    rowsByRegion,
    aiAnswerCount,
    aiAbsentQueries: [...aiAbsentQueries],
    suggestionCount,
  };
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
    rest: Partial<TopvisorTickResult> & { observations?: TopvisorObservation[] }
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

  /*
   * Разрешение — ключ, и проверяется он на каждом обороте: секрет мог исчезнуть.
   *
   * А вот **режим** начатому прогону уже не судья. Режим отвечает на вопрос
   * «начинать ли сбор через Topvisor», и его решают один раз; работать
   * начатому разрешает ключ. Пока здесь спрашивалась общая пригодность,
   * снятие `SERP_COLLECTION_PROVIDER` сразу после прогона — обычное действие
   * оператора — попав между оборотами, убивало бы прогон с «не настроен» при
   * живых ключах, теряя уже оплаченную проверку. Начатость — это данные
   * (состояние в джобе), а не слово настройки.
   */
  const { apiKey, userId } = topvisorSecrets(env);
  const missingSecrets = [!apiKey ? "TOPVISOR_API_KEY" : null, !userId ? "TOPVISOR_USER_ID" : null].filter(
    (x): x is string => Boolean(x)
  );
  if (missingSecrets.length > 0) {
    return fail(
      previous,
      "TOPVISOR_NOT_CONFIGURED",
      `Topvisor не настроен: нет ${missingSecrets.join(", ")}.`
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

  // --- Подбор идёт: дочитать группы и завершить; снимки уже сохранены. ---
  if (liveTask?.state === "DONE" && resumed.phase === "COLLECTING") {
    const settled = await settleSuggestions({
      call,
      taskStore,
      state: resumed,
      keywords: input.keywords,
      job,
      now,
      snapshots: (liveTask.responseJson?.snapshots ?? {}) as Record<string, unknown>,
      positions: liveTask.responseJson?.positions ?? null,
    });
    return finish(settled.state, settled);
  }

  // --- Снимки на месте: наблюдения пересобираются из сохранённого снимка. ---
  if (liveTask?.state === "DONE") {
    const doneState: TopvisorEnrichmentState = { ...resumed, phase: "DONE", lastPercent: 100 };
    const rebuilt = rebuildObservations({
      state: doneState,
      snapshots: (liveTask.responseJson?.snapshots ?? {}) as Record<string, unknown>,
      positions: liveTask.responseJson?.positions ?? null,
      suggestions: ((await taskStore.findByReportRun(previous.reportRunId, "collect"))?.responseJson
        ?.keywords ?? {}) as Record<string, unknown>,
      keywords: input.keywords,
      caseId: job.caseId,
      unifiedJobId: job.unifiedJobId,
    });
    return finish(
      {
        ...doneState,
        observationCount: rebuilt.observations.length,
        aiAnswerCount: rebuilt.aiAnswerCount,
        aiAbsentQueries: rebuilt.aiAbsentQueries,
        suggestionCount: rebuilt.suggestionCount,
      },
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
      toolName: "positions",
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

  /*
   * Второе чтение того же прогона: выдача лежит в снимках, AI-ответ — в
   * признаках выдачи истории позиций. Одним вызовом не обойтись, и оба чтения
   * идут одним оборотом: иначе AI-ответы доехали бы лишь на следующем, а
   * прогон уже ушёл бы к слиянию.
   */
  const positionsRead = await call({
    action: "get",
    service: "positions_2",
    method: "history",
    payload: positionsHistoryPayload(
      projectId,
      checking.regions.map((r) => r.index),
      checking.checkDate
    ),
  });
  if (!positionsRead.ok) {
    return fail(
      checking,
      "TOPVISOR_POSITIONS_READ_FAILED",
      `Topvisor: история позиций не прочитана — ${positionsRead.errors.join("; ")}`
    );
  }

  await taskStore.update(liveTask.id, {
    state: "DONE",
    completedAt: now,
    responseJson: { status: status.body, snapshots, positions: positionsRead.body },
  });

  /*
   * Позиции оплачены и прочитаны — дальше подбор подсказок. Он идёт **после**
   * проверки намеренно: собранные фразы попадают в проект, и заказать проверку
   * позиций после них значило бы оплатить вчетверо больше фраз.
   */
  const collected = await ensureSuggestCollect({
    call,
    taskStore,
    state: { ...checking, phase: "COLLECTING" },
    keywords: input.keywords,
    env,
    now,
    job,
  });
  warnings.push(...collected.warnings);
  const settled = await settleSuggestions({
    call,
    taskStore,
    state: collected.state,
    keywords: input.keywords,
    job,
    now,
    snapshots,
    positions: positionsRead.body,
  });
  // Состояние берётся у `settleSuggestions`: счётчики строк считает он.
  return finish(settled.state, { ...settled, advanced: true });
}

/**
 * Заказать подбор подсказок — по строке задачи и группе, а не по слову фазы.
 *
 * Деньги: строка задачи заводится **до** платного вызова, а перед вызовом
 * проверяется, нет ли уже группы с нужным именем: обрыв между запуском и
 * записью не должен оплачивать подбор дважды. Отказ подбора не роняет
 * оплаченную выдачу — он остаётся предупреждением.
 */
async function ensureSuggestCollect(input: {
  call: TopvisorCallFn;
  taskStore: TopvisorTaskStore;
  state: TopvisorEnrichmentState;
  keywords: TopvisorKeywords;
  env: EnvLike;
  now: Date;
  job: UnifiedCollectionJob;
}): Promise<{ state: TopvisorEnrichmentState; warnings: string[] }> {
  const warnings: string[] = [];
  const regions = suggestRegions(input.env);
  const projectId = input.state.projectId!;
  if (regions.length === 0) {
    return { state: { ...input.state, phase: "DONE", suggest: [] }, warnings };
  }

  /*
   * Уже заказанное узнаётся по строке задачи, а не по имени группы: в имени
   * («DI (город): фраза») нет поисковика, и подбор по одной фразе в Яндексе и
   * Google Москвы дал бы две группы с одинаковым именем.
   *
   * Строка заводится **до** первого платного вызова и дополняется
   * идентификатором группы сразу после каждого. Остаточный риск назван: обрыв
   * ровно между вызовом и записью оплатит один подбор (0,90 ₽) второй раз —
   * узкое окно вместо тихой двойной оплаты всего набора.
   */
  const stored = await input.taskStore.findByReportRun(input.state.reportRunId, "collect");
  const planned: TopvisorEnrichmentState["suggest"] =
    ((stored?.requestJson?.planned ?? []) as TopvisorEnrichmentState["suggest"]).map((p) => ({
      ...p,
    }));
  const saveProgress = async (): Promise<void> => {
    await input.taskStore.create({
      caseId: input.job.caseId,
      reportRunId: input.state.reportRunId,
      toolName: "collect",
      externalTaskId: planned
        .map((p) => p.groupId)
        .filter((x): x is number => x != null)
        .join(","),
      requestJson: { projectId, planned },
      submittedAt: input.now,
    });
  };

  if (planned.length === 0) {
    for (const region of regions) {
      const sourceQuery = sourceQueryFor(region, input.keywords);
      if (!sourceQuery) {
        warnings.push(`topvisor:collect-no-source:${region.key}`);
        continue;
      }
      planned.push({ key: region.key, sourceQuery, groupId: null, ready: false });
    }
    if (planned.length === 0) {
      return { state: { ...input.state, phase: "DONE", suggest: [] }, warnings };
    }
    await saveProgress();
  }

  for (const entry of planned) {
    if (entry.groupId != null) continue;
    const region = regions.find((r) => r.key === entry.key);
    if (!region) continue;
    const sourceQuery = entry.sourceQuery;
    const go = await input.call({
      action: "edit",
      service: "keywords_2",
      method: "collect/go",
      payload: {
        project_id: projectId,
        keywords: [sourceQuery],
        qualifiers: [
          {
            searcher_key: region.searcher_key,
            region_key: region.region_key,
            hint_depth: TOPVISOR_HINT_DEPTH,
            hint_generators: [...TOPVISOR_HINT_GENERATORS],
          },
        ],
      },
    });
    if (!go.ok) {
      // Отказ подбора не отменяет оплаченную выдачу — он назван и идёт дальше.
      warnings.push(`topvisor:collect-start-failed:${entry.key}:${go.errors.join("; ")}`);
      entry.ready = true;
      continue;
    }
    const created = (go.body as { result?: Record<string, { id?: unknown }> })?.result ?? {};
    const groupId = Number(Object.values(created)[0]?.id ?? Object.keys(created)[0] ?? 0);
    entry.groupId = Number.isFinite(groupId) && groupId > 0 ? groupId : null;
    await saveProgress();
  }

  const live = planned.filter((p) => p.groupId != null);
  if (live.length === 0) {
    return { state: { ...input.state, phase: "DONE", suggest: planned }, warnings };
  }
  return { state: { ...input.state, phase: "COLLECTING", suggest: planned }, warnings };
}

/**
 * Дочитать подбор: группы готовы — забрать фразы, нет — ждать.
 *
 * Группа подбора обязана остаться выключенной: включённая, она попала бы в
 * следующую проверку позиций, а фраз в ней вчетверо больше исходных. Сервис
 * отдаёт её выключенной, но полагаться на это нельзя — проверяем и выключаем.
 */
async function settleSuggestions(input: {
  call: TopvisorCallFn;
  taskStore: TopvisorTaskStore;
  state: TopvisorEnrichmentState;
  keywords: TopvisorKeywords;
  job: UnifiedCollectionJob;
  now: Date;
  snapshots: Record<string, unknown>;
  positions: unknown;
}): Promise<{
  observations: TopvisorObservation[];
  warnings: string[];
  waiting: boolean;
  nextPollAt: string | null;
  state: TopvisorEnrichmentState;
}> {
  const warnings: string[] = [];
  const state = input.state;
  const projectId = state.projectId!;
  const bodies: Record<string, unknown> = {};

  if (state.phase === "COLLECTING" && state.suggest.length > 0) {
    const groupsRead = await input.call({
      action: "get",
      service: "keywords_2",
      method: "groups",
      payload: { project_id: projectId, fields: ["id", "name", "on", "status"] },
    });
    const groups = (Array.isArray((groupsRead.body as { result?: unknown })?.result)
      ? ((groupsRead.body as { result: Array<Record<string, unknown>> }).result)
      : []) as Array<{ id?: unknown; on?: unknown; status?: unknown }>;

    let pending = 0;
    for (const planned of state.suggest) {
      if (planned.groupId == null) continue;
      const group = groups.find((g) => Number(g.id) === planned.groupId);
      if (!group) {
        pending += 1;
        continue;
      }
      if (Number(group.status) !== 0) {
        pending += 1;
        continue;
      }
      if (Number(group.on) !== 0) {
        await input.call({
          action: "edit",
          service: "keywords_2",
          method: "groups/on",
          payload: { project_id: projectId, id: planned.groupId, on: 0 },
        });
        warnings.push(`topvisor:collect-group-disabled:${planned.key}`);
      }
      const list = await input.call({
        action: "get",
        service: "keywords_2",
        method: "keywords",
        payload: {
          project_id: projectId,
          filters: [
            { name: "group_id", operator: "EQUALS", values: [String(planned.groupId)] },
          ],
          fields: ["name", "group_id"],
        },
      });
      if (!list.ok) {
        warnings.push(`topvisor:collect-read-failed:${planned.key}:${list.errors.join("; ")}`);
        continue;
      }
      bodies[planned.key] = list.body;
      planned.ready = true;
    }
    if (pending > 0) {
      return {
        observations: [],
        warnings,
        waiting: true,
        nextPollAt: new Date(input.now.getTime() + COLLECT_POLL_MS).toISOString(),
        state,
      };
    }
    const collectTask = await input.taskStore.findByReportRun(state.reportRunId, "collect");
    if (collectTask) {
      await input.taskStore.update(collectTask.id, {
        state: "DONE",
        completedAt: input.now,
        responseJson: { keywords: bodies },
      });
    }
  }

  const doneState: TopvisorEnrichmentState = { ...state, phase: "DONE", lastPercent: 100 };
  const rebuilt = rebuildObservations({
    state: doneState,
    snapshots: input.snapshots,
    positions: input.positions,
    suggestions: bodies,
    keywords: input.keywords,
    caseId: input.job.caseId,
    unifiedJobId: input.job.unifiedJobId,
  });
  return {
    observations: rebuilt.observations,
    warnings: [...warnings, ...rebuilt.warnings],
    waiting: false,
    nextPollAt: null,
    state: {
      ...doneState,
      regions: doneState.regions.map((r) => ({ ...r, rows: rebuilt.rowsByRegion[r.key] ?? 0 })),
      observationCount: rebuilt.observations.length,
      aiAnswerCount: rebuilt.aiAnswerCount,
      aiAbsentQueries: rebuilt.aiAbsentQueries,
      suggestionCount: rebuilt.suggestionCount,
    },
  };
}
