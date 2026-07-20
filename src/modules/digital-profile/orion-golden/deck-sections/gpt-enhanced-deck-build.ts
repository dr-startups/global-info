/**
 * Deck build with the optional GPT client-copy layer.
 *
 * Builds the deterministic SectionPacks first (cache-aware), then — when a
 * GPT caller is provided — rewrites the client text of every LLM-flagged
 * fragment via enhanceSectionPacksWithGptCopy and hands the enhanced packs to
 * the standard runDeckBuild (validation, manifest, assembly, artifacts).
 * Without a caller the behavior is byte-identical to the deterministic build.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FragmentKey, SectionPackV2 } from "./contracts";
import { FRAGMENT_ARTIFACT_PATHS } from "./contracts";
import { buildAllSections, type SectionBuildContext } from "./section-builders";
import { validateSectionPack } from "./section-validation";
import {
  loadPreviousPacks,
  runDeckBuild,
  type DeckBuildResult,
} from "./run-deck-build";
import {
  enhanceSectionPacksWithGptCopy,
  type GptSlideCopyReport,
} from "./llm-slide-copy";
import { applyExecutiveFreshnessChangeToPacks } from "./fragment-builders";
import type { GptCaseAnalysis, GptJsonCaller } from "../gpt/gpt-case-analysis";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";

function packsInArtifactOrder(
  previous: Map<FragmentKey, SectionPackV2>
): SectionPackV2[] {
  const ordered: SectionPackV2[] = [];
  for (const key of Object.keys(FRAGMENT_ARTIFACT_PATHS) as FragmentKey[]) {
    const pack = previous.get(key);
    if (pack) ordered.push(pack);
  }
  return ordered;
}

function loadFallbackKeysFromReport(outputRoot: string): Set<string> {
  const path = join(outputRoot, "gpt-report-copy.json");
  const keys = new Set<string>();
  if (!existsSync(path)) return keys;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      fragments?: Array<{ fragmentKey?: string; status?: string }>;
    };
    for (const f of parsed.fragments ?? []) {
      if (f.fragmentKey && String(f.status ?? "").startsWith("FALLBACK_")) {
        keys.add(f.fragmentKey);
      }
    }
  } catch {
    // Missing/corrupt report — pack lastStatus alone still drives retry.
  }
  return keys;
}

export type GptDeckLayer = {
  caller: GptJsonCaller;
  /** Holistic stage-1 case analysis injected into every fragment prompt. */
  caseAnalysis: GptCaseAnalysis | null;
};

export type GptDeckBuildResult = DeckBuildResult & {
  gptReport: GptSlideCopyReport | null;
};

export async function runDeckBuildWithGptCopy(input: {
  ctx: Omit<SectionBuildContext, "previousPacks" | "buildLog">;
  bundleForValidation: VerifiedFindingBundle;
  knownEvidenceRefs: Set<string>;
  outputRoot: string;
  baseObservationCountBefore: number;
  baseObservationCountAfter: number;
  /** GPT layer; null/undefined → pure deterministic build. */
  gpt?: GptDeckLayer | null;
  /**
   * When true, drop persisted `gptCopy` markers before stage 2 so reused
   * SectionPacks cannot short-circuit as SKIPPED_CACHED (unified «Пересобрать»).
   */
  forceGptCopy?: boolean;
}): Promise<GptDeckBuildResult> {
  const buildLog: DeckBuildResult["buildLog"] = [];
  const previousPacks = loadPreviousPacks(input.outputRoot);
  const ctx: SectionBuildContext = { ...input.ctx, previousPacks, buildLog };

  let packs: SectionPackV2[] = buildAllSections(ctx);
  let gptReport: GptSlideCopyReport | null = null;

  if (input.gpt) {
    // Belt-and-suspenders: strip stamps AND pass forceRefresh so a missed
    // strip cannot revive SKIPPED_CACHED (live: применено 0 · кэш N).
    if (input.forceGptCopy) {
      packs = packs.map((p) => {
        if (!p.gptCopy) return p;
        const { gptCopy: _drop, ...rest } = p;
        return rest as SectionPackV2;
      });
    }
    const validatePack = (pack: SectionPackV2) =>
      validateSectionPack({
        pack,
        expectedCaseId: ctx.caseId,
        expectedReportRunId: ctx.reportRunId,
        expectedDatasetId: ctx.sourceDatasetId,
        bundle: input.bundleForValidation,
        knownEvidenceRefs: input.knownEvidenceRefs,
        evidenceIndex: ctx.evidenceIndex,
      });
    const enhanced = await enhanceSectionPacksWithGptCopy({
      packs,
      subject: ctx.subject,
      caller: input.gpt.caller,
      caseAnalysis: input.gpt.caseAnalysis,
      bundle: input.bundleForValidation,
      evidenceIndex: ctx.evidenceIndex,
      validatePack,
      forceRefresh: Boolean(input.forceGptCopy),
    });
    packs = enhanced.packs;
    gptReport = enhanced.report;
    mkdirSync(input.outputRoot, { recursive: true });
    writeFileSync(
      join(input.outputRoot, "gpt-report-copy.json"),
      `${JSON.stringify(enhanced.report, null, 2)}\n`,
      "utf8"
    );
  }

  // After GPT/cache — §7.2 must stay a short dedicated narrative card on p03.
  packs = applyExecutiveFreshnessChangeToPacks(packs, ctx.extras);

  const result = runDeckBuild({
    ctx: input.ctx,
    bundleForValidation: input.bundleForValidation,
    knownEvidenceRefs: input.knownEvidenceRefs,
    outputRoot: input.outputRoot,
    baseObservationCountBefore: input.baseObservationCountBefore,
    baseObservationCountAfter: input.baseObservationCountAfter,
    prebuiltPacks: packs,
    prebuiltBuildLog: buildLog,
  });
  if (gptReport) {
    result.artifacts["gpt-report-copy.json"] = join(input.outputRoot, "gpt-report-copy.json");
  }
  return { ...result, gptReport };
}

