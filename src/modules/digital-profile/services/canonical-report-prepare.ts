/**
 * Canonical job-scoped ORION report prepare (B-1).
 *
 * Replaces the ORION_PREPARE stub with the canonical analytical/report pipeline:
 *   CompositeDataset -> SubjectResolution -> SurfaceAnalysis ->
 *   VerifiedFindingBundle -> ExecutiveSummary -> SectionPacks ->
 *   DeckAssembler -> one render -> acceptance.
 *
 * Fail-closed: missing/stale/foreign artifacts, a disabled canonical prepare,
 * an unresolved subject profile, a failed required section or a failed assembly
 * all raise an explicit blocker. There is NO runtime path to the legacy
 * monolithic composer here — this module imports only the canonical analytics +
 * deck-sections graph and the injectable render adapter.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RawInventoryItem } from "../orion-golden/types";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import { runOrionAnalyticsPipeline } from "../orion-golden/analytics/run-analytics-pipeline";
import {
  runDeckBuildWithGptCopy,
  runDeckGptCopyRetry,
  type GptDeckBuildResult,
  type GptDeckLayer,
} from "../orion-golden/deck-sections/gpt-enhanced-deck-build";
import { loadDeckInputsFromAnalyticsDir } from "../orion-golden/deck-sections/load-deck-inputs";
import {
  PERSONA_DECISION_ARTIFACT,
  type PersonaDecisionRecord,
} from "../orion-golden/deck-sections/scoped-input";
import {
  BulletFitNotConvergedError,
  NarrativeOverBudgetError,
  NarrativeReflowLossError,
} from "../orion-golden/deck-sections/run-deck-build";
import { NarrativeSplitLossError } from "../orion-golden/deck-sections/fragment-builders/shared";
import {
  GptCaseAnalysisSchema,
  GPT_CASE_ANALYSIS_VERSION,
  runGptCaseAnalysis,
  type GptCaseAnalysis,
  type GptCaseAnalysisDiagnostics,
  type GptJsonCaller,
} from "../orion-golden/gpt/gpt-case-analysis";
import { digitalProfileConfig } from "../config";
import {
  CANONICAL_SLOT_IDS,
} from "../orion-golden/deck-sections/canonical-slots";
import type { ReportDeckManifest } from "../orion-golden/deck-sections/contracts";
import {
  assembledDeckHashOf,
  type RendererSlide,
} from "../orion-golden/deck-sections/deck-assembler";
import {
  createCanonicalBulletMeasureAdapter,
  publishRenderedClientArtifacts,
  renderCanonicalDeck,
  sanitizeRendererClientError,
  type DeckRenderAdapter,
} from "./render-deck-artifacts";
import type { BulletMeasureAdapter } from "../orion-golden/deck-sections/measured-bullet-fit";
import { compliancePagesOf, judgeRenderTelemetry } from "./render-telemetry-gate";
import {
  ASSEMBLED_DECK_ARTIFACT,
  staleMarkerFileName,
} from "./unified-downstream-invalidation";
import type { CompositeMergeResult, CompositeObservation } from "./composite-serp-merge";
import type { ReportDataBinding } from "./unified-collection-types";
import { mapSurfaceBucket } from "../orion-golden/classic/composite-serp-overlay-merge";
import { disabledSurfaceCoverageCells } from "./arsenkin-enrichment-state";
import { genAnswerCoverageCells } from "./base-collection-manifest";
import type { RendererAssetEntry } from "../orion-golden/deck-sections/run-deck-build";
import type { VisualAssetsBySlot } from "../orion-golden/deck-sections/canonical-slots";
import { buildCanonicalVisualAssets } from "./canonical-visual-assets";
import { observationVerdictsForVisuals } from "../serp-observation/resolve-observation-highlights";
import { DECK_CONTENT_VERSION } from "../orion-golden/deck-sections/content-version";
import {
  buildReportQualitySummary,
  buildReportQualityWarnings,
  readJsonSafe,
  toJobReportQuality,
  type JobReportQuality,
  type ReportQualityPrismaCounts,
  type ReportQualitySummary,
} from "./report-quality-summary";
import {
  complianceCoverageCells,
  resolveComplianceInventoryItems,
  resolveComplianceScreenings,
  type ComplianceInventoryPrisma,
  type ComplianceScreeningPrisma,
  type ComplianceScreeningRunRow,
  type DatabaseProfileHitInput,
} from "./compliance-inventory-adapter";
import type {
  AnalystOverridesBundle,
  AnalystOverridesPrisma,
} from "./analyst-overrides-loader";
import {
  resolveEvidenceSupplement,
  type EvidenceSupplementBundle,
  type EvidenceSupplementPrisma,
} from "./evidence-supplement-adapter";
import {
  buildReportDiffArtifact,
  computeMaterialFreshness,
} from "./report-material-freshness";

export type CanonicalPrepareBlockerCode =
  | "CANONICAL_PREPARE_DISABLED"
  | "PREPARE_INPUT_MISSING"
  | "FOREIGN_ARTIFACT"
  | "STALE_ARTIFACT"
  | "SUBJECT_PROFILE_MISSING"
  | "ASSEMBLY_FAILED"
  /** Текст сборки испорчен системно — отдавать клиенту нельзя. */
  | "ASSEMBLY_QA_FAILED"
  | "REQUIRED_SECTION_FAILED"
  | "RENDER_FAILED"
  /** Рендерер выбросил целые блоки — отчёт с потерянными находками не выдаётся. */
  | "CONTENT_DROPPED_BY_RENDERER"
  /** Настоящий рендер прошёл, а телеметрии нет: потери непроверяемы. */
  | "RENDER_TELEMETRY_MISSING"
  /** Карточка записи комплаенса обрезана: совпадение уходит аналитику целиком. */
  | "COMPLIANCE_CARD_CLIPPED"
  | "GPT_COPY_RESUME_INPUTS_MISSING"
  | "GPT_COPY_CALLER_UNAVAILABLE"
  /** Базы нет — отчёт без неё отрицал бы выполненный скрининг (см. `prepare-prisma-bundle`). */
  | "PREPARE_DB_UNAVAILABLE";

export class CanonicalPrepareBlockedError extends Error {
  code: CanonicalPrepareBlockerCode;
  constructor(code: CanonicalPrepareBlockerCode, message: string) {
    super(message);
    this.name = "CanonicalPrepareBlockedError";
    this.code = code;
  }
}

/**
 * Отказ **самой меры** — возобновляемый отказ попытки, а не молчаливый пропуск
 * цикла: иначе исход сборки зависел бы от здоровья рендерера невидимо.
 *
 * Оборачивается ровно вызов адаптера. Обернуть всю сборку было бы удобнее и
 * неверно: под тем же диагнозом «мера не выполнена» оказались бы падение
 * модели, отказ обязательной секции и — что хуже всего — крик самой перекладки
 * о потерянном содержимом.
 */
function measureOrFailAttempt(measure: BulletMeasureAdapter): BulletMeasureAdapter {
  return async (payload) => {
    try {
      return await measure(payload);
    } catch (err) {
      throw new CanonicalPrepareBlockedError(
        "RENDER_FAILED",
        `мерный прогон рендерера не выполнен: ${sanitizeRendererClientError(
          err instanceof Error ? err.message : String(err)
        )}`
      );
    }
  };
}

/**
 * Цикл не сошёлся — тот же код, которым останавливают прогон ворота потерь:
 * остановленный прогон честнее урезанного отчёта, и рекавери предложит по нему
 * пересборку. Остальные ошибки сборки проходят как есть — они о другом.
 */
/**
 * Перевод отказа сборки в код, который понимает восстановление, — в одном месте.
 *
 * Выходов из сборки два (мерный путь и путь рендера), и вкладыш в каждом
 * `catch` снимался незамеченным: обе строки можно было удалить, оставив
 * `npm run ci` зелёным. Теперь перевод один, и его спрашивают оба выхода.
 *
 * Текст, не влезающий в лист, и текст, выброшенный резаком абзацев, — дефекты
 * **сборки**, а не аварии: данные сбора целы, платить заново не за что, лечится
 * пересборкой после правки. Отсюда общий код с остальными отказами качества
 * сборки: второго слова про одно и то же у восстановления быть не должно.
 */
export function prepareBlockedErrorFor(err: unknown): CanonicalPrepareBlockedError | null {
  if (err instanceof BulletFitNotConvergedError) {
    return new CanonicalPrepareBlockedError("CONTENT_DROPPED_BY_RENDERER", err.message);
  }
  /*
   * Оба отказа называют себя гейтом — маркером `<ИМЯ>=<число листов>` перед
   * прежним текстом.
   *
   * Так в проекте уже отвечают на вопрос «лечится ли отказ подготовки
   * повтором» (`prepare-gate-advice`), и отвечают именно строкой сообщения:
   * кнопку восстановления считают из `job.lastError` уже после перезапуска
   * процесса, когда объекта ошибки не существует. Поле на ошибке потребовало
   * бы колонки в базе, а маркер попадает в строку джобы сам.
   *
   * Ставится он только здесь: тем же кодом отказывают ворота сборки, часть
   * которых читает текст модели, — там повтор законен, и метить их нечем.
   */
  if (err instanceof NarrativeOverBudgetError) {
    return new CanonicalPrepareBlockedError(
      "ASSEMBLY_QA_FAILED",
      `NARRATIVE_OVER_BUDGET=${err.slides.length} ${err.message}`
    );
  }
  if (err instanceof NarrativeReflowLossError) {
    return new CanonicalPrepareBlockedError(
      "ASSEMBLY_QA_FAILED",
      `NARRATIVE_REFLOW_LOSS=${err.slides.length} ${err.message}`
    );
  }
  /*
   * Разбивка абзаца по листам не смогла обойтись без потери знаков.
   *
   * Природа та же, что у соседей: те же пакеты дают ту же раскладку и ту же
   * потерю, поэтому второй заход по определению кончится тем же. В маркере —
   * сколько знаков потерялось бы, а не сколько листов: отказ приходит с одной
   * страницы, и число страниц ничего бы не сказало.
   */
  if (err instanceof NarrativeSplitLossError) {
    return new CanonicalPrepareBlockedError(
      "ASSEMBLY_QA_FAILED",
      `NARRATIVE_SPLIT_LOSS=${Math.max(0, err.before - err.after)} ${err.message}`
    );
  }
  return null;
}

