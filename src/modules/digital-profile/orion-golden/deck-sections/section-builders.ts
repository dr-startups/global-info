/**
 * Independent section builders. Every fragment is built from its own scoped
 * input and persisted as a standalone SectionPack; unchanged fragments are
 * reused by inputHash + promptVersion without regeneration.
 */

import { createHash } from "node:crypto";
import type { FragmentKey, SectionPackV2, SectionType } from "./contracts";
import { SECTION_PACK_SCHEMA_VERSION } from "./contracts";
import { getFragmentPrompt } from "./prompts";
import {
  buildScopedInput,
  scopedInputHash,
  type FragmentScope,
  type MetricSnapshot,
  type ScopedEvidenceIndex,
  type ScopedFragmentInput,
  type SubjectProfileInput,
} from "./scoped-input";
import {
  buildAppendixFragment,
  buildComplianceFragment,
  buildDigitalProfileOverviewFragment,
  buildExecutiveSummaryFragment,
  buildFrontMatterFragment,
  buildIdentityFragment,
  buildImagesFragment,
  buildKnowledgeAiFragment,
  buildRegionalSummaryFragment,
  buildRelatedQueriesFragment,
  buildRiskMatrixFragment,
  buildSerpFragment,
  buildSerpScreenshotFragment,
  buildSuggestionsFragment,
  type FragmentBuildOutput,
  type FragmentExtras,
} from "./fragment-builders";
import { slotsForFragment } from "./canonical-slots";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { Finding } from "../contracts/finding";
import type { SurfaceAnalysisUnit } from "../contracts/surface-analysis";
import type { SurfaceKind } from "../contracts/common";

export type SectionBuildContext = {
  caseId: string;
  reportRunId: string;
  sourceDatasetId: string;
  contentVersion: string;
  subject: SubjectProfileInput;
  bundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
  evidenceIndex: ScopedEvidenceIndex;
  extras: FragmentExtras;
  /** Previously persisted packs for cache reuse (contentHash/inputHash). */
  previousPacks?: Map<FragmentKey, SectionPackV2>;
  /** Build log: which fragments were regenerated vs reused. */
  buildLog?: Array<{ fragmentKey: FragmentKey; action: "REGENERATED" | "REUSED_CACHE" }>;
};

const RISK_ORDER: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
// Related-queries fragments own canonical base slots (p20..p22, p32) and are
// therefore required; only the appendix has no canonical slot.
const OPTIONAL_FRAGMENTS: FragmentKey[] = ["APPENDIX_MAIN"];