/**
 * REMEDIATION §4.3 — retry FALLBACK_* stage-2 fragments on existing packs,
 * reassemble the deck, write a fresh gpt-report-copy.json. Never rebuilds
 * analytics and never strips successful gptCopy markers.
 */
export async function runDeckGptCopyRetry(input: {
  ctx: Omit<SectionBuildContext, "previousPacks" | "buildLog">;
  bundleForValidation: VerifiedFindingBundle;
  knownEvidenceRefs: Set<string>;
  outputRoot: string;
  baseObservationCountBefore: number;
  baseObservationCountAfter: number;
  gpt: GptDeckLayer;
}): Promise<GptDeckBuildResult> {
  const previousPacks = loadPreviousPacks(input.outputRoot);
  const packs = packsInArtifactOrder(previousPacks);
  if (packs.length === 0) {
    throw new Error("GPT_COPY_RESUME_PACKS_MISSING");
  }

  const buildLog: DeckBuildResult["buildLog"] = packs.map((p) => ({
    fragmentKey: p.fragmentKey,
    action: "REUSED_CACHE" as const,
  }));
  const ctx: SectionBuildContext = {
    ...input.ctx,
    previousPacks,
    buildLog,
  };

  const validatePack = (pack: SectionPackV2) =>
    validateSectionPack({
      pack,
      expectedCaseId: ctx.caseId,
      expectedReportRunId: ctx.reportRunId,
      expectedDatasetId: ctx.sourceDatasetId,
      bundle: input.bundleForValidation,
      knownEvidenceRefs: input.knownEvidenceRefs,
      evidenceIndex: ctx.evidenceIndex,
    });

  const enhanced = await enhanceSectionPacksWithGptCopy({
    packs,
    subject: ctx.subject,
    caller: input.gpt.caller,
    caseAnalysis: input.gpt.caseAnalysis,
    bundle: input.bundleForValidation,
    evidenceIndex: ctx.evidenceIndex,
    validatePack,
    retryOnlyFallback: true,
    fallbackFragmentKeys: loadFallbackKeysFromReport(input.outputRoot),
  });

  const packsWithFreshness = applyExecutiveFreshnessChangeToPacks(
    enhanced.packs,
    ctx.extras
  );

  mkdirSync(input.outputRoot, { recursive: true });
  writeFileSync(
    join(input.outputRoot, "gpt-report-copy.json"),
    `${JSON.stringify(enhanced.report, null, 2)}\n`,
    "utf8"
  );

  const result = runDeckBuild({
    ctx: input.ctx,
    bundleForValidation: input.bundleForValidation,
    knownEvidenceRefs: input.knownEvidenceRefs,
    outputRoot: input.outputRoot,
    baseObservationCountBefore: input.baseObservationCountBefore,
    baseObservationCountAfter: input.baseObservationCountAfter,
    prebuiltPacks: packsWithFreshness,
    prebuiltBuildLog: buildLog,
  });
  result.artifacts["gpt-report-copy.json"] = join(
    input.outputRoot,
    "gpt-report-copy.json"
  );
  return { ...result, gptReport: enhanced.report };
}
