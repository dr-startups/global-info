/**
 * Explicit "Пересобрать отчёт" for a COMPLETED unified job.
 * Re-runs analytics → deck assembly → render from the job's persisted composite
 * dataset (same jobId). Refreshes the job-scoped subject identity profile from
 * the case-owned artifact so profile edits (contextIdentifiers, namesake fixes)
 * take effect. NEVER calls base providers and NEVER creates Arsenkin
 * submissions — zero paid collection.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors";
import {
  claimUnifiedJobLease,
  loadUnifiedCollectionJob,
  readUnifiedArtifact,
  patchUnifiedCollectionJob,
  releaseUnifiedJobLease,
  unifiedArtifactsDir,
  writeUnifiedArtifact,
} from "./unified-collection-job-store";
import type {
  BaseCollectionManifest,
  ReportDataBinding,
  UnifiedCollectionJob,
} from "./unified-collection-types";
import type { CompositeMergeResult } from "./composite-serp-merge";
import { resolveJobSubjectProfile } from "./job-subject-profile";
import { autoResumeState } from "../workflow/auto-resume";
import { parkedOnCurrentDeckVersion } from "./parked-deck-version";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import { stripGptCopyFromSectionPacksOnDisk } from "../orion-golden/deck-sections/run-deck-build";

export type UnifiedReportRebuildEligibility = {
  rebuildAllowed: boolean;
  rebuildBlockerReason: string | null;
};

export type UnifiedReportRebuildAudit = {
  version: "unified-report-rebuild-audit-v1";
  rebuildRequestedAt: string;
  rebuildRequestedBy: string;
  previousStage: string;
  previousCompletedAt: string | null;
  subjectProfileRefreshed: boolean;
  /** State to put the job back into when the rebuild fails. */
  restoreSnapshot?: UnifiedRebuildRestoreSnapshot;
};

/**
 * Состояние прогона до пересборки — всё, что нужно вернуть на место.
 *
 * `startedAt`, `lastError` и `lastErrorCode` необязательны: снимки, записанные
 * до их появления, снимались только с готового отчёта, у которого причины
 * отказа нет, а возраст роли не играл.
 */
export type UnifiedRebuildRestoreSnapshot = {
  stage: string;
  status: string;
  progress: number;
  completedAt: string | null;
  reportLinks: Record<string, string>;
  startedAt?: string | null;
  lastError?: string | null;
  lastErrorCode?: string | null;
};

/**
 * Как вернуть прогон после неудавшейся пересборки.
 *
 * Причина возвращается вместе со стадией. Обнулять её было верно, пока
 * пересборка запускалась только с готового отчёта: у целого отчёта причины
 * отказа нет. С `FAILED_TERMINAL` та же строка делает из отказа отказ **без
 * причины** — оператор видит красную строку ни о чём, а прежняя эвристика
 * восстановления с пустым кодом предлагает продолжить сбор Arsenkin вместо
 * повтора рендера.
 *
 * У поля одно значение: почему прогон в этом состоянии. Что случилось с самой
 * попыткой, сказано предупреждениями.
 */
export function restoreStateAfterFailedRebuild(
  snapshot: UnifiedRebuildRestoreSnapshot,
  warnings: readonly string[],
  failure: { code: string; message: string }
): Partial<UnifiedCollectionJob> {
  return {
    stage: snapshot.stage as UnifiedCollectionJob["stage"],
    status: snapshot.status as UnifiedCollectionJob["status"],
    progress: snapshot.progress,
    completedAt: snapshot.completedAt,
    reportLinks: snapshot.reportLinks,
    lastError: snapshot.lastError ?? null,
    lastErrorCode: snapshot.lastErrorCode ?? null,
    // Возраст тоже возвращается: иначе прогон уносит с собой право работать
    // ещё шесть часов, которого у него не было.
    ...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
    warnings: [
      ...warnings.filter((w) => w !== REBUILD_MARKER),
      `report-rebuild-failed:${failure.code}`,
      `report-rebuild-failed-detail:${failure.message.slice(0, 160)}`,
    ],
  };
}

/** Отметка, которую пересборка держит на джобе, пока идёт попытка. */
export const REBUILD_MARKER = "report-rebuild-accepted";

export type RebuildUnifiedReportResult = {
  accepted: true;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
  subjectProfileRefreshed: boolean;
};

export type RebuildUnifiedReportDeps = {
  /** Forwarded to scheduleUnifiedTick after the rebuild transition. */
  autoSchedule?: boolean;
  subjectProfile?: ClassifierSubjectProfile | null;
  renderDeck?: unknown;
  runPrepare?: (input: unknown) => Promise<unknown>;
  allowMockReport?: boolean;
  now?: () => Date;
};

