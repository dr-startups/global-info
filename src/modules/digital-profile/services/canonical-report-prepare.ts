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
  type GptDeckLayer,
} from "../orion-golden/deck-sections/gpt-enhanced-deck-build";
import { loadDeckInputsFromAnalyticsDir } from "../orion-golden/deck-sections/load-deck-inputs";
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
  MERGED_SLOT_IDS,
} from "../orion-golden/deck-sections/canonical-slots";
import type { ReportDeckManifest } from "../orion-golden/deck-sections/contracts";
import type { RendererSlide } from "../orion-golden/deck-sections/deck-assembler";
import {
  renderCanonicalDeck,
  sanitizeRendererClientError,
  type DeckRenderAdapter,
} from "./render-deck-artifacts";
import type { CompositeMergeResult, CompositeObservation } from "./composite-serp-merge";
import type { ReportDataBinding } from "./unified-collection-types";
import { mapSurfaceBucket } from "../orion-golden/classic/composite-serp-overlay-merge";
import type { RendererAssetEntry } from "../orion-golden/deck-sections/run-deck-build";
import type { VisualAssetsBySlot } from "../orion-golden/deck-sections/canonical-slots";
import { buildCanonicalVisualAssets } from "./canonical-visual-assets";
import {
  buildReportQualitySummary,
  buildReportQualityWarnings,
  toJobReportQuality,
  type JobReportQuality,
  type ReportQualityPrismaCounts,
  type ReportQualitySummary,
} from "./report-quality-summary";
import {
  resolveComplianceInventoryItems,
  type ComplianceInventoryPrisma,
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
  | "REQUIRED_SECTION_FAILED"
  | "RENDER_FAILED"
  | "GPT_COPY_RESUME_INPUTS_MISSING"
  | "GPT_COPY_CALLER_UNAVAILABLE";

export class CanonicalPrepareBlockedError extends Error {
  code: CanonicalPrepareBlockerCode;
  constructor(code: CanonicalPrepareBlockerCode, message: string) {
    super(message);
    this.name = "CanonicalPrepareBlockedError";
    this.code = code;
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
  /** Offline/fixture analyst overrides (§1.3). When set, skips prisma load. */
  analystOverrides?: AnalystOverridesBundle | null;
  /** Offline/fixture WikipediaCheck + SERP screenshots (§1.4). */
  evidenceSupplement?: EvidenceSupplementBundle | null;
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
        queryText: obs.query,
        provider,
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

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Load and validate assembled deck artifacts for render-only resume. */
export function loadReusableAssembledDeck(input: {
  artifactsDir: string;
  caseId: string;
  expectedDatasetId: string;
}): AssembledDeckReuse | null {
  const deckDir = join(input.artifactsDir, "deck");
  const assembledPath = join(deckDir, "assembled-deck.json");
  const manifestPath = join(deckDir, "report-deck-manifest.json");
  if (!existsSync(assembledPath) || !existsSync(manifestPath)) return null;
  try {
    const assembled = JSON.parse(readFileSync(assembledPath, "utf8")) as {
      caseId?: string;
      reportRunId?: string;
      datasetId?: string;
      sourceDatasetId?: string;
      slides?: RendererSlide[];
    };
    const deckManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReportDeckManifest;
    const datasetId = String(assembled.datasetId ?? assembled.sourceDatasetId ?? "");
    if (assembled.caseId !== input.caseId) return null;
    if (datasetId && datasetId !== input.expectedDatasetId) return null;
    if (!Array.isArray(assembled.slides) || assembled.slides.length === 0) return null;
    if (!deckManifest?.pageCount || deckManifest.pageCount <= 0) return null;
    const assemblyHash = createHash("sha256")
      .update(hashFile(assembledPath))
      .update(hashFile(manifestPath))
      .digest("hex");
    return {
      deckManifest,
      rendererSlides: assembled.slides,
      assemblyHash,
      caseId: assembled.caseId,
      reportRunId: String(assembled.reportRunId ?? ""),
      datasetId,
    };
  } catch {
    return null;
  }
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

  const resumeFrom = input.resumeFrom ?? "full";
  let assemblyCount = 0;
  let baseSlotCoverage = 0;
  let requiredSectionsFailed: string[] = [];
  let pageCount = 0;
  let analyticsDatasetId = input.binding.compositeDatasetId;
  let deckManifest: ReportDeckManifest | null = null;
  let rendererSlides: RendererSlide[] | null = null;
  let assemblyHash: string | null = null;
  let rendererAssets: RendererAssetEntry[] = [];
  let visualAssetWarning: string | null = null;

  if (resumeFrom === "render") {
    const reused = loadReusableAssembledDeck({
      artifactsDir: input.artifactsDir,
      caseId: input.caseId,
      expectedDatasetId: input.binding.compositeDatasetId,
    });
    if (reused) {
      deckManifest = reused.deckManifest;
      rendererSlides = reused.rendererSlides;
      assemblyHash = reused.assemblyHash;
      pageCount = reused.deckManifest.pageCount;
      baseSlotCoverage = CANONICAL_SLOT_IDS.length;
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
      writeRenderCheckpoint(input.artifactsDir, {
        version: "render-checkpoint-v1",
        stage: "RENDER",
        status: "READY",
        assemblyHash,
        caseId: input.caseId,
        unifiedJobId: input.unifiedJobId,
        reusedAssembly: true,
        updatedAt: new Date().toISOString(),
      });
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
    analyticsDatasetId = deckInputs.sourceDatasetId;

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

    const deck = await runDeckGptCopyRetry({
      ctx: {
        caseId: deckInputs.caseId,
        reportRunId: deckInputs.reportRunId,
        sourceDatasetId: deckInputs.sourceDatasetId,
        contentVersion: "deck-sections-v24",
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
          visualAssets: visualAssetsBySlot,
          gptCaseAnalysis: caseAnalysis ?? undefined,
          uncategorizedMaterials: deckInputs.uncategorizedMaterials ?? undefined,
          surfaceCollectionHints: deckInputs.surfaceCollectionHints,
          ...deckFreshnessExtras,
        },
      },
      bundleForValidation: deckInputs.mergedBundle,
      knownEvidenceRefs: deckInputs.knownEvidenceRefs,
      outputRoot: deckDir,
      baseObservationCountBefore: deckInputs.baseCountBefore,
      baseObservationCountAfter: deckInputs.baseCountAfter,
      gpt: { caller: gptCallerOnce, caseAnalysis },
    });

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

    const presentSlots = new Set(
      deck.assembly.deckManifest.slides
        .filter((s) => !s.isContinuation)
        .map((s) => s.baseSlotId)
    );
    const coveredSlots = new Set([...presentSlots, ...MERGED_SLOT_IDS]);
    const missingSlots = CANONICAL_SLOT_IDS.filter((id) => !coveredSlots.has(id));
    if (missingSlots.length > 0) {
      throw new CanonicalPrepareBlockedError(
        "ASSEMBLY_FAILED",
        `baseSlotCoverage != 36; missing canonical slots: ${missingSlots.join(", ")}`
      );
    }

    assemblyCount = 1;
    baseSlotCoverage = CANONICAL_SLOT_IDS.length;
    requiredSectionsFailed = deck.manifest.requiredSectionsFailed;
    pageCount = deck.assembly.deckManifest.pageCount;
    deckManifest = deck.assembly.deckManifest;
    rendererSlides = deck.assembly.rendererSlides;
    const reusedCheck = loadReusableAssembledDeck({
      artifactsDir: input.artifactsDir,
      caseId: input.caseId,
      expectedDatasetId: input.binding.compositeDatasetId,
    });
    assemblyHash = reusedCheck?.assemblyHash ?? null;
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
    const items = [...serpItems, ...complianceItems, ...supplement.wikipediaItems];
    writeFileSync(
      join(analyticsDir, "compliance-inventory.json"),
      `${JSON.stringify(
        {
          version: "compliance-inventory-v1",
          caseId: input.caseId,
          count: complianceItems.length,
          items: complianceItems,
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
    const coverageRows = [...coverageSet.values()].map((c) => ({
      region: c.region,
      engine: c.engine,
      surface: c.surface,
      status: "OK",
    })) as unknown as Parameters<typeof runOrionAnalyticsPipeline>[0]["coverageRows"];

    await runOrionAnalyticsPipeline({
      caseId: input.caseId,
      inventoryReportRunId: baseReportRunId,
      items,
      binding: null,
      coverageRows,
      subjectProfile,
      artifactsDir: analyticsDir,
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

    // Synthetic API-derived visuals (ORION style): SERP snapshots, suggestion /
    // related / AI panels, image grids — built from the same inventory the
    // analytics consumed, with evidenceRefs binding each drawn row.
    let visualAssetsBySlot: VisualAssetsBySlot = {};
    try {
      const visuals = await buildCanonicalVisualAssets({
        subjectName: subjectDisplayName,
        items,
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
    analyticsDatasetId = deckInputs.sourceDatasetId;

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

    const deck = await runDeckBuildWithGptCopy({
      ctx: {
        caseId: deckInputs.caseId,
        reportRunId: deckInputs.reportRunId,
        sourceDatasetId: deckInputs.sourceDatasetId,
        contentVersion: "deck-sections-v24",
        subject: { displayName: subjectDisplayName, aliases: subjectProfile.aliases ?? [] },
        bundle: deckInputs.mergedBundle,
        surfaceUnits: deckInputs.surfaceUnits,
        metricSnapshot: deckInputs.metricSnapshot,
        evidenceIndex: deckInputs.evidenceIndex,
        extras: {
          executiveSummary: deckInputs.executiveSummary as never,
          visualAssets: visualAssetsBySlot,
          // Sanitized stage-1 analysis feeds deterministic builders too:
          // executive summary narrative/cards and risk-matrix explanations.
          gptCaseAnalysis: gptLayer?.caseAnalysis ?? undefined,
          uncategorizedMaterials: deckInputs.uncategorizedMaterials ?? undefined,
          surfaceCollectionHints: deckInputs.surfaceCollectionHints,
          ...deckFreshnessExtras,
        },
      },
      bundleForValidation: deckInputs.mergedBundle,
      knownEvidenceRefs: deckInputs.knownEvidenceRefs,
      outputRoot: deckDir,
      baseObservationCountBefore: deckInputs.baseCountBefore,
      baseObservationCountAfter: deckInputs.baseCountAfter,
      gpt: gptLayer,
      forceGptCopy,
    });
    if (existsSync(forceGptCopyPath)) {
      try {
        unlinkSync(forceGptCopyPath);
      } catch {
        // Marker cleanup must not fail the report.
      }
    }
    assemblyCount = 1;

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

    const presentSlots = new Set(
      deck.assembly.deckManifest.slides.filter((s) => !s.isContinuation).map((s) => s.baseSlotId)
    );
    const coveredSlots = new Set([...presentSlots, ...MERGED_SLOT_IDS]);
    const missingSlots = CANONICAL_SLOT_IDS.filter((id) => !coveredSlots.has(id));
    if (missingSlots.length > 0) {
      throw new CanonicalPrepareBlockedError(
        "ASSEMBLY_FAILED",
        `baseSlotCoverage != 36; missing canonical slots: ${missingSlots.join(", ")}`
      );
    }
    baseSlotCoverage = CANONICAL_SLOT_IDS.length;
    requiredSectionsFailed = deck.manifest.requiredSectionsFailed;
    pageCount = deck.assembly.deckManifest.pageCount;
    deckManifest = deck.assembly.deckManifest;
    rendererSlides = deck.assembly.rendererSlides;
    const reusedCheck = loadReusableAssembledDeck({
      artifactsDir: input.artifactsDir,
      caseId: input.caseId,
      expectedDatasetId: input.binding.compositeDatasetId,
    });
    assemblyHash = reusedCheck?.assemblyHash ?? null;
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
      if (cp.status === "SUCCEEDED" && assemblyHash && cp.assemblyHash === assemblyHash) {
        writeRenderCheckpoint(input.artifactsDir, {
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
        };
      }
    } catch {
      /* continue to render */
    }
  }

  writeRenderCheckpoint(input.artifactsDir, {
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
    const safe = sanitizeRendererClientError(
      err instanceof Error ? err.message : String(err)
    );
    writeRenderCheckpoint(input.artifactsDir, {
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

  // Real HTTP/local adapters must produce client files. Injected offline fakes
  // may return pageCount/renderer only (no on-disk PDF/PPTX).
  const isOfflineFake = /^fake\b/i.test(rendered.renderer ?? "");
  if (!rendered.pdf && !rendered.pptx && !isOfflineFake) {
    writeRenderCheckpoint(input.artifactsDir, {
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

  const renderCount = 1;
  writeRenderCheckpoint(input.artifactsDir, {
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
    analyticsDatasetId,
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
  };
}