function fragmentScope(key: FragmentKey): FragmentScope {
  const ruScope = (surfaces: SurfaceKind[] | null): FragmentScope => ({
    regions: ["RU"],
    surfaces,
    subjectMatch: ["SUBJECT_MATCH"],
    findingIds: null,
  });
  const uaeScope = (surfaces: SurfaceKind[] | null): FragmentScope => ({
    regions: ["UAE"],
    surfaces,
    subjectMatch: ["SUBJECT_MATCH"],
    findingIds: null,
  });
  switch (key) {
    case "FRONT_MATTER_MAIN":
      // Cover + reserved TOC slot: no analytical inputs at all — finding
      // edits must never regenerate front matter.
      return { regions: null, surfaces: [], subjectMatch: ["SUBJECT_MATCH"], findingIds: [] };
    case "EXECUTIVE_SUMMARY":
    case "DIGITAL_PROFILE_OVERVIEW":
      // Findings + metric snapshot only: per-surface claim changes must not
      // invalidate executive fragments unless findings/summary change.
      // KPI / confirmed themes stay SUBJECT_MATCH only (§2.1).
      return { regions: null, surfaces: [], subjectMatch: ["SUBJECT_MATCH"], findingIds: null };
    case "RISK_MATRIX":
      // Confirmed themes + LIKELY «Требует подтверждения» (§2.1).
      return {
        regions: null,
        surfaces: [],
        subjectMatch: ["SUBJECT_MATCH", "LIKELY_SUBJECT"],
        findingIds: null,
      };
    case "RU_SUMMARY":
      // All regional findings + url_audit units (compact check-h/indexation
      // rows on the metrics slot p08).
      return { ...ruScope([]), unitSurfaces: ["url_audit"] };
    case "RU_SERP":
    case "RU_SERP_SCREENSHOT":
      return ruScope(["organic"]);
    case "RU_SUGGESTIONS":
      return ruScope(["suggestions"]);
    case "RU_IMAGES":
      return ruScope(["images"]);
    case "RU_IDENTITY_WIKIPEDIA":
      return ruScope(["wikipedia"]);
    case "RU_KNOWLEDGE_AI":
      return ruScope(["ai_answers"]);
    case "RU_RELATED":
      return ruScope(["paa_related"]);
    case "UAE_SUMMARY":
      return { ...uaeScope([]), unitSurfaces: ["url_audit"] };
    case "UAE_SERP":
    case "UAE_SERP_SCREENSHOT":
      return uaeScope(["organic"]);
    case "UAE_SUGGESTIONS":
      return uaeScope(["suggestions"]);
    case "UAE_IMAGES":
      return uaeScope(["images"]);
    case "UAE_IDENTITY_WIKIPEDIA":
      return uaeScope(["wikipedia"]);
    case "UAE_KNOWLEDGE_AI":
      return uaeScope(["ai_answers"]);
    case "UAE_RELATED":
      return uaeScope(["paa_related"]);
    case "COMPLIANCE_MAIN":
      return { regions: null, surfaces: ["compliance"], subjectMatch: ["SUBJECT_MATCH"], findingIds: null };
    case "APPENDIX_MAIN":
      // Findings-only scope: appendix lists likely/ambiguous/foreign findings and
      // must not be invalidated by per-surface claim changes.
      return {
        regions: null,
        surfaces: [],
        subjectMatch: ["LIKELY_SUBJECT", "AMBIGUOUS", "OTHER_SUBJECT"],
        findingIds: null,
      };
  }
}

function sectionTypeOf(key: FragmentKey): SectionType {
  if (key === "FRONT_MATTER_MAIN") return "FRONT_MATTER";
  if (key === "COMPLIANCE_MAIN") return "COMPLIANCE";
  if (key === "APPENDIX_MAIN") return "APPENDIX";
  if (key.startsWith("RU_")) return "RU_PROFILE";
  if (key.startsWith("UAE_")) return "UAE_PROFILE";
  return "EXECUTIVE";
}

function composeFragment(
  key: FragmentKey,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const section = sectionTypeOf(key);
  const region = key.startsWith("RU_") ? "Россия" : key.startsWith("UAE_") ? "ОАЭ / международный" : "";
  switch (key) {
    case "FRONT_MATTER_MAIN":
      return buildFrontMatterFragment(section, scoped);
    case "EXECUTIVE_SUMMARY":
      return buildExecutiveSummaryFragment(section, scoped, extras);
    case "RISK_MATRIX":
      return buildRiskMatrixFragment(section, scoped, extras);
    case "DIGITAL_PROFILE_OVERVIEW":
      return buildDigitalProfileOverviewFragment(section, scoped);
    case "RU_SUMMARY":
    case "UAE_SUMMARY":
      return buildRegionalSummaryFragment(key, section, region, scoped, extras);
    case "RU_SERP":
    case "UAE_SERP":
      return buildSerpFragment(key, section, region, scoped);
    case "RU_SERP_SCREENSHOT":
    case "UAE_SERP_SCREENSHOT":
      return buildSerpScreenshotFragment(key, section, region, scoped, extras);
    case "RU_SUGGESTIONS":
    case "UAE_SUGGESTIONS":
      return buildSuggestionsFragment(key, section, region, scoped, extras);
    case "RU_IMAGES":
    case "UAE_IMAGES":
      return buildImagesFragment(key, section, region, scoped, extras);
    case "RU_IDENTITY_WIKIPEDIA":
    case "UAE_IDENTITY_WIKIPEDIA":
      return buildIdentityFragment(key, section, region, scoped);
    case "RU_KNOWLEDGE_AI":
    case "UAE_KNOWLEDGE_AI":
      return buildKnowledgeAiFragment(key, section, region, scoped, extras);
    case "RU_RELATED":
    case "UAE_RELATED":
      return buildRelatedQueriesFragment(key, section, region, scoped, extras);
    case "COMPLIANCE_MAIN":
      return buildComplianceFragment(section, scoped, extras);
    case "APPENDIX_MAIN":
      return buildAppendixFragment(section, scoped);
  }
}

