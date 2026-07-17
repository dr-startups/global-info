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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RawInventoryItem } from "../orion-golden/types";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import { runOrionAnalyticsPipeline } from "../orion-golden/analytics/run-analytics-pipeline";
import { runDeckBuild } from "../orion-golden/deck-sections/run-deck-build";
import { loadDeckInputsFromAnalyticsDir } from "../orion-golden/deck-sections/load-deck-inputs";
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

export type CanonicalPrepareBlockerCode =
  | "CANONICAL_PREPARE_DISABLED"
  | "PREPARE_INPUT_MISSING"
  | "FOREIGN_ARTIFACT"
  | "STALE_ARTIFACT"
  | "SUBJECT_PROFILE_MISSING"
  | "ASSEMBLY_FAILED"
  | "REQUIRED_SECTION_FAILED"
  | "RENDER_FAILED";

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
   * `render` — reuse valid assembled deck artifacts; skip analytics/SectionPacks/assembly.
   * `full` (default) — run the complete prepare pipeline.
   */
  resumeFrom?: "full" | "render";
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
};

const SUBJECT_PROFILE_FILE = "subject-identity-profile.json";

/** Canonical prepare is on unless explicitly disabled. */
export function isCanonicalPrepareEnabled(): boolean {
  return String(process.env.ORION_CANONICAL_PREPARE ?? "1") !== "0";
}

function mapKindToEvidenceType(kind: CompositeObservation["kind"]): string {
  switch (kind) {
    case "suggestion":
      return "suggestion";
    case "paa":
      return "related_query";
    default:
      return "search_result";
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
      collectedAt: new Date(0).toISOString(),
      evidenceType: mapKindToEvidenceType(obs.kind),
      title: text || obs.title || obs.url || obs.key,
      snippet: obs.snippet ?? "",
      sourceUrl: obs.url ?? (isArsenkin ? `arsenkin://${obs.kind}/${inventoryId}` : undefined),
      classification: obs.riskLabel ?? undefined,
      rawMetadata: {
        engine: obs.engine,
        surface: mapKindToSurface(obs.kind),
        queryText: obs.query,
        provider,
      },
    } satisfies RawInventoryItem;
  });
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

  if (!deckManifest || !rendererSlides) {
    const baseReportRunId = input.binding.baseReportRunId ?? `${input.caseId}-base`;
    const enrichmentRunId = input.binding.enrichmentRunIds[0] ?? null;
    const items = compositeObservationsToInventory({
      caseId: input.caseId,
      baseReportRunId,
      enrichmentRunId,
      observations: input.merge.observations,
    });

    const coverageSet = new Map<string, { region: string; engine: string; surface: string }>();
    for (const obs of input.merge.observations) {
      const region = obs.region ?? "RU";
      const engine = (obs.engine ?? "").toUpperCase() || "UNKNOWN";
      const surface = mapKindToSurface(obs.kind);
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
    });

    const deckInputs = loadDeckInputsFromAnalyticsDir(analyticsDir);
    analyticsDatasetId = deckInputs.sourceDatasetId;
    const deck = runDeckBuild({
      ctx: {
        caseId: deckInputs.caseId,
        reportRunId: deckInputs.reportRunId,
        sourceDatasetId: deckInputs.sourceDatasetId,
        contentVersion: "deck-sections-v14",
        subject: { displayName: subjectDisplayName, aliases: subjectProfile.aliases ?? [] },
        bundle: deckInputs.mergedBundle,
        surfaceUnits: deckInputs.surfaceUnits,
        metricSnapshot: deckInputs.metricSnapshot,
        evidenceIndex: deckInputs.evidenceIndex,
        extras: { executiveSummary: deckInputs.executiveSummary as never, visualAssets: {} },
      },
      bundleForValidation: deckInputs.mergedBundle,
      knownEvidenceRefs: deckInputs.knownEvidenceRefs,
      outputRoot: deckDir,
      baseObservationCountBefore: deckInputs.baseCountBefore,
      baseObservationCountAfter: deckInputs.baseCountAfter,
    });
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
      assets: [],
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
    pdf: rendered.pdf ?? null,
    pptx: rendered.pptx ?? null,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(input.artifactsDir, "canonical-prepare-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8"
  );

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
  };
}