function leaseIsActive(job: UnifiedCollectionJob, now: Date): boolean {
  if (!job.leaseOwnerId || !job.leaseUntil) return false;
  const until = Date.parse(job.leaseUntil);
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * Что в **данных** мешает пересобрать отчёт. `null` — ничто не мешает.
 *
 * Спрашивают об этом двое: ворота годности (рисовать ли кнопку) и сторож
 * возраста (какой совет дать оператору, закрывая прогон). Разойдись они —
 * сторож звал бы за платным сбором там, где кнопка «Пересобрать отчёт» уже
 * доступна, или наоборот.
 *
 * Сюда входит только то, что можно узнать из данных прогона. «Идёт ли работа
 * прямо сейчас» — вопрос момента, и он остаётся в воротах годности.
 */
export async function rebuildDataBlockerReason(
  job: UnifiedCollectionJob
): Promise<string | null> {
  /*
   * Неподведённое обогащение — это оплаченные задачи Arsenkin, результат
   * которых ещё не забран. Точечный повтор ставит такую задачу за деньги и
   * `compositeDatasetId` при этом **не снимает**: на джобе остаётся набор
   * первого круга, на диске — все три артефакта, и по ним прогон неотличим от
   * готового к пересборке. Нажатие сняло бы чекпоинт подводки, и оплаченные
   * наблюдения были бы брошены.
   *
   * Признак — именно состояние обогащения, а не чекпоинт: `ARSENKIN_RESULT_INGEST`
   * ставит любой упавший тик, в том числе на подготовке, где пересборка верна.
   * Отсутствие состояния молчанием и остаётся: у прогона без обогащения
   * забирать кнопку не за что.
   */
  if (job.arsenkinEnrichmentState && !job.arsenkinEnrichmentState.enrichmentComplete) {
    return "ARSENKIN_INGEST_PENDING";
  }

  const manifest = await readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  const binding = await readUnifiedArtifact<ReportDataBinding>(
    job.caseId,
    job.unifiedJobId,
    "report-data-binding.json"
  );
  const merge = await readUnifiedArtifact<CompositeMergeResult>(
    job.caseId,
    job.unifiedJobId,
    "composite-serp-observations.json"
  );
  if (!manifest || !binding || !merge) return "REBUILD_INPUTS_MISSING";
  /*
   * Файлы прошлого слияния лежат на диске дольше, чем остаются годными:
   * восстановление подводки Arsenkin снимает `compositeDatasetId` с джобы и
   * метит их устаревшими, потому что отчёт положено пересобирать после того,
   * как новые наблюдения доедут. Спрашиваем об этом сам прогон — пустая ссылка
   * означает «текущего составного набора нет».
   */
  if (!String(job.compositeDatasetId ?? "").trim()) return "COMPOSITE_NOT_CURRENT";
  if (
    binding.caseId !== job.caseId ||
    binding.unifiedJobId !== job.unifiedJobId ||
    binding.compositeDatasetId !== merge.compositeDatasetId ||
    (merge.provenance?.unifiedJobId && merge.provenance.unifiedJobId !== job.unifiedJobId)
  ) {
    return "REBUILD_LINEAGE_MISMATCH";
  }
  return null;
}

/**
 * Продолжит ли конвейер работу сам.
 *
 * Ответ на этот вопрос в проекте один — `autoResumeState` по строкам шагов, и
 * кнопка восстановления спрашивает его же. Недоступность таблицы шагов кнопку
 * не отнимает: без ответа считаем, что автоматического продолжения нет.
 */
async function pipelineWillResumeItself(jobId: string, now: Date): Promise<boolean> {
  try {
    const { listPipelineSteps } = await import("../workflow/step-store");
    return autoResumeState(await listPipelineSteps(jobId), now).pending;
  } catch {
    return false;
  }
}

/**
 * Pure eligibility for report rebuild. Server-side only — never trust a client
 * flag. Rebuild is offered to a run that is no longer moving by itself — neither
 * by stage/status nor by a scheduled step — and whose data does not object.
 */
export async function evaluateUnifiedReportRebuildEligibility(input: {
  caseId: string;
  job: UnifiedCollectionJob | null;
  requestedJobId?: string | null;
  now?: Date;
  /** Skip lease gate (internal re-check after claim). */
  ignoreLease?: boolean;
  /**
   * Уже посчитанное «конвейер продолжит сам» — статусный маршрут спрашивает
   * шаги один раз на обе кнопки. Без него ответ берётся у шагов здесь.
   */
  autoResumePending?: boolean;
}): Promise<UnifiedReportRebuildEligibility> {
  const now = input.now ?? new Date();
  const job = input.job;
  if (!job) return { rebuildAllowed: false, rebuildBlockerReason: "JOB_NOT_FOUND" };
  if (job.caseId !== input.caseId) {
    return { rebuildAllowed: false, rebuildBlockerReason: "FOREIGN_CASE" };
  }
  const requested = String(input.requestedJobId ?? "").trim();
  if (requested && requested !== job.jobId && requested !== job.unifiedJobId) {
    return { rebuildAllowed: false, rebuildBlockerReason: "JOB_ID_MISMATCH" };
  }
  /*
   * Стадия и статус отвечают ровно на один вопрос: идёт ли работа прямо
   * сейчас. Прогон, который продолжится сам, пересобирать нельзя — это увело
   * бы живую подготовку на второй круг.
   *
   * Цел ли сбор — вопрос другой, и отвечают на него данные
   * (`rebuildDataBlockerReason`). Здесь же стоял второй ответ на него — список
   * кодов «отказов после сбора», — и он старел молча. Прогон, вставший на
   * воротах рендерера и закрытый сторожем по возрасту (`STALE_NO_PROGRESS`), в
   * список не попадал: пересборка отвечала `JOB_NOT_COMPLETED`, и оператору
   * оставалась кнопка «Начать новый аудит с повторным сбором данных» — то есть
   * выбросить оплаченный сбор и заплатить заново из-за испорченного документа.
   */
  const settled =
    (job.stage === "REPORT_READY" ||
      job.stage === "COMPLETED_PARTIAL" ||
      job.stage === "FAILED_RETRYABLE" ||
      job.stage === "FAILED_TERMINAL" ||
      // Пауза — тоже «работа не идёт»: собранное цело, и собрать из него отчёт
      // оператор вправе, не доплачивая за новый сбор (шаг 0027).
      job.stage === "CANCELLED") &&
    job.status !== "RUNNING";
  if (!settled) {
    return { rebuildAllowed: false, rebuildBlockerReason: "JOB_NOT_COMPLETED" };
  }
  // Стадия прогона молчит о запланированном повторе шага: `FAILED_RETRYABLE` с
  // назначенным сроком — это работа, которая продолжится без оператора.
  const willResume =
    input.autoResumePending ?? (await pipelineWillResumeItself(job.jobId, now));
  if (willResume) {
    return { rebuildAllowed: false, rebuildBlockerReason: "JOB_PROGRESSING" };
  }
  if (!input.ignoreLease && leaseIsActive(job, now)) {
    return { rebuildAllowed: false, rebuildBlockerReason: "ACTIVE_LEASE" };
  }

  const dataBlocker = await rebuildDataBlockerReason(job);
  if (dataBlocker) {
    return { rebuildAllowed: false, rebuildBlockerReason: dataBlocker };
  }

  /*
   * Пересборка, которая уже провалилась ровно так же, второй раз не предлагается.
   *
   * `paidRecollectionRequired` возвращает `false`, пока пересборка доступна, —
   * правило верное: платить за то, что уже собрано, предлагать нельзя. Но
   * пересборка воспроизводит отказ, причина которого записана **на сборе**: она
   * читает те же строки из базы и падает тем же кодом. Счётчика попыток у неё
   * нет, поэтому цикл замыкался — провал, снова доступна, снова провал, — и
   * платной кнопки оператор не видел никогда. Владелец упёрся в это 20.08.
   *
   * Признак лежит на самой джобе и второго ответа не требует: неудачная попытка
   * оставляет `report-rebuild-failed:<код>`, а причину прогона возвращает на
   * место `restoreStateAfterFailedRebuild`. Совпали — пересборка повторит отказ.
   *
   * Закрывает её только **та же** причина: отказ мог быть случайным (сорванная
   * запись, недоступный рендерер), и на такой пересборку не запирают.
   */
  if (rebuildAlreadyFailedTheSameWay(job)) {
    return { rebuildAllowed: false, rebuildBlockerReason: "REBUILD_ALREADY_FAILED" };
  }

  return { rebuildAllowed: true, rebuildBlockerReason: null };
}

/** Отметка неудачной попытки пересборки: код отказа той попытки. */
export const REBUILD_FAILED_MARKER_PREFIX = "report-rebuild-failed:";

/**
 * Провалилась ли пересборка ровно тем же кодом, что несёт прогон сейчас, —
 * **и с тех пор ничего не изменилось**.
 *
 * Отметку отказа не снимает никто, поэтому без второго условия замок переживал
 * выкат исправления: прогон, которому нажали «Пересобрать отчёт» до правки,
 * оставался без единой кнопки навсегда. Версия деки отвечает на «изменилось
 * ли»: она же ключ кэша пакетов, то есть ровно то, что делает следующую
 * пересборку осмысленной.
 */
function rebuildAlreadyFailedTheSameWay(job: UnifiedCollectionJob): boolean {
  const code = String(job.lastErrorCode ?? "").trim();
  if (!code) return false;
  if (!(job.warnings ?? []).includes(`${REBUILD_FAILED_MARKER_PREFIX}${code}`)) return false;
  return parkedOnCurrentDeckVersion(job.warnings);
}

/**
 * Планирует пересборку долговечно: возвращает шаги сборки отчёта в очередь,
 * чтобы работу вёл воркер (шаг 15, E12).
 *
 * Прежде здесь выполнялся один тик в веб-процессе. Он двигал джобу на одну
 * стадию и заканчивался; шаги оставались `DONE`, воркер их не подбирал, и
 * джоба зависала в `ORION_PREPARE RUNNING` без лизы и расписания.
 *
 * Возврат к прежнему поведению остаётся запасным путём: если конвейера у
 * прогона нет (создан до шага 12), пересобрать его иначе нечем.
 */
async function scheduleRebuild(
  caseId: string,
  unifiedJobId: string,
  deps: RebuildUnifiedReportDeps | undefined
): Promise<void> {
  if (deps?.autoSchedule === false) return;
  try {
    const { requeueStepsForRebuild } = await import("../workflow/step-store");
    const requeued = await requeueStepsForRebuild({
      jobId: unifiedJobId,
      names: ["COMPOSITE_MERGE", "REPORT_PREPARE"],
    });
    if (requeued > 0) return;
  } catch {
    /* конвейер недоступен — ниже прежний путь */
  }
  const { scheduleUnifiedTick } = await import("./unified-orion-collection-orchestrator");
  scheduleUnifiedTick(caseId, deps as Parameters<typeof scheduleUnifiedTick>[1]);
}

/**
 * Atomically transition the same jobId back to COMPOSITE_MERGE (full rebuild,
 * not render-only resume): the tick re-merges the composite from the persisted
 * base manifest + already-ingested Arsenkin observations (refreshing surface
 * hints, region normalization and the case-corpus image supplement), then runs
 * analytics/assembly and exactly one render. Zero base/Arsenkin provider calls.
 */
export async function rebuildUnifiedReport(input: {
  caseId: string;
  jobId: string;
  actorId: string;
  deps?: RebuildUnifiedReportDeps;
}): Promise<RebuildUnifiedReportResult> {
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");

  const nowFn = input.deps?.now ?? (() => new Date());
  const job0 = await loadUnifiedCollectionJob(input.caseId);
  if (!job0) throw new NotFoundError("unified collection job not found");
  if (job0.jobId !== jobId && job0.unifiedJobId !== jobId) {
    throw new NotFoundError("jobId does not belong to this case");
  }

  const elig = await evaluateUnifiedReportRebuildEligibility({
    caseId: input.caseId,
    job: job0,
    requestedJobId: jobId,
    now: nowFn(),
  });
  if (!elig.rebuildAllowed) {
    throw new ConflictError(elig.rebuildBlockerReason ?? "rebuild not allowed");
  }

  const ownerId = `unified-rebuild-${process.pid}-${randomUUID().slice(0, 6)}`;
  const claimed = await claimUnifiedJobLease({
    caseId: input.caseId,
    ownerId,
    leaseMs: 120_000,
    now: nowFn(),
  });
  if (!claimed) throw new ConflictError("ACTIVE_LEASE");

  let result: RebuildUnifiedReportResult;
  try {
    // Re-check after lease (fail-closed race).
    const job = await loadUnifiedCollectionJob(input.caseId);
    if (!job || (job.jobId !== jobId && job.unifiedJobId !== jobId)) {
      throw new NotFoundError("unified collection job not found");
    }
    const elig2 = await evaluateUnifiedReportRebuildEligibility({
      caseId: input.caseId,
      job,
      requestedJobId: jobId,
      now: nowFn(),
      ignoreLease: true,
    });
    if (!elig2.rebuildAllowed) {
      throw new ConflictError(elig2.rebuildBlockerReason ?? "rebuild not allowed");
    }

    // Refresh the job-scoped subject identity from the case-owned artifact so
    // an updated profile (contextIdentifiers, cleaned negative signals) is
    // picked up by the canonical prepare. Absent profile keeps the existing
    // job copy; prepare still fails closed if none exists.
    const refreshedProfile = await resolveJobSubjectProfile({
      caseId: job.caseId,
      injected: input.deps?.subjectProfile ?? null,
    });
    if (refreshedProfile) {
      await writeUnifiedArtifact(
        job.caseId,
        job.unifiedJobId,
        "subject-identity-profile.json",
        refreshedProfile
      );
    }

    // Snapshot enough to put the job back exactly as it was. Rebuilding report
    // text must never be able to destroy the result of a successful paid
    // collection: a failed attempt used to leave the job FAILED_TERMINAL, which
    // both /rebuild-report and /recover then refuse (step 08.0-ter).
    const audit: UnifiedReportRebuildAudit = {
      version: "unified-report-rebuild-audit-v1",
      rebuildRequestedAt: nowFn().toISOString(),
      rebuildRequestedBy: input.actorId,
      previousStage: job.stage,
      previousCompletedAt: job.completedAt,
      subjectProfileRefreshed: Boolean(refreshedProfile),
      restoreSnapshot: {
        stage: job.stage,
        status: job.status,
        progress: job.progress,
        completedAt: job.completedAt ?? null,
        reportLinks: job.reportLinks ?? {},
        // Пересборка запускается и с отказа: вернуть «ровно как было» значит
        // вернуть и причину, и отсчёт возраста.
        startedAt: job.startedAt ?? null,
        lastError: job.lastError ?? null,
        lastErrorCode: job.lastErrorCode ?? null,
      },
    };
    await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "unified-rebuild-audit.json", audit);
    // Defense in depth: full prepare always forceRefresh-es stage 2, but also
    // strip on-disk gptCopy + audit marker so a partial deploy cannot revive
    // SKIPPED_CACHED (live symptom: применено 0 · кэш N).
    const deckDir = join(unifiedArtifactsDir(job.caseId, job.unifiedJobId), "deck");
    const strippedGptCopy = stripGptCopyFromSectionPacksOnDisk(deckDir);
    await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "force-gpt-copy.json", {
      version: "force-gpt-copy-v1",
      requestedAt: nowFn().toISOString(),
      requestedBy: input.actorId,
      reason: "unified-report-rebuild",
      strippedGptCopy,
    });

    const patched =
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "COMPOSITE_MERGE",
        status: "WAITING",
        progress: 0.55,
        /*
         * Возраст отсчитывается заново: сторож закрывает прогон, не
         * продвигавшийся дольше шести часов, и меряет его от `startedAt`. А
         * нажимают «Пересобрать отчёт» как раз на прогоне, который простоял
         * ночь, — без этой строки первый же тик пересборки видел бы возраст в
         * восемь часов и закрывал её, не начав работы. Та же причина, по
         * которой `requeueStepsForRebuild` обнуляет `startedAt` у строк шагов:
         * это новая работа, а не продолжение прежней. `createdAt` при этом
         * остаётся историей прогона.
         */
        startedAt: nowFn().toISOString(),
        // Full rebuild: composite re-merge + analytics + assembly re-run.
        resumeCheckpoint: null,
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        reportLinks: {},
        pollAttempt: 0,
        nextPollAt: null,
        warnings: [...job.warnings.filter((w) => w !== REBUILD_MARKER), REBUILD_MARKER],
      }) ?? job;

    result = {
      accepted: true,
      jobId: patched.jobId,
      unifiedJobId: patched.unifiedJobId,
      stage: patched.stage,
      status: patched.status,
      subjectProfileRefreshed: Boolean(refreshedProfile),
    };
  } finally {
    await releaseUnifiedJobLease(input.caseId, ownerId);
  }

  /*
   * Пробуждение конвейера принадлежит **принятой** пересборке.
   *
   * Пока оно стояло в `finally`, шаги перепоставлялись и на отказе после
   * взятия лизы — повторная проверка годности, пропавшая джоба, любой сбой
   * записи. А `requeueStepsForRebuild` не только будит: она ставит строкам
   * `PENDING`, обнуляет `attempts` и стирает `lastError`/`lastErrorCode`, то
   * есть уносит память о том, кто упал. Дальше проснувшийся шаг на джобе в
   * `FAILED_TERMINAL` закрывался, стадия дрейфовала в `REPORT_READY`, и
   * «Возобновить» исчезало навсегда.
   *
   * Отказ сюда не доходит по устройству — он улетает из `try` мимо этой
   * строки, — а не потому, что кто-то не забыл проверить флаг.
   */
  await scheduleRebuild(input.caseId, job0.unifiedJobId, input.deps);
  return result;
}