async function buildDeckUnderMeasure<T>(build: () => Promise<T>): Promise<T> {
  try {
    return await build();
  } catch (err) {
    const blocked = prepareBlockedErrorFor(err);
    if (blocked) throw blocked;
    throw err;
  }
}

export type CanonicalPrepareInput = {
  caseId: string;
  unifiedJobId: string;
  /** Job-scoped artifact directory. Everything is read/written under here. */
  artifactsDir: string;
  binding: ReportDataBinding;
  merge: CompositeMergeResult;
  /** Resolved subject identity; when omitted it is read from the job dir. */
  subjectProfile?: ClassifierSubjectProfile | null;
  subjectDisplayName?: string;
  /** Injectable renderer; defaults to HTTP canonical adapter (no silent local fallback). */
  render?: DeckRenderAdapter;
  /**
   * Мерный прогон рендерера для цикла «сборка → мера → перекладка».
   * `undefined` → канонический адаптер (мера обязательна); явный `null` →
   * офлайн-сборка без меры.
   */
  measureBulletFit?: BulletMeasureAdapter | null;
  /**
   * GPT report layer: full-corpus case analysis + per-slide client copy.
   * `undefined` → auto (live OpenAI when the AI analyst is configured and
   * NETWORK_CALLS!=0); explicit `null` → disabled; injected caller → offline
   * tests. Fail-safe: any GPT failure keeps the deterministic report.
   */
  gptCaller?: GptJsonCaller | null;
  /**
   * `render` — reuse valid assembled deck artifacts; skip analytics/SectionPacks/assembly.
   * `gpt-copy` — retry FALLBACK_* stage-2 fragments on existing packs, reassemble, one render.
   * `full` (default) — run the complete prepare pipeline.
   */
  resumeFrom?: "full" | "render" | "gpt-copy";
  /**
   * Optional Prisma for live DB funnel counts, DatabaseProfile loading,
   * analyst overrides, WikipediaCheck and SerpCapture (§1.2–1.4).
   * Intersection is structural; call sites may pass PrismaClient delegates.
   */
  prisma?: (Partial<ReportQualityPrismaCounts> &
    Partial<ComplianceInventoryPrisma> &
    Partial<ComplianceScreeningPrisma> &
    Partial<AnalystOverridesPrisma> &
    Partial<EvidenceSupplementPrisma> & {
      searchResult?: ReportQualityPrismaCounts["searchResult"] &
        Partial<AnalystOverridesPrisma["searchResult"]>;
      searchSurfaceItem?: ReportQualityPrismaCounts["searchSurfaceItem"];
    }) | null;
  /**
   * Offline/fixture compliance hits (§1.2). When set, skips prisma load.
   * Pass `[]` to force an empty compliance surface.
   */
  complianceHits?: DatabaseProfileHitInput[] | null;
  /**
   * Offline/fixture compliance screening runs. Задают ветвь пустой страницы
   * базы: «проверено — совпадений нет» / «не выполнена» / «не выполнялась».
   */
  complianceScreenings?: ComplianceScreeningRunRow[] | null;
  /** Offline/fixture analyst overrides (§1.3). When set, skips prisma load. */
  analystOverrides?: AnalystOverridesBundle | null;
  /** Offline/fixture WikipediaCheck + SERP screenshots (§1.4). */
  evidenceSupplement?: EvidenceSupplementBundle | null;
  /**
   * Решение оператора о персоне субъекта — снимком, снятым до первой траты.
   *
   * Базу подготовка не читает: решение приносит оркестратор, а здесь оно
   * становится артефактом прогона. Отсутствие поля значит «решения у кейса
   * нет», и артефакт скажет это словами.
   */
  personaDecision?: PersonaDecisionRecord | null;
};

export type CanonicalPrepareResult = {
  ok: true;
  prepareDatasetId: string;
  analyticsDir: string;
  deckDir: string;
  renderDir: string;
  pdf?: string;
  pptx?: string;
  pngDir?: string;
  contactSheet?: string;
  pageCount: number;
  assemblyCount: number;
  renderCount: number;
  baseSlotCoverage: number;
  requiredSectionsFailed: string[];
  /** Funnel aggregate written to report-quality-summary.json (REMEDIATION §0.1). */
  reportQualitySummary?: ReportQualitySummary;
  reportQuality?: JobReportQuality;
  /** Machine-readable degradations for job.warnings (REMEDIATION §0.2). */
  qualityWarnings?: string[];
};

const SUBJECT_PROFILE_FILE = "subject-identity-profile.json";

/** Canonical prepare is on unless explicitly disabled. */
export function isCanonicalPrepareEnabled(): boolean {
  return String(process.env.ORION_CANONICAL_PREPARE ?? "1") !== "0";
}

async function writeReportQualityArtifact(
  input: CanonicalPrepareInput,
  extras?: { visualAssetWarning?: string | null }
): Promise<{
  reportQualitySummary?: ReportQualitySummary;
  reportQuality?: JobReportQuality;
  qualityWarnings?: string[];
}> {
  try {
    const qualityPrisma =
      input.prisma?.searchResult &&
      typeof input.prisma.searchResult.count === "function" &&
      input.prisma.searchSurfaceItem &&
      typeof input.prisma.searchSurfaceItem.count === "function"
        ? {
            searchResult: input.prisma.searchResult,
            searchSurfaceItem: input.prisma.searchSurfaceItem,
          }
        : null;
    const reportQualitySummary = await buildReportQualitySummary({
      jobDir: input.artifactsDir,
      caseId: input.caseId,
      unifiedJobId: input.unifiedJobId,
      prisma: qualityPrisma,
    });
    const reportQuality = toJobReportQuality(reportQualitySummary);
    writeFileSync(
      join(input.artifactsDir, "report-quality-summary.json"),
      `${JSON.stringify(reportQualitySummary, null, 2)}\n`,
      "utf8"
    );
    const qualityWarnings = buildReportQualityWarnings(reportQualitySummary, {
      visualAssetWarning: extras?.visualAssetWarning ?? reportQualitySummary.visuals.warning,
    });
    return { reportQualitySummary, reportQuality, qualityWarnings };
  } catch {
    return {};
  }
}

function mapKindToSurface(kind: CompositeObservation["kind"]): string {
  switch (kind) {
    case "suggestion":
      return "autocomplete";
    case "paa":
      return "related";
    default:
      return "organic";
  }
}

/**
 * Resolve the analytics surface bucket for a composite observation. Prefers
 * the fine-grained `surface` hint preserved by the merge (images / video /
 * knowledge_block / ai_answer / indexation / …) and falls back to the coarse
 * kind mapping. Without the hint, non-organic base surfaces and Arsenkin
 * AI/url-audit rows collapsed into "organic" and starved their deck slots.
 */
export function observationSurfaceBucket(obs: CompositeObservation): string {
  return mapSurfaceBucket(obs.surface ?? mapKindToSurface(obs.kind));
}

function mapSurfaceToEvidenceType(surface: string): string {
  switch (surface) {
    case "autocomplete":
      return "suggestion";
    case "paa":
      return "related_query";
    case "images":
      return "image_result";
    case "video":
      return "video_result";
    case "wikipedia":
      return "wikipedia";
    case "ai_answer":
      return "ai_answer";
    case "knowledge_block":
      return "knowledge_block";
    case "indexation":
    case "page_meta":
      return "indexation";
    default:
      return "search_result";
  }
}

/**
 * Convert the job-scoped composite observations into inventory items the
 * canonical analytics pipeline consumes. Subject-agnostic and deterministic.
 */