function extrasHash(key: FragmentKey, extras: FragmentExtras): string {
  const base =
    key === "EXECUTIVE_SUMMARY"
      ? {
          executiveSummary: extras.executiveSummary ?? null,
          composedClientSummary: extras.composedClientSummary
            ? {
                schemaVersion: extras.composedClientSummary.schemaVersion,
                caseId: extras.composedClientSummary.caseId,
                themeIds: extras.composedClientSummary.sections.themes.map((t) => t.themeId),
                fullTextHash: createHash("sha256")
                  .update(extras.composedClientSummary.fullText)
                  .digest("hex")
                  .slice(0, 16),
              }
            : null,
        }
      : key === "COMPLIANCE_MAIN"
        ? extras.complianceNarrative ?? null
        : key === "RU_SUMMARY" || key === "UAE_SUMMARY"
          ? extras.uncategorizedMaterials ?? null
          : null;
  // Visual asset bindings are fragment inputs: adding/removing an asset for a
  // slot the fragment owns must regenerate it (layout templates are NOT here —
  // template-only changes never invalidate packs).
  const slotAssets = Object.fromEntries(
    slotsForFragment(key).map((s) => [s.slotId, extras.visualAssets?.[s.slotId] ?? []])
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        base,
        slotAssets,
        surfaceCollectionHints: extras.surfaceCollectionHints ?? [],
        materialFreshness: extras.materialFreshness ?? null,
        reportDiff: extras.reportDiff ?? null,
      })
    )
    .digest("hex")
    .slice(0, 16);
}

