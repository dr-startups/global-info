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
import { renderDeckWithPython, type DeckRenderAdapter } from "./render-deck-artifacts";
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
  /** Injectable renderer; defaults to the existing local python renderer. */
  render?: DeckRenderAdapter;
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

/**
 * Run the canonical prepare for a single unified job. Exactly one deck assembly
 * and exactly one render are performed for a successful prepare.
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

  const baseReportRunId = input.binding.baseReportRunId ?? `${input.caseId}-base`;
  const enrichmentRunId = input.binding.enrichmentRunIds[0] ?? null;
  const items = compositeObservationsToInventory({
    caseId: input.caseId,
    baseReportRunId,
    enrichmentRunId,
    observations: input.merge.observations,
  });

  // Coverage rows from the merged surfaces actually present in the composite.
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

  // 1. Analytics pipeline (composite -> resolution -> surfaces -> findings -> summary).
  await runOrionAnalyticsPipeline({
    caseId: input.caseId,
    inventoryReportRunId: baseReportRunId,
    items,
    binding: null,
    coverageRows,
    subjectProfile,
    artifactsDir: analyticsDir,
  });

  // 2. Deterministic deck build (SectionPacks -> manifest -> DeckAssembler).
  const deckInputs = loadDeckInputsFromAnalyticsDir(analyticsDir);
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
  const assemblyCount = 1;

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

  // baseSlotCoverage=36: every canonical slot is physically present or explicitly merged.
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
  const baseSlotCoverage = CANONICAL_SLOT_IDS.length;

  // 3. Exactly one render through the (injectable) renderer.
  const render = input.render ?? renderDeckWithPython;
  let rendered: Awaited<ReturnType<DeckRenderAdapter>>;
  try {
    rendered = await render({
      deckManifest: deck.assembly.deckManifest,
      rendererSlides: deck.assembly.rendererSlides,
      subjectName: subjectDisplayName,
      assets: [],
      outputRoot: renderDir,
    });
  } catch (err) {
    throw new CanonicalPrepareBlockedError(
      "RENDER_FAILED",
      `render failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const renderCount = 1;

  const summary = {
    version: "canonical-prepare-summary-v1",
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId,
    prepareDatasetId: input.binding.compositeDatasetId,
    analyticsDatasetId: deckInputs.sourceDatasetId,
    pageCount: deck.assembly.deckManifest.pageCount,
    renderedPageCount: rendered.pageCount,
    assemblyCount,
    renderCount,
    renderer: rendered.renderer,
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
    pageCount: deck.assembly.deckManifest.pageCount,
    assemblyCount,
    renderCount,
    baseSlotCoverage,
    requiredSectionsFailed: deck.manifest.requiredSectionsFailed,
  };
}