export function compositeObservationsToInventory(input: {
  caseId: string;
  baseReportRunId: string;
  enrichmentRunId: string | null;
  observations: CompositeObservation[];
}): RawInventoryItem[] {
  return input.observations.map((obs) => {
    const isArsenkin = obs.primaryProvider === "arsenkin" && !obs.providers.some((p) => p === "yandex" || p === "serper");
    const provider = obs.primaryProvider || (isArsenkin ? "arsenkin" : "yandex");
    const reportRunId = isArsenkin
      ? input.enrichmentRunId ?? input.baseReportRunId
      : input.baseReportRunId;
    const inventoryId = `obs-${createHash("sha1").update(obs.key).digest("hex").slice(0, 16)}`;
    const surface = observationSurfaceBucket(obs);
    const text =
      obs.kind === "suggestion"
        ? obs.suggestion ?? obs.title ?? ""
        : obs.kind === "paa"
          ? obs.question ?? obs.title ?? ""
          : obs.title ?? "";
    return {
      inventoryId,
      caseId: input.caseId,
      reportRunId,
      source: isArsenkin ? "arsenkin" : "serp_observation",
      provider,
      region: obs.region ?? "RU",
      query: obs.query,
      collectedAt: obs.collectedAt ?? new Date(0).toISOString(),
      evidenceType: mapSurfaceToEvidenceType(surface),
      title: text || obs.title || obs.url || obs.key,
      snippet: obs.snippet ?? "",
      sourceUrl: obs.url ?? (isArsenkin ? `arsenkin://${obs.kind}/${inventoryId}` : undefined),
      imageUrl: obs.imageUrl ?? undefined,
      classification: obs.riskLabel ?? undefined,
      rawMetadata: {
        engine: obs.engine,
        surface,
        // Вид строки внутри поверхности — то, чем сборщик отличает сам ответ от
        // пометки о пустоте. Аналитике он нужен, чтобы не гадать по словам.
        contentKind: obs.contentKind,
        queryText: obs.query,
        provider,
        // Позиция в выдаче и назначение запроса — то, по чему определяется
        // предмет аудита (ТОП-20). Без них аналитика видит корпус как плоский
        // список и не отличает первую строку выдачи от сороковой.
        rank: obs.rank,
        // Чья это позиция. Источник вычислен один раз на слиянии
        // (`rankInOneScale`) и дальше едет данными: без него таблица ТОП-20 не
        // отличает нумерацию поисковика от нумерации обогатителя, а её защита
        // «только свои позиции» становится истинной вакуумно.
        rankSource: obs.rankSource,
        /*
         * Чей ранг какой — целиком, а не только победивший.
         *
         * Слияние сбора сводит два чтения одной выдачи в одно наблюдение и
         * оставляет оба номера; `rankInOneScale` выбирает, чей станет `rank`.
         * Без второго номера лист не может сказать, чем занят пропущенный
         * номер таблицы, и остаётся либо промолчать, либо соврать. Поле
         * терялось трижды подряд — здесь, в `toRow` и в схеме набора, — и
         * каждый раз одинаково: это перечень полей, и его забывали дописать.
         */
        ranksByProvider: obs.ranksByProvider,
        queryPurpose: obs.queryPurpose,
        // Какой из запросов основной, знает слой сбора. Без этой пометки слой
        // деки выбирал бы его сам — по числу материалов, а на равных по
        // алфавиту, — и обещание «ТОП-20 по запросу ФИО» становилось бы
        // неисполнимым: другой набор написаний дал бы другую двадцатку.
        subjectNameQuery: obs.subjectNameQuery,
        // Source lineage for §1.3 override matching. Do NOT put searchResult:*
        // into evidenceRefs — composite builder would drop the inventory: fallback
        // and break deck evidenceIndex / assembly validation.
        sourceEvidenceRefs: obs.evidenceRefs ?? [],
        baseSearchResultId: obs.baseSearchResultId ?? null,
        baseSearchSurfaceItemId: obs.baseSearchSurfaceItemId ?? null,
      },
    } satisfies RawInventoryItem;
  });
}

/**
 * Resolve the GPT caller for the report layer. Explicit injection wins;
 * otherwise live OpenAI is used only when the AI analyst is configured,
 * NETWORK_CALLS is not 0 and ORION_GPT_REPORT_COPY is not explicitly off.
 */
function resolveGptCaller(input: CanonicalPrepareInput): GptJsonCaller | null {
  if (input.gptCaller !== undefined) return input.gptCaller;
  if (process.env.NETWORK_CALLS === "0") return null;
  if (String(process.env.ORION_GPT_REPORT_COPY ?? "1") === "0") return null;
  const ai = digitalProfileConfig.aiAnalyst;
  if (!ai.enabled || !ai.openAiApiKey) return null;
  // One-shot HTTP attempt. Stage 2 retries via enhanceSectionPacksWithGptCopy
  // queue; stage 1 uses callOpenAiStrictJson (queued) below.
  return async (args) => {
    const { callOpenAiStrictJsonOnce } = await import("../orion-golden/gpt/openai-json-client");
    return callOpenAiStrictJsonOnce(args);
  };
}