export function buildSectionPackForFragment(
  key: FragmentKey,
  ctx: SectionBuildContext
): SectionPackV2 {
  const prompt = getFragmentPrompt(key);
  const scoped = buildScopedInput({
    subject: ctx.subject,
    bundle: ctx.bundle,
    surfaceUnits: ctx.surfaceUnits,
    metricSnapshot: ctx.metricSnapshot,
    scope: fragmentScope(key),
    evidenceIndex: ctx.evidenceIndex,
    surfaceCollectionHints: ctx.extras.surfaceCollectionHints,
  });
  const inputHash = `${scopedInputHash(scoped)}:${extrasHash(key, ctx.extras)}`;

  // Cache: identical inputHash + promptVersion reuses the persisted pack —
  // no regeneration and (on LLM fragments) no new LLM call.
  const previous = ctx.previousPacks?.get(key);
  if (
    previous &&
    previous.inputHash === inputHash &&
    previous.promptVersion === prompt.promptVersion &&
    previous.contentVersion === ctx.contentVersion &&
    previous.reportRunId === ctx.reportRunId &&
    previous.sourceDatasetId === ctx.sourceDatasetId &&
    previous.caseId === ctx.caseId &&
    previous.datasetId === ctx.sourceDatasetId &&
    previous.status !== "INSUFFICIENT_DATA" &&
    previous.status !== "FAILED"
  ) {
    ctx.buildLog?.push({ fragmentKey: key, action: "REUSED_CACHE" });
    return previous;
  }

  const output = composeFragment(key, scoped, ctx.extras);
  const contentHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(output.slides))
    .digest("hex")}`;

  const adverseFindings = scoped.findings.filter((f) => (RISK_ORDER[f.riskLevel] ?? 0) >= 2);
  const displayedFindingIds = new Set(output.slides.flatMap((s) => s.findingIds));
  const displayedRefs = new Set(output.slides.flatMap((s) => s.evidenceRefs));
  // Fragment evidence scope = finding/unit refs + the scoped evidence index
  // (region+surface-scoped observation rows, e.g. bound snapshot rows).
  // Every slide's evidenceRefs must stay a subset of this set (fail-closed
  // check in section QA).
  const datasetRefs = new Set<string>([
    ...scoped.findings.flatMap((f) => f.evidenceRefs),
    ...scoped.surfaceUnits.flatMap((u) => u.evidenceRefs),
    ...Object.keys(scoped.evidenceIndex),
  ]);

  const sourceFindingIds = scoped.findings.map((f) => f.findingId);
  const evidenceRefs = [...datasetRefs];
  const pack: SectionPackV2 = {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: sectionTypeOf(key),
    sectionType: sectionTypeOf(key),
    fragmentKey: key,
    caseId: ctx.caseId,
    datasetId: ctx.sourceDatasetId,
    reportRunId: ctx.reportRunId,
    sourceDatasetId: ctx.sourceDatasetId,
    contentVersion: ctx.contentVersion,
    promptVersion: prompt.promptVersion,
    contentHash,
    inputHash,
    generatedAt: new Date().toISOString(),
    required: !OPTIONAL_FRAGMENTS.includes(key),
    status: output.status,
    sourceFindingIds,
    evidenceRefs,
    inputs: {
      findingIds: sourceFindingIds,
      evidenceRefs,
      metricSnapshotId: ctx.metricSnapshot.metricSnapshotId,
    },
    slides: output.slides,
    metrics: {
      datasetCount: datasetRefs.size,
      displayedCount: displayedRefs.size,
      adverseDatasetCount: adverseFindings.length,
      adverseDisplayedCount: adverseFindings.filter((f) => displayedFindingIds.has(f.findingId))
        .length,
    },
    provenance: {
      providers: [...new Set(scoped.findings.flatMap((f) => f.providers ?? []))],
      reportRunIds: [ctx.reportRunId],
      evidenceRefs: [...displayedRefs],
    },
    validation: { passed: true, issues: [] },
  };
  ctx.buildLog?.push({ fragmentKey: key, action: "REGENERATED" });
  return pack;
}

// --- Section-level entry points (each builds only its own fragments) ---

export function buildFrontMatterSection(ctx: SectionBuildContext): SectionPackV2[] {
  return [buildSectionPackForFragment("FRONT_MATTER_MAIN", ctx)];
}

export function buildExecutiveSection(ctx: SectionBuildContext): SectionPackV2[] {
  return [
    buildSectionPackForFragment("EXECUTIVE_SUMMARY", ctx),
    buildSectionPackForFragment("RISK_MATRIX", ctx),
    buildSectionPackForFragment("DIGITAL_PROFILE_OVERVIEW", ctx),
  ];
}

export function buildRuProfileSection(ctx: SectionBuildContext): SectionPackV2[] {
  const keys: FragmentKey[] = [
    "RU_SUMMARY",
    "RU_SERP",
    "RU_SERP_SCREENSHOT",
    "RU_SUGGESTIONS",
    "RU_IMAGES",
    "RU_IDENTITY_WIKIPEDIA",
    "RU_KNOWLEDGE_AI",
    "RU_RELATED",
  ];
  return keys.map((k) => buildSectionPackForFragment(k, ctx));
}

export function buildUaeProfileSection(ctx: SectionBuildContext): SectionPackV2[] {
  const keys: FragmentKey[] = [
    "UAE_SUMMARY",
    "UAE_SERP",
    "UAE_SERP_SCREENSHOT",
    "UAE_SUGGESTIONS",
    "UAE_IMAGES",
    "UAE_IDENTITY_WIKIPEDIA",
    "UAE_KNOWLEDGE_AI",
    "UAE_RELATED",
  ];
  return keys.map((k) => buildSectionPackForFragment(k, ctx));
}

export function buildComplianceSection(ctx: SectionBuildContext): SectionPackV2[] {
  return [buildSectionPackForFragment("COMPLIANCE_MAIN", ctx)];
}

export function buildAppendixSection(ctx: SectionBuildContext): SectionPackV2[] {
  return [buildSectionPackForFragment("APPENDIX_MAIN", ctx)];
}

export function buildAllSections(ctx: SectionBuildContext): SectionPackV2[] {
  return [
    ...buildFrontMatterSection(ctx),
    ...buildExecutiveSection(ctx),
    ...buildRuProfileSection(ctx),
    ...buildUaeProfileSection(ctx),
    ...buildComplianceSection(ctx),
    ...buildAppendixSection(ctx),
  ];
}

export { fragmentScope };
export type { Finding };
