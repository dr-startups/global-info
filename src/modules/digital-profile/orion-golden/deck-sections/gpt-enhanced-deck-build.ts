/**
 * Deck build with the optional GPT client-copy layer.
 *
 * Builds the deterministic SectionPacks first (cache-aware), then — when a
 * GPT caller is provided — rewrites the client text of every LLM-flagged
 * fragment via enhanceSectionPacksWithGptCopy and hands the enhanced packs to
 * the standard runDeckBuild (validation, manifest, assembly, artifacts).
 * Without a caller the behavior is byte-identical to the deterministic build.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SectionPackV2 } from "./contracts";
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
import type { GptCaseAnalysis, GptJsonCaller } from "../gpt/gpt-case-analysis";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";

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
}): Promise<GptDeckBuildResult> {
  const buildLog: DeckBuildResult["buildLog"] = [];
  const previousPacks = loadPreviousPacks(input.outputRoot);
  const ctx: SectionBuildContext = { ...input.ctx, previousPacks, buildLog };

  let packs: SectionPackV2[] = buildAllSections(ctx);
  let gptReport: GptSlideCopyReport | null = null;

  if (input.gpt) {
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