function resolveSubjectProfile(input: CanonicalPrepareInput): ClassifierSubjectProfile {
  if (input.subjectProfile) return input.subjectProfile;
  const path = join(input.artifactsDir, SUBJECT_PROFILE_FILE);
  if (!existsSync(path)) {
    throw new CanonicalPrepareBlockedError(
      "SUBJECT_PROFILE_MISSING",
      `subject identity profile not resolved for case ${input.caseId} (expected ${SUBJECT_PROFILE_FILE} in job dir or an injected profile)`
    );
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ClassifierSubjectProfile;
    if (!parsed.displayName) throw new Error("missing displayName");
    return parsed;
  } catch (err) {
    throw new CanonicalPrepareBlockedError(
      "SUBJECT_PROFILE_MISSING",
      `subject identity profile unreadable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function assertLineage(input: CanonicalPrepareInput): void {
  const { binding, merge, caseId, unifiedJobId } = input;
  if (!binding?.compositeDatasetId || !merge?.compositeDatasetId) {
    throw new CanonicalPrepareBlockedError(
      "PREPARE_INPUT_MISSING",
      "binding/merge composite dataset id missing before canonical prepare"
    );
  }
  if (binding.caseId !== caseId) {
    throw new CanonicalPrepareBlockedError(
      "FOREIGN_ARTIFACT",
      `binding.caseId ${binding.caseId} != job caseId ${caseId}`
    );
  }
  if (binding.compositeDatasetId !== merge.compositeDatasetId) {
    throw new CanonicalPrepareBlockedError(
      "STALE_ARTIFACT",
      `binding.compositeDatasetId ${binding.compositeDatasetId} != merge.compositeDatasetId ${merge.compositeDatasetId}`
    );
  }
  if (merge.provenance?.unifiedJobId && merge.provenance.unifiedJobId !== unifiedJobId) {
    throw new CanonicalPrepareBlockedError(
      "FOREIGN_ARTIFACT",
      `merge provenance unifiedJobId ${merge.provenance.unifiedJobId} != job ${unifiedJobId}`
    );
  }
}

export type AssembledDeckReuse = {
  deckManifest: ReportDeckManifest;
  rendererSlides: RendererSlide[];
  assemblyHash: string;
  caseId: string;
  reportRunId: string;
  datasetId: string;
};

/**
 * Годная сборка либо названная причина отказа — третьего ответа нет.
 *
 * Прежний `null` означал сразу пять разных вещей, и наверху все они молча
 * превращались в полную пересборку с обоими проходами GPT: «повторный рендер»
 * стоил столько же, сколько «Пересобрать отчёт», и понять почему было неоткуда.
 *
 * Причины перечислены типом: от точного написания зависят фильтр предупреждений
 * прогона и раздел §8 `ENGINEERING.md`, а называться они обязаны в одном месте —
 * включая ту, которую выносит вызыватель (`binding-missing`: сверять не с чем,
 * привязки джобы нет).
 */
export type AssembledDeckRefusal =
  | "missing-files"
  | "binding-missing"
  | "stale-marker"
  /** Деку собрал построитель прежней версии — рендерить её заново нельзя. */
  | "stale-content-version"
  | "dataset-missing"
  | "coverage-incomplete"
  | "deck-manifest-mismatch"
  | "not-accepted"
  | `corrupt:${"unreadable" | "no-slides" | "no-page-count"}`
  | `case-mismatch deck=${string} expected=${string}`
  | `dataset-mismatch deck=${string} expected=${string}`;

export type AssembledDeckReuseResult =
  | { reused: AssembledDeckReuse; refusedReason: null }
  | { reused: null; refusedReason: AssembledDeckRefusal };

const refused = (reason: AssembledDeckRefusal): AssembledDeckReuseResult => ({
  reused: null,
  refusedReason: reason,
});

/**
 * Стоп-маркер инвалидации: `<имя>.stale.json` с `doNotReuse: true` пишется
 * после дозагрузки наблюдений (`unified-downstream-invalidation.ts`) и лежит в
 * корне каталога прогона, а не рядом с самим файлом деки. Имя приходит от
 * писателя — чеканить его здесь второй раз значило бы развести две стороны
 * молча.
 */
function deckStaleMarkerPath(artifactsDir: string): string {
  return join(artifactsDir, staleMarkerFileName(ASSEMBLED_DECK_ARTIFACT));
}

function deckIsMarkedStale(artifactsDir: string): boolean {
  const marker = deckStaleMarkerPath(artifactsDir);
  if (!existsSync(marker)) return false;
  // Нечитаемый маркер — всё равно объявление «этой деке верить нельзя».
  const parsed = readJsonSafe<{ doNotReuse?: boolean }>(marker);
  return parsed ? parsed.doNotReuse === true : true;
}

/**
 * Предупреждение о том, что стоп-маркер остался лежать.
 *
 * Незамеченный отказ уборки закрывает прогону дешёвый повтор навсегда: маркер
 * никуда не делся, каждый следующий реюз отбивается им, и «повторный рендер»
 * снова платит за аналитику и обе стадии GPT — ровно тот исход, который уборка
 * и должна предотвращать.
 */
export const DECK_STALE_MARKER_NOT_CLEARED_WARNING = "deck-stale-marker-not-cleared";

/**
 * Маркер снимается пересборкой: он говорил о деке, которой больше нет.
 *
 * Иначе одна дозагрузка наблюдений закрывала бы прогону дешёвый повторный
 * рендер навсегда — маркер никто не удаляет, и каждый следующий реюз отбивался
 * бы им уже после того, как дека пересобрана по новым данным.
 */
function clearDeckStaleMarker(artifactsDir: string): string | null {
  const marker = deckStaleMarkerPath(artifactsDir);
  if (!existsSync(marker)) return null;
  try {
    unlinkSync(marker);
    return null;
  } catch {
    return DECK_STALE_MARKER_NOT_CLEARED_WARNING;
  }
}

/**
 * Штамп приёмки сборки — рядом с декой, о которой он говорит.
 *
 * Лежит в `deck/`, а стоп-маркер той же деки — в корне каталога прогона:
 * маркеры пишет `writeUnifiedArtifact`, а он о подкаталогах не знает. Рядом
 * друг с другом их искать бесполезно.
 */
const ASSEMBLY_ACCEPTANCE_FILE = "assembly-accepted.json";

/** Файлы, чей байтовый хэш и есть «эта сборка»: сама дека и её манифест. */
function assemblyFilePaths(deckDir: string): [string, string] {
  return [join(deckDir, ASSEMBLED_DECK_ARTIFACT), join(deckDir, "report-deck-manifest.json")];
}

/**
 * Ворота сборки приняли деку, лежащую в `deckDir`: поставить штамп и вернуть
 * байтовый хэш принятой пары файлов (`null` — файлы не прочитались).
 *
 * `runDeckBuild` пишет деку на диск раньше, чем подготовка её судит, поэтому
 * забракованная сборка остаётся лежать целой и структурно неотличимой от
 * принятой: ворота качества текста говорят о словах на безупречных страницах.
 * Отличить их можно только вердиктом, и записывает его тот, кто его вынес.
 * Штамп положительный намеренно: прогон, умерший между записью деки и судом,
 * не оставил бы отрицательной отметки, и его деку реюз принял бы несудимой.
 *
 * Ключ штампа — **байтовый** хэш пары файлов, а не отпечаток укладки: укладка
 * слов не видит, и пересборка с теми же страницами и другим текстом унаследовала
 * бы приёмку предыдущей — то есть ровно то, что ворота и забраковали.
 */
export function stampAcceptedAssembly(
  deckDir: string,
  deckManifest: ReportDeckManifest
): string | null {
  const assemblyHash = hashAssemblyFiles(assemblyFilePaths(deckDir));
  if (!assemblyHash) return null;
  writeFileSync(
    join(deckDir, ASSEMBLY_ACCEPTANCE_FILE),
    `${JSON.stringify(
      {
        version: "deck-assembly-accepted-v1",
        caseId: deckManifest.caseId,
        reportRunId: deckManifest.reportRunId,
        datasetId: deckManifest.sourceDatasetId,
        assemblyHash,
        baseSlotCoverage: deckManifest.baseSlotCoverage,
        pageCount: deckManifest.pageCount,
        acceptedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return assemblyHash;
}

/**
 * Байтовый хэш пары файлов сборки или `null`, если их не удалось прочитать.
 *
 * Между проверкой существования и чтением файл может исчезнуть, а загрузчик
 * обязан ответить причиной, а не исключением: его зовут из ветки резюме и из
 * ручки восстановления, и исключение оттуда — это упавший прогон вместо
 * пересборки.
 */
function hashAssemblyFiles(paths: string[]): string | null {
  try {
    const hash = createHash("sha256");
    for (const path of paths) {
      hash.update(createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** Load and validate assembled deck artifacts for render-only resume. */
export function loadReusableAssembledDeck(input: {
  artifactsDir: string;
  caseId: string;
  expectedDatasetId: string;
}): AssembledDeckReuseResult {
  const deckDir = join(input.artifactsDir, "deck");
  const [assembledPath, manifestPath] = assemblyFilePaths(deckDir);
  if (!existsSync(assembledPath) || !existsSync(manifestPath)) return refused("missing-files");
  if (deckIsMarkedStale(input.artifactsDir)) return refused("stale-marker");
  const assembled = readJsonSafe<{
    caseId?: string;
    reportRunId?: string;
    datasetId?: string;
    sourceDatasetId?: string;
    slides?: RendererSlide[];
  }>(assembledPath);
  const deckManifest = readJsonSafe<ReportDeckManifest>(manifestPath);
  // `null` разбирается успешно и уронил бы читателя на первом же поле.
  if (!assembled || !deckManifest) return refused("corrupt:unreadable");
  /*
   * Дека — продукт построителя, а построитель версионирован.
   *
   * Кнопка «Повторить рендер», которую восстановление предлагает ровно на
   * `CONTENT_DROPPED_BY_RENDERER`, переиспользовала бы ту самую переполненную
   * деку и привела бы к тому же блокеру. Отсутствие поля — тоже отказ, и
   * намеренно: деки, собранные до появления поля, несут ровно то, что новая
   * версия построителя чинила.
   */
  if ((deckManifest as { contentVersion?: unknown }).contentVersion !== DECK_CONTENT_VERSION) {
    return refused("stale-content-version");
  }
  const datasetId = String(assembled.datasetId ?? assembled.sourceDatasetId ?? "");
  if (assembled.caseId !== input.caseId) {
    return refused(`case-mismatch deck=${assembled.caseId ?? ""} expected=${input.caseId}`);
  }
  // Дека без идентификатора мимо сверки не проскальзывает: о её происхождении
  // не известно ничего, а прежнее `datasetId && ...` считало её своей.
  if (!datasetId) return refused("dataset-missing");
  if (datasetId !== input.expectedDatasetId) {
    return refused(`dataset-mismatch deck=${datasetId} expected=${input.expectedDatasetId}`);
  }
  if (!Array.isArray(assembled.slides) || assembled.slides.length === 0) {
    return refused("corrupt:no-slides");
  }
  if (!deckManifest.pageCount || deckManifest.pageCount <= 0) return refused("corrupt:no-page-count");
  // Покрытие слотов измеряется по манифесту, а не утверждается наверху: дека,
  // не набравшая 36 канонических позиций, уехала бы клиенту как полный отчёт.
  if (deckManifest.baseSlotCoverage !== CANONICAL_SLOT_IDS.length) {
    return refused("coverage-incomplete");
  }
  const laidOutPages = assembled.slides.map((slide) => ({
    id: String(slide?.slideKey ?? ""),
    pageNumber: Number(slide?.pageNumber ?? 0),
  }));
  if (assembledDeckHashOf(laidOutPages) !== deckManifest.assembledDeckHash) {
    return refused("deck-manifest-mismatch");
  }
  const assemblyHash = hashAssemblyFiles([assembledPath, manifestPath]);
  if (!assemblyHash) return refused("corrupt:unreadable");
  // Приёмка относится к этим байтам, а не к «деке вообще»: сменившийся текст
  // на той же раскладке — это другая сборка, и судить её должны заново.
  const acceptance = readJsonSafe<{ assemblyHash?: string }>(
    join(deckDir, ASSEMBLY_ACCEPTANCE_FILE)
  );
  if (acceptance?.assemblyHash !== assemblyHash) return refused("not-accepted");
  return {
    reused: {
      deckManifest,
      rendererSlides: assembled.slides,
      assemblyHash,
      caseId: assembled.caseId,
      reportRunId: String(assembled.reportRunId ?? ""),
      datasetId,
    },
    refusedReason: null,
  };
}

/**
 * Возобновление с рендера свалилось в полную сборку — с названной причиной.
 *
 * Фолбэк законен (дека бывает инвалидирована, бита или от другого набора), но
 * молчать о нём нельзя: прогон, который «просто перерисовал документ», платит
 * при этом за аналитику и обе стадии GPT.
 */
export const RENDER_RESUME_REASSEMBLY_WARNING_PREFIX = "render-resume-reassembly:";

/**
 * С чего начинаются предупреждения, описывающие **попытку** подготовки, а не
 * прогон: у одного семейства это префикс с двоеточием, у другого — весь токен.
 *
 * Висящее с прошлой попытки врёт о нынешней, поэтому успешная подготовка их
 * снимает (`warningsSurvivingSuccessfulPrepare` в оркестраторе — общий список
 * префиксов `mergeJobWarnings` эти токены не знает и сам их не заменит).
 */
export const PREPARE_ATTEMPT_WARNING_STARTS = [
  RENDER_RESUME_REASSEMBLY_WARNING_PREFIX,
  DECK_STALE_MARKER_NOT_CLEARED_WARNING,
] as const;

/**
 * Суд над свежесобранной декой — один на оба пути сборки.
 *
 * Ворота одинаковы для полной сборки и для повтора стадии 2, и держать их в
 * двух местах значит держать два ответа на вопрос «годится ли эта дека»:
 * правка правила обязана попасть в оба, а разойтись они могут молча. Принятая
 * дека получает штамп здесь же — там, где вердикт вынесен, и нигде больше.
 *
 * `answersStaleMarker` — прочла ли эта сборка наблюдения заново. Стоп-маркер
 * снимает только такая сборка и только после того, как её приняли:
 * провалившаяся на воротах пересборка гасила бы защиту, ничем её не заменив, и
 * следующая попытка переиспользовала бы доингестную деку.
 *
 * Возвращает хэш сборки: он считается по файлам на диске, потому что
 * идемпотентный повтор рендера сравнивает именно их.
 */
function acceptAssembledDeck(
  input: CanonicalPrepareInput,
  deck: GptDeckBuildResult,
  options: { answersStaleMarker: boolean }
): { assemblyHash: string | null; staleMarkerWarning: string | null } {
  if (deck.assembly.errors.length > 0) {
    throw new CanonicalPrepareBlockedError(
      "ASSEMBLY_FAILED",
      `deck assembly failed: ${deck.assembly.errors.slice(0, 4).join("; ")}`
    );
  }
  if (deck.manifest.requiredSectionsFailed.length > 0) {
    throw new CanonicalPrepareBlockedError(
      "REQUIRED_SECTION_FAILED",
      `required sections failed: ${deck.manifest.requiredSectionsFailed.join(", ")}`
    );
  }
  /*
   * Ворота сборки останавливают выдачу, и порог у них не один на всех.
   *
   * Прежде проверки сборки не блокировали ничего: отчёт с `passed: false`
   * уходил клиенту, и ворота были лампочкой. Блокировать текстовую эвристику
   * по любому срабатыванию тоже нельзя — ложный случай остановил бы платный
   * прогон на последнем шаге, — поэтому там решает существенность: дефект,
   * задевший три страницы и больше, означает поломку механизма.
   *
   * У структурных утверждений порога нет: слайд, объявивший таблицу без
   * строк, блокирует с первой страницы, потому что законным такое состояние
   * не бывает, а рендерер заполняет такую таблицу сам. Какой ворот с каким
   * порогом — решает `blockingIssues`, и решает в одном месте.
   */
  const blocking = deck.assemblyValidation?.blocking ?? [];
  if (blocking.length > 0) {
    throw new CanonicalPrepareBlockedError(
      "ASSEMBLY_QA_FAILED",
      `качество сборки: ${blocking.join("; ")}`
    );
  }

  const presentSlots = new Set(
    deck.assembly.deckManifest.slides.filter((s) => !s.isContinuation).map((s) => s.baseSlotId)
  );
  // Слитые слоты берутся из манифеста, а не из статического списка: слияние
  // может быть выведено при сборке (пустая поверхность печатается один раз),
  // и второй источник правды о покрытии разошёлся бы с первым — ровно тот
  // класс дефектов, что чинился в шагах 12 и 13 (шаг 15, E2).
  const coveredSlots = new Set([
    ...presentSlots,
    ...(deck.assembly.deckManifest.mergedSlots ?? []).map((m) => m.baseSlotId),
  ]);
  const missingSlots = CANONICAL_SLOT_IDS.filter((id) => !coveredSlots.has(id));
  if (missingSlots.length > 0) {
    throw new CanonicalPrepareBlockedError(
      "ASSEMBLY_FAILED",
      `baseSlotCoverage != 36; missing canonical slots: ${missingSlots.join(", ")}`
    );
  }

  // Сборка принята — и только теперь снимается стоп-маркер: снять его до
  // приговора значит погасить защиту забракованной пересборкой. Снимать
  // приходится до сверки штампа ниже: по маркеру загрузчик отказывает, и хэш
  // принятой деки оказался бы пустым.
  const staleMarkerWarning = options.answersStaleMarker
    ? clearDeckStaleMarker(input.artifactsDir)
    : null;

  const deckDir = join(input.artifactsDir, "deck");
  if (!stampAcceptedAssembly(deckDir, deck.assembly.deckManifest)) {
    return { assemblyHash: null, staleMarkerWarning };
  }
  return {
    assemblyHash:
      loadReusableAssembledDeck({
        artifactsDir: input.artifactsDir,
        caseId: input.caseId,
        expectedDatasetId: input.binding.compositeDatasetId,
      }).reused?.assemblyHash ?? null,
    staleMarkerWarning,
  };
}

function writeRenderCheckpoint(
  artifactsDir: string,
  payload: Record<string, unknown>
): void {
  writeFileSync(
    join(artifactsDir, "render-checkpoint.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
}

/**
 * Run the canonical prepare for a single unified job. Exactly one deck assembly
 * and exactly one render are performed for a successful full prepare. Render-only
 * resume reuses a valid assembled payload (assemblyCount=0) and performs one render.
 */
/**
 * Артефакт решения о персоне пишется **всегда**, в том числе когда решения нет.
 *
 * Иначе «решения в артефакте нет» получает два смысла — решения не было и
 * артефакт потерялся, — а различить их будет нечем. Поэтому отсутствие решения
 * записывается словами, а не пропуском файла; лист «Кого проверяли» при этом
 * печатается в любом случае и говорит, что решения не было.
 */
function writePersonaDecisionArtifact(
  analyticsDir: string,
  caseId: string,
  record: PersonaDecisionRecord | null
): void {
  const note = record
    ? record.decision === "PERSONA_SELECTED"
      ? "Оператор выбрал персону до начала сбора."
      : "Оператор разрешил сбор без выбора персоны: различимой персоны нет."
    : "Решения по персоне у кейса нет: панель выбора персоны не собиралась либо решение по ней " +
      "не принято. Лист «Кого проверяли» печатается всё равно и говорит об этом словами.";
  writeFileSync(
    join(analyticsDir, PERSONA_DECISION_ARTIFACT),
    `${JSON.stringify({ version: "persona-decision-v1", caseId, note, record }, null, 2)}\n`,
    "utf8"
  );
}

export async function runCanonicalReportPrepare(
  input: CanonicalPrepareInput
): Promise<CanonicalPrepareResult> {
  if (!isCanonicalPrepareEnabled()) {
    throw new CanonicalPrepareBlockedError(
      "CANONICAL_PREPARE_DISABLED",
      "ORION_CANONICAL_PREPARE=0 — canonical prepare disabled; legacy composer is never invoked"
    );
  }

  assertLineage(input);
  const subjectProfile = resolveSubjectProfile(input);
  const subjectDisplayName = input.subjectDisplayName ?? subjectProfile.displayName;

  const materialFreshness = computeMaterialFreshness(
    input.merge.observations.map((o) => o.collectedAt)
  );
  const reportDiff = buildReportDiffArtifact({
    caseId: input.caseId,
    currentJobId: input.unifiedJobId,
    currentKeys: input.merge.observations.map((o) => o.key),
  });
  mkdirSync(input.artifactsDir, { recursive: true });
  writeFileSync(
    join(input.artifactsDir, "report-diff.json"),
    `${JSON.stringify(reportDiff, null, 2)}\n`,
    "utf8"
  );
  const deckFreshnessExtras = {
    materialFreshness: materialFreshness ?? undefined,
    reportDiff:
      reportDiff.status === "OK"
        ? {
            addedCount: reportDiff.addedCount,
            removedCount: reportDiff.removedCount,
            previousJobId: reportDiff.previousJobId,
          }
        : undefined,
  };

  const analyticsDir = join(input.artifactsDir, "analytics");
  const deckDir = join(input.artifactsDir, "deck");
  const renderDir = join(input.artifactsDir, "render");
  mkdirSync(analyticsDir, { recursive: true });
  mkdirSync(renderDir, { recursive: true });
  writePersonaDecisionArtifact(analyticsDir, input.caseId, input.personaDecision ?? null);

  const resumeFrom = input.resumeFrom ?? "full";
  /*
   * Мера обязательна там, где отчёт публикуется.
   *
   * Отказ меры — громкий отказ попытки (возобновляемый, класса RENDER_FAILED),
   * а не молчаливый пропуск цикла: иначе исход сборки зависел бы от здоровья
   * рендерера невидимо. Пропуск разрешён только явному `null` — офлайн-сборкам
   * (голден-кейс, юниты), которые ничего не рендерят и не публикуют.
   */
  const resolvedMeasure =
    input.measureBulletFit === undefined
      ? createCanonicalBulletMeasureAdapter()
      : input.measureBulletFit;
  const bulletMeasure = resolvedMeasure ? measureOrFailAttempt(resolvedMeasure) : null;
  let assemblyCount = 0;
  let baseSlotCoverage = 0;
  let requiredSectionsFailed: string[] = [];
  let pageCount = 0;
  let deckManifest: ReportDeckManifest | null = null;
  let rendererSlides: RendererSlide[] | null = null;
  let assemblyHash: string | null = null;
  let rendererAssets: RendererAssetEntry[] = [];
  let visualAssetWarning: string | null = null;
  /**
   * Потери, названные самой аналитикой (`link-verdicts-lost:*`). Живут отдельно
   * от сводки качества: её запись глотает любой отказ и вернула бы `{}`, а
   * предупреждение о потерянном содержимом обязано дойти до оператора.
   */
  let analyticsQualityWarnings: string[] = [];

  /** Причина, по которой возобновление с рендера пошло в полную сборку. */
  let reuseRefusedReason: AssembledDeckRefusal | null = null;
  /** Стоп-маркер остался лежать: следующий реюз снова отобьётся по нему. */
  let staleMarkerWarning: string | null = null;

  /**
   * Чекпоинт этой попытки. Причина отказа реюза кладётся в каждую его запись —
   * и пустая тоже: попытка, не дошедшая до результата, ничего не возвращает
   * (из результата причину отдают `qualityWarnings`), а причина прошлой
   * попытки, пережившая нынешнюю, врала бы о ней.
   */
  const checkpoint = (payload: Record<string, unknown>): void =>
    writeRenderCheckpoint(input.artifactsDir, { ...payload, reuseRefusedReason });

  /** Жалобы этой попытки: они описывают её, а не прогон, и с ней же уходят. */
  const attemptWarnings = (): string[] => [
    ...(reuseRefusedReason
      ? [`${RENDER_RESUME_REASSEMBLY_WARNING_PREFIX}${reuseRefusedReason}`]
      : []),
    ...(staleMarkerWarning ? [staleMarkerWarning] : []),
  ];

  if (resumeFrom === "render") {
    const attempt = loadReusableAssembledDeck({
      artifactsDir: input.artifactsDir,
      caseId: input.caseId,
      expectedDatasetId: input.binding.compositeDatasetId,
    });
    if (attempt.reused) {
      const reused = attempt.reused;
      deckManifest = reused.deckManifest;
      rendererSlides = reused.rendererSlides;
      assemblyHash = reused.assemblyHash;
      pageCount = reused.deckManifest.pageCount;
      // Покрытие берётся из манифеста принятой деки, а не утверждается
      // константой: отчёт обязан называть то, что в нём есть.
      baseSlotCoverage = reused.deckManifest.baseSlotCoverage;
      // Reuse the job's persisted synthetic visual assets so the resumed
      // render keeps its screenshots/panels (slides reference them by ref).
      const assetsPath = join(input.artifactsDir, "report-assets.json");
      if (existsSync(assetsPath)) {
        try {
          const parsed = JSON.parse(readFileSync(assetsPath, "utf8")) as
            | RendererAssetEntry[]
            | { assets: RendererAssetEntry[] };
          rendererAssets = Array.isArray(parsed) ? parsed : parsed.assets ?? [];
        } catch {
          visualAssetWarning = "persisted report-assets.json unreadable; render resumed without visual assets";
        }
      }
      /*
       * `READY` пишется здесь, до идемпотентной проверки ниже, а та требует
       * `SUCCEEDED` — поэтому ранний возврат на пути резюме недостижим и рендер
       * выполняется всегда. Это стоит одного локального рендера при повторе
       * шага после падения воркера: денег он не стоит и детерминизма не ломает.
       */
      checkpoint({
        version: "render-checkpoint-v1",
        stage: "RENDER",
        status: "READY",
        assemblyHash,
        caseId: input.caseId,
        unifiedJobId: input.unifiedJobId,
        reusedAssembly: true,
        updatedAt: new Date().toISOString(),
      });
    } else {
      // Фолбэк в полную сборку законен, но обязан быть слышимым: причина
      // доезжает до предупреждений прогона, а оттуда — до `job.warnings`.
      reuseRefusedReason = attempt.refusedReason;
    }
    // If assembled payload is missing/corrupt, fall through to rebuild deck from
    // existing composite (never base/Arsenkin provider calls).
  }

  if (resumeFrom === "gpt-copy") {
    // Selective stage-2 retry: reuse analytics + section packs on disk.
    // Never recollect base/Arsenkin and never re-run the analytics pipeline.
    const bundlePath = join(analyticsDir, "verified-finding-bundle.json");
    if (!existsSync(bundlePath)) {
      throw new CanonicalPrepareBlockedError(
        "GPT_COPY_RESUME_INPUTS_MISSING",
        "analytics artifacts missing for gpt-copy resume"
      );
    }
    const gptCallerOnce = resolveGptCaller(input);
    if (!gptCallerOnce) {
      throw new CanonicalPrepareBlockedError(
        "GPT_COPY_CALLER_UNAVAILABLE",
        "GPT caller unavailable for gpt-copy resume"
      );
    }

    let visualAssetsBySlot: VisualAssetsBySlot = {};
    const assetsPath = join(input.artifactsDir, "report-assets.json");
    if (existsSync(assetsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(assetsPath, "utf8")) as
          | RendererAssetEntry[]
          | { assets: RendererAssetEntry[] };
        rendererAssets = Array.isArray(parsed) ? parsed : parsed.assets ?? [];
      } catch {
        visualAssetWarning =
          "persisted report-assets.json unreadable; gpt-copy resume without visual assets";
      }
    }
    const slotAssetsPath = join(input.artifactsDir, "visual-assets-by-slot.json");
    if (existsSync(slotAssetsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(slotAssetsPath, "utf8")) as {
          visualAssets?: VisualAssetsBySlot;
        };
        visualAssetsBySlot = parsed.visualAssets ?? {};
      } catch {
        // non-fatal — packs already carry slide refs
      }
    }

    const deckInputs = loadDeckInputsFromAnalyticsDir(analyticsDir);

    let caseAnalysis: GptCaseAnalysis | null = null;
    const caseAnalysisPath = join(analyticsDir, "gpt-case-analysis.json");
    if (existsSync(caseAnalysisPath)) {
      try {
        const raw = JSON.parse(readFileSync(caseAnalysisPath, "utf8")) as unknown;
        const parsed = GptCaseAnalysisSchema.safeParse(raw);
        if (parsed.success) {
          const stamp = raw as { version?: string; generatedAt?: string };
          caseAnalysis = {
            ...parsed.data,
            version: GPT_CASE_ANALYSIS_VERSION,
            generatedAt:
              typeof stamp.generatedAt === "string"
                ? stamp.generatedAt
                : new Date().toISOString(),
          };
        }
      } catch {
        caseAnalysis = null;
      }
    }

    const deck = await buildDeckUnderMeasure(() =>
      runDeckGptCopyRetry({
      ctx: {
        caseId: deckInputs.caseId,
        reportRunId: deckInputs.reportRunId,
        sourceDatasetId: deckInputs.sourceDatasetId,
        contentVersion: DECK_CONTENT_VERSION,
        subject: {
          displayName: subjectDisplayName,
          aliases: subjectProfile.aliases ?? [],
        },
        bundle: deckInputs.mergedBundle,
        surfaceUnits: deckInputs.surfaceUnits,
        metricSnapshot: deckInputs.metricSnapshot,
        evidenceIndex: deckInputs.evidenceIndex,
        extras: {
          executiveSummary: deckInputs.executiveSummary as never,
          composedClientSummary: (deckInputs.composedClientSummary as never) ?? undefined,
          visualAssets: visualAssetsBySlot,
          gptCaseAnalysis: caseAnalysis ?? undefined,
          uncategorizedMaterials: deckInputs.uncategorizedMaterials ?? undefined,
          surfaceCollectionHints: deckInputs.surfaceCollectionHints,
          complianceScreenings: deckInputs.complianceScreenings,
          personaDecision: deckInputs.personaDecision ?? undefined,
          ...deckFreshnessExtras,
        },
      },
      bundleForValidation: deckInputs.mergedBundle,
      knownEvidenceRefs: deckInputs.knownEvidenceRefs,
      outputRoot: deckDir,
      baseObservationCountBefore: deckInputs.baseCountBefore,
      baseObservationCountAfter: deckInputs.baseCountAfter,
      serpObservations: deckInputs.serpObservations,
      gpt: { caller: gptCallerOnce, caseAnalysis },
        subjectName: subjectDisplayName,
        assets: rendererAssets,
        measure: bulletMeasure,
      })
    );

    // Стоп-маркер здесь не снимается: повтор стадии 2 читает аналитику с диска
    // и новых наблюдений не видел — ответом на маркер он не является.
    assemblyHash = acceptAssembledDeck(input, deck, { answersStaleMarker: false }).assemblyHash;
    assemblyCount = 1;
    baseSlotCoverage = deck.assembly.deckManifest.baseSlotCoverage;
    requiredSectionsFailed = deck.manifest.requiredSectionsFailed;
    pageCount = deck.assembly.deckManifest.pageCount;
    deckManifest = deck.assembly.deckManifest;
    rendererSlides = deck.assembly.rendererSlides;
  }

  if (!deckManifest || !rendererSlides) {
    const baseReportRunId = input.binding.baseReportRunId ?? `${input.caseId}-base`;
    const enrichmentRunId = input.binding.enrichmentRunIds[0] ?? null;
    const serpItems = compositeObservationsToInventory({
      caseId: input.caseId,
      baseReportRunId,
      enrichmentRunId,
      observations: input.merge.observations,
    });
    const complianceItems = await resolveComplianceInventoryItems({
      caseId: input.caseId,
      reportRunId: baseReportRunId,
      complianceHits: input.complianceHits,
      prisma: input.prisma?.databaseProfile
        ? { databaseProfile: input.prisma.databaseProfile }
        : null,
    });
    const supplement = await resolveEvidenceSupplement({
      caseId: input.caseId,
      reportRunId: baseReportRunId,
      fixture: input.evidenceSupplement,
      prisma:
        input.evidenceSupplement == null &&
        (input.prisma?.wikipediaCheck || input.prisma?.serpCapture)
          ? {
              wikipediaCheck: input.prisma.wikipediaCheck,
              serpCapture: input.prisma.serpCapture,
            }
          : null,
    });
    // Итоги скринингов едут в тот же артефакт: без них страница базы не может
    // отличить «проверено, совпадений нет» от «проверка не выполнялась».
    const complianceScreenings = await resolveComplianceScreenings({
      caseId: input.caseId,
      screenings: input.complianceScreenings,
      prisma: input.prisma?.complianceScreeningRun
        ? { complianceScreeningRun: input.prisma.complianceScreeningRun }
        : null,
    });
    const items = [...serpItems, ...complianceItems, ...supplement.wikipediaItems];
    writeFileSync(
      join(analyticsDir, "compliance-inventory.json"),
      `${JSON.stringify(
        {
          version: "compliance-inventory-v1",
          caseId: input.caseId,
          count: complianceItems.length,
          items: complianceItems,
          screenings: complianceScreenings,
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    writeFileSync(
      join(analyticsDir, "evidence-supplement.json"),
      `${JSON.stringify(supplement.bundle, null, 2)}\n`,
      "utf8"
    );

    const coverageSet = new Map<string, { region: string; engine: string; surface: string }>();
    for (const obs of input.merge.observations) {
      const region = obs.region ?? "RU";
      const engine = (obs.engine ?? "").toUpperCase() || "UNKNOWN";
      const surface = observationSurfaceBucket(obs);
      coverageSet.set(`${region}|${engine}|${surface}`, { region, engine, surface });
    }
    // Наблюдения знают только о собранном. О поверхностях, вопрос о которых в
    // этом прогоне не задавали, конвейеру рассказывает состояние обогащения —
    // и только оно: спрашивать текущий состав `ARSENKIN_TOOLS` значило бы
    // переписать историю старого прогона при его пересборке.
    const coverageRows = [
      ...[...coverageSet.values()].map((c) => ({
        region: c.region,
        engine: c.engine,
        surface: c.surface,
        status: "OK",
      })),
      ...disabledSurfaceCoverageCells(
        readJsonSafe(join(input.artifactsDir, "arsenkin-enrichment-state.json"))
      ),
      // Исход пробы нейро-ответа — тем же каналом. Успех отсюда не читается:
      // иначе манифест и строки наблюдений станут двумя ответами на один
      // вопрос «собрано ли».
      ...genAnswerCoverageCells(
        readJsonSafe(join(input.artifactsDir, "base-collection-manifest.json"))
      ),
      // Комплаенс наблюдений не оставляет, поэтому о его покрытии рассказывают
      // сами итоги скринингов — иначе отказ единственной работающей базы не
      // виден ни в пробелах покрытия, ни в ограничениях резюме.
      ...complianceCoverageCells(complianceScreenings),
    ] as unknown as Parameters<typeof runOrionAnalyticsPipeline>[0]["coverageRows"];

    const analytics = await runOrionAnalyticsPipeline({
      caseId: input.caseId,
      // Идентификатор набора чеканится один раз — при слиянии; аналитика его
      // наследует во все свои артефакты и в деку.
      datasetId: input.binding.compositeDatasetId,
      inventoryReportRunId: baseReportRunId,
      items,
      binding: null,
      coverageRows,
      subjectProfile,
      artifactsDir: analyticsDir,
      // Снимки проверок Википедии — вход разбора статьи. Supplement уже здесь;
      // второй его загрузчик в аналитике был бы вторым ответом на один вопрос.
      wikipediaChecks: supplement.bundle.wikipediaChecks,
      analystOverrides: input.analystOverrides,
      analystOverridesPrisma:
        input.analystOverrides == null &&
        input.prisma?.searchResult &&
        input.prisma?.riskFinding
          ? {
              searchResult: input.prisma.searchResult,
              riskFinding: input.prisma.riskFinding,
            }
          : null,
    });
    analyticsQualityWarnings = analytics.qualityWarnings;

    // Synthetic API-derived visuals (ORION style): SERP snapshots, suggestion /
    // related / AI panels, image grids — built from the same inventory the
    // analytics consumed, with evidenceRefs binding each drawn row.
    let visualAssetsBySlot: VisualAssetsBySlot = {};
    try {
      const visuals = await buildCanonicalVisualAssets({
        subjectName: subjectDisplayName,
        items,
        // Рамку на снимке выдачи ставит прочитанная страница, а не словарь слов
        // в заголовке; легенда говорит теми же кластерными ярлыками, что резюме.
        verdictByRef: observationVerdictsForVisuals(analytics.linkVerdicts),
        // Панель рисует то, что говорит текст страницы: строка о другом лице
        // уходит на снимок нейтральной и с тегом. Решения уже посчитаны
        // аналитикой выше — второй сверки имён здесь нет.
        subjectDecisionByRef: Object.fromEntries(
          analytics.subjectResolution.items.map((i) => [i.evidenceRef, i.decision])
        ),
        realSerpScreenshots: supplement.serpScreenshots,
        // REMEDIATION §5.2 — resume/rebuild reuses URL→preview without re-fetch.
        previewCacheDir: join(input.artifactsDir, "image-preview-cache"),
      });
      rendererAssets = visuals.assets;
      visualAssetsBySlot = visuals.visualAssets;
      if (visuals.failed.length > 0) {
        const head = visuals.failed
          .slice(0, 3)
          .map((f) => `${f.slotId}:${f.reason}`)
          .join("; ");
        visualAssetWarning = `visual-asset-partial-failures:${visuals.failed.length} (${head})`;
      }
      writeFileSync(
        join(input.artifactsDir, "report-assets.json"),
        `${JSON.stringify(visuals.assets, null, 2)}\n`,
        "utf8"
      );
      writeFileSync(
        join(input.artifactsDir, "visual-assets-by-slot.json"),
        `${JSON.stringify(
          {
            counts: visuals.counts,
            visualAssets: visuals.visualAssets,
            failed: visuals.failed,
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    } catch (err) {
      // Visuals are additive: a failed synthetic asset never blocks the report,
      // slots downgrade to their honest text/empty-state templates.
      // SHARP_UNAVAILABLE is raised once (§5.1), not N times per asset.
      visualAssetWarning = `visual asset build failed: ${err instanceof Error ? err.message : String(err)}`;
      rendererAssets = [];
      visualAssetsBySlot = {};
    }

    const deckInputs = loadDeckInputsFromAnalyticsDir(analyticsDir);

    // GPT layer (fail-safe): stage 1 analyzes the WHOLE verified corpus and
    // stage 2 rewrites per-slide client copy grounded in that analysis. Any
    // failure keeps the deterministic report.
    let gptLayer: GptDeckLayer | null = null;
    const gptCallerOnce = resolveGptCaller(input);
    if (gptCallerOnce) {
      // Stage 1 owns its queue (single or map-reduce §4.4). Stage 2 keeps a
      // separate once-caller — enhanceSectionPacksWithGptCopy owns that queue.
      let caseAnalysisFailure: string | null = null;
      // Box: TS does not track assignments inside onDiagnostics for narrowing.
      const stage1DiagBox: { current: GptCaseAnalysisDiagnostics | null } = {
        current: null,
      };
      const caseAnalysis = await runGptCaseAnalysis({
        caller: gptCallerOnce,
        // Уровень риска считает аналитика; модель его объясняет, а не выводит
        // собственный — иначе плашка и текст резюме называют разные оценки
        // (шаг 07.9).
        deterministicVerdict:
          (deckInputs.executiveSummary as { verdict?: string } | undefined)?.verdict ?? null,
        subjectName: subjectDisplayName,
        aliases: subjectProfile.aliases ?? [],
        contextIdentifiers: subjectProfile.contextIdentifiers ?? [],
        bundle: deckInputs.mergedBundle,
        surfaceUnits: deckInputs.surfaceUnits,
        metricSnapshot: deckInputs.metricSnapshot,
        onFailure: (reason) => {
          caseAnalysisFailure = reason;
        },
        onDiagnostics: (d) => {
          stage1DiagBox.current = d;
        },
      });
      const stage1Diagnostics = stage1DiagBox.current;
      // REMEDIATION §4.5 — truncation bumps from openai-json-client (if used live).
      let truncationRetries = 0;
      try {
        const { consumeOpenAiTruncationRetryCount } = await import(
          "../orion-golden/gpt/openai-json-client"
        );
        truncationRetries = consumeOpenAiTruncationRetryCount();
      } catch {
        truncationRetries = 0;
      }
      if (caseAnalysis) {
        writeFileSync(
          join(analyticsDir, "gpt-case-analysis.json"),
          `${JSON.stringify(caseAnalysis, null, 2)}\n`,
          "utf8"
        );
        // Persist map-reduce / truncation observability on success when useful.
        if (
          truncationRetries > 0 ||
          (stage1Diagnostics &&
            (stage1Diagnostics.mode === "map_reduce" ||
              (stage1Diagnostics.mapFailures?.length ?? 0) > 0))
        ) {
          writeFileSync(
            join(analyticsDir, "gpt-case-analysis-diagnostics.json"),
            `${JSON.stringify(
              {
                status: "APPLIED",
                ...(stage1Diagnostics ?? {}),
                ...(truncationRetries > 0
                  ? { truncationRetries }
                  : {}),
                at: new Date().toISOString(),
              },
              null,
              2
            )}\n`,
            "utf8"
          );
        }
      } else {
        // The fail-safe path used to be silent (caseAnalysisUsed:false with no
        // trace); persist the reason so operators can see why GPT stage 1 fell
        // back to the deterministic report.
        writeFileSync(
          join(analyticsDir, "gpt-case-analysis-diagnostics.json"),
          `${JSON.stringify(
            {
              status: "FAILED",
              reason: caseAnalysisFailure ?? "unknown",
              ...(stage1Diagnostics ?? {}),
              ...(truncationRetries > 0 ? { truncationRetries } : {}),
              at: new Date().toISOString(),
            },
            null,
            2
          )}\n`,
          "utf8"
        );
      }
      gptLayer = { caller: gptCallerOnce, caseAnalysis };
    }

    // Full prepare always re-runs GPT stage 2. SKIPPED_CACHED is reserved for
    // selective resumeFrom:"gpt-copy" (FALLBACK_* retry). A file marker alone
    // was not enough — live rebuilds still showed «применено 0 · кэш N».
    const forceGptCopyPath = join(input.artifactsDir, "force-gpt-copy.json");
    const forceGptCopy = true;

    const deck = await buildDeckUnderMeasure(() =>
      runDeckBuildWithGptCopy({
      ctx: {
        caseId: deckInputs.caseId,
        reportRunId: deckInputs.reportRunId,
        sourceDatasetId: deckInputs.sourceDatasetId,
        contentVersion: DECK_CONTENT_VERSION,
        subject: { displayName: subjectDisplayName, aliases: subjectProfile.aliases ?? [] },
        bundle: deckInputs.mergedBundle,
        surfaceUnits: deckInputs.surfaceUnits,
        metricSnapshot: deckInputs.metricSnapshot,
        evidenceIndex: deckInputs.evidenceIndex,
        extras: {
          executiveSummary: deckInputs.executiveSummary as never,
          composedClientSummary: (deckInputs.composedClientSummary as never) ?? undefined,
          visualAssets: visualAssetsBySlot,
          // Sanitized stage-1 analysis feeds deterministic builders too:
          // executive summary narrative/cards and risk-matrix explanations.
          gptCaseAnalysis: gptLayer?.caseAnalysis ?? undefined,
          uncategorizedMaterials: deckInputs.uncategorizedMaterials ?? undefined,
          surfaceCollectionHints: deckInputs.surfaceCollectionHints,
          complianceScreenings: deckInputs.complianceScreenings,
          personaDecision: deckInputs.personaDecision ?? undefined,
          ...deckFreshnessExtras,
        },
      },
      bundleForValidation: deckInputs.mergedBundle,
      knownEvidenceRefs: deckInputs.knownEvidenceRefs,
      outputRoot: deckDir,
      baseObservationCountBefore: deckInputs.baseCountBefore,
      baseObservationCountAfter: deckInputs.baseCountAfter,
      serpObservations: deckInputs.serpObservations,
      gpt: gptLayer,
      forceGptCopy,
        subjectName: subjectDisplayName,
        assets: rendererAssets,
        measure: bulletMeasure,
      })
    );
    if (existsSync(forceGptCopyPath)) {
      try {
        unlinkSync(forceGptCopyPath);
      } catch {
        // Marker cleanup must not fail the report.
      }
    }
    // Пересборка прочла наблюдения заново — она и есть ответ на стоп-маркер,
    // но отвечает им только принятая сборка.
    const accepted = acceptAssembledDeck(input, deck, { answersStaleMarker: true });
    assemblyHash = accepted.assemblyHash;
    staleMarkerWarning = accepted.staleMarkerWarning;
    assemblyCount = 1;
    baseSlotCoverage = deck.assembly.deckManifest.baseSlotCoverage;
    requiredSectionsFailed = deck.manifest.requiredSectionsFailed;
    pageCount = deck.assembly.deckManifest.pageCount;
    deckManifest = deck.assembly.deckManifest;
    rendererSlides = deck.assembly.rendererSlides;
  }

  // Idempotent: prior successful render artifacts for the same assembly hash.
  const priorPdf = join(renderDir, "rendered-client.pdf");
  const priorPptx = join(renderDir, "rendered-client.pptx");
  const priorMetaPath = join(renderDir, "golden-render-meta.json");
  const checkpointPath = join(input.artifactsDir, "render-checkpoint.json");
  if (existsSync(priorPdf) && existsSync(priorPptx) && existsSync(checkpointPath)) {
    try {
      const cp = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
        status?: string;
        assemblyHash?: string;
      };
      // Суд телеметрии до раннего возврата. Отказ суда — не провал прогона, а
      // «реюзу нельзя»: ниже пойдёт обычный ре-рендер, и судить будут уже его.
      // Иначе прежний рендер без телеметрии (сделанный до появления ворот)
      // проскальзывал бы мимо них вечно.
      const reuseVerdict =
        cp.status === "SUCCEEDED" && assemblyHash && cp.assemblyHash === assemblyHash
          ? judgeRenderTelemetry(renderDir, {
              compliancePages: compliancePagesOf(deckManifest),
            })
          : null;
      if (reuseVerdict && !reuseVerdict.blocker) {
        checkpoint({
          ...cp,
          status: "SUCCEEDED",
          idempotentReuse: true,
          updatedAt: new Date().toISOString(),
        });
        const quality = await writeReportQualityArtifact(input, { visualAssetWarning });
        return {
          ok: true,
          prepareDatasetId: input.binding.compositeDatasetId,
          analyticsDir,
          deckDir,
          renderDir,
          pdf: priorPdf,
          pptx: priorPptx,
          pngDir: existsSync(join(renderDir, "pages-png")) ? join(renderDir, "pages-png") : undefined,
          pageCount,
          assemblyCount,
          renderCount: 1,
          baseSlotCoverage,
          requiredSectionsFailed,
          ...quality,
          qualityWarnings: [
            ...analyticsQualityWarnings,
            ...attemptWarnings(),
            ...reuseVerdict.warnings,
            ...(quality.qualityWarnings ?? []),
          ],
        };
      }
    } catch {
      /* continue to render */
    }
  }

  checkpoint({
    version: "render-checkpoint-v1",
    stage: "RENDER",
    status: "IN_PROGRESS",
    assemblyHash,
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId,
    updatedAt: new Date().toISOString(),
  });

  if (!deckManifest || !rendererSlides) {
    throw new CanonicalPrepareBlockedError(
      "ASSEMBLY_FAILED",
      "assembled deck payload missing before render"
    );
  }

  const render = input.render ?? renderCanonicalDeck;
  let rendered: Awaited<ReturnType<DeckRenderAdapter>>;
  try {
    rendered = await render({
      deckManifest,
      rendererSlides,
      subjectName: subjectDisplayName,
      assets: rendererAssets,
      outputRoot: renderDir,
    });
  } catch (err) {
    /*
     * Прогон без меры собирает нагрузку впервые здесь, и отказ сборки пришёл бы
     * сюда: назвать его сбоем рендерера значило бы предложить повтор там, где
     * повтор не лечит. Чекпойнт стадии закрывается и на этом выходе — иначе он
     * единственный, который оставляет стадию открытой.
     */
    const blocked = prepareBlockedErrorFor(err);
    if (blocked) {
      checkpoint({
        version: "render-checkpoint-v1",
        stage: "RENDER",
        status: "FAILED",
        assemblyHash,
        caseId: input.caseId,
        unifiedJobId: input.unifiedJobId,
        errorCode: blocked.code,
        updatedAt: new Date().toISOString(),
      });
      throw blocked;
    }
    const safe = sanitizeRendererClientError(
      err instanceof Error ? err.message : String(err)
    );
    checkpoint({
      version: "render-checkpoint-v1",
      stage: "RENDER",
      status: "FAILED",
      assemblyHash,
      caseId: input.caseId,
      unifiedJobId: input.unifiedJobId,
      errorCode: "RENDER_FAILED",
      updatedAt: new Date().toISOString(),
    });
    throw new CanonicalPrepareBlockedError("RENDER_FAILED", `render failed: ${safe}`);
  }

  /*
   * Один ответ на вопрос «состоялся ли настоящий рендер»: адаптер называет
   * себя сам, и офлайн-фейк подготовки объявляет себя фейком. Настоящий
   * рендерер обязан положить клиентские файлы на диск и обязан отчитаться
   * телеметрией; с фейка не требуют ни того, ни другого — рендера не было,
   * терять было нечего. Пока ответов было два (имя адаптера для одного
   * требования, файлы на диске для другого), они расходились на фейке,
   * который файлы всё-таки оставил.
   */
  const isOfflineFake = /^fake\b/i.test(rendered.renderer ?? "");
  let renderTelemetryWarnings: string[] = [];
  if (!isOfflineFake) {
    if (!rendered.pdf && !rendered.pptx) {
      checkpoint({
        version: "render-checkpoint-v1",
        stage: "RENDER",
        status: "FAILED",
        assemblyHash,
        errorCode: "RENDER_FAILED",
        updatedAt: new Date().toISOString(),
      });
      throw new CanonicalPrepareBlockedError(
        "RENDER_FAILED",
        "render failed: renderer returned no client artifacts"
      );
    }

    // Ворота потерь. Порогов здесь нет: их знает общий классификатор строк
    // телеметрии, и правило блокировки описано в `render-telemetry-gate.ts`.
    const verdict = judgeRenderTelemetry(renderDir, {
      compliancePages: compliancePagesOf(deckManifest),
    });
    if (verdict.blocker) {
      checkpoint({
        version: "render-checkpoint-v1",
        stage: "RENDER",
        status: "FAILED",
        assemblyHash,
        caseId: input.caseId,
        unifiedJobId: input.unifiedJobId,
        errorCode: verdict.blocker,
        updatedAt: new Date().toISOString(),
      });
      throw new CanonicalPrepareBlockedError(verdict.blocker, verdict.detail);
    }
    renderTelemetryWarnings = verdict.warnings;

    // Суд пройден — только теперь черновики рендера занимают конечные имена и
    // становятся скачиваемым документом. Забракованный рендер остаётся
    // черновиком: принятый прежде отчёт переживает неудачную пересборку.
    rendered = publishRenderedClientArtifacts(renderDir, rendered);
  }

  const renderCount = 1;
  checkpoint({
    version: "render-checkpoint-v1",
    stage: "RENDER",
    status: "SUCCEEDED",
    assemblyHash,
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId,
    renderer: rendered.renderer,
    meta: existsSync(priorMetaPath) ? "golden-render-meta.json" : null,
    updatedAt: new Date().toISOString(),
  });

  const summary = {
    version: "canonical-prepare-summary-v1",
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId,
    prepareDatasetId: input.binding.compositeDatasetId,
    pageCount,
    renderedPageCount: rendered.pageCount,
    assemblyCount,
    renderCount,
    renderer: rendered.renderer,
    resumeFrom,
    visualAssetCount: rendererAssets.length,
    visualAssetWarning,
    pdf: rendered.pdf ?? null,
    pptx: rendered.pptx ?? null,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(input.artifactsDir, "canonical-prepare-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8"
  );

  const quality = await writeReportQualityArtifact(input, { visualAssetWarning });

  return {
    ok: true,
    prepareDatasetId: input.binding.compositeDatasetId,
    analyticsDir,
    deckDir,
    renderDir,
    pdf: rendered.pdf,
    pptx: rendered.pptx,
    pngDir: rendered.pngDir,
    contactSheet: rendered.contactSheet,
    pageCount,
    assemblyCount,
    renderCount,
    baseSlotCoverage,
    requiredSectionsFailed,
    ...quality,
    // Потери аналитики не зависят от того, записалась ли сводка качества.
    qualityWarnings: [
      ...analyticsQualityWarnings,
      ...attemptWarnings(),
      ...renderTelemetryWarnings,
      ...(quality.qualityWarnings ?? []),
    ],
  };
}
