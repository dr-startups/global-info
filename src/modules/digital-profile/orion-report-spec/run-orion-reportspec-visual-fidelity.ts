import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness } from "../config";
import { runOrionReportSpecVerticalSlice } from "./run-orion-reportspec-vertical-slice";
import { inspectSyntheticSerp, inspectReportSpecVisualQuality } from "./visual-quality-inspection";

export const R97B_OUTPUT_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r9-7b-orion-reportspec-visual-fidelity"
);

export interface RunReportSpecVisualFidelityResult {
  outputRoot: string;
  liveGptReady: boolean;
  liveGptUsed: boolean;
  blockedForLiveGpt: boolean;
  visualInspection: ReturnType<typeof inspectReportSpecVisualQuality>;
  pageCount: number;
}

export async function runOrionReportSpecVisualFidelitySlice(): Promise<RunReportSpecVisualFidelityResult> {
  const readiness = describeOrionV2AiReadiness();
  const liveGptReady = readiness.ready;
  const requireAi = liveGptReady;

  let result;
  let blockedForLiveGpt = false;
  try {
    result = await runOrionReportSpecVerticalSlice({
      outputRoot: R97B_OUTPUT_ROOT,
      useRealCaseData: false,
      requireAi,
      allowDeterministicFallback: false,
    });
  } catch (error) {
    if (!liveGptReady) {
      blockedForLiveGpt = true;
      result = await runOrionReportSpecVerticalSlice({
        outputRoot: R97B_OUTPUT_ROOT,
        useRealCaseData: false,
        requireAi: false,
        allowDeterministicFallback: true,
      });
    } else {
      throw error;
    }
  }

  const liveGptUsed = result.generatedBy === "gpt-5.5";
  blockedForLiveGpt = !liveGptReady || (requireAi && !liveGptUsed);

  const pagesDir = join(R97B_OUTPUT_ROOT, "target-pages-png");
  const pageCount = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => f.startsWith("page-") && f.endsWith(".png")).length
    : 0;

  const visualInspection = inspectReportSpecVisualQuality({
    reportSpec: result.reportSpec,
    pageCount,
    gptUsed: liveGptUsed,
    gptRequired: requireAi,
  });

  writeFileSync(
    join(R97B_OUTPUT_ROOT, "reportspec-visual-quality-inspection.json"),
    JSON.stringify(visualInspection, null, 2)
  );
  writeFileSync(
    join(R97B_OUTPUT_ROOT, "gpt-section-analysis-inspection.json"),
    JSON.stringify(
      {
        liveGptReady,
        liveGptUsed,
        blockedForLiveGpt,
        generatedBy: result.generatedBy,
        requireAi,
        model: readiness.model,
        aiEnabled: readiness.aiEnabled,
        hasOpenAiKey: readiness.hasOpenAiKey,
        sections: result.reportSpec.sections.map((s) => ({
          sectionKey: s.sectionKey,
          slideCount: s.slides.length,
          narrativeLength: s.clientNarrative.summary.length,
        })),
      },
      null,
      2
    )
  );
  writeFileSync(
    join(R97B_OUTPUT_ROOT, "synthetic-serp-inspection.json"),
    JSON.stringify(
      inspectSyntheticSerp({
        assets: result.reportSpec.assets,
        evidenceCount: result.reportSpec.evidence.filter((e) => e.sourceKind === "search_result").length,
      }),
      null,
      2
    )
  );

  return {
    outputRoot: R97B_OUTPUT_ROOT,
    liveGptReady,
    liveGptUsed,
    blockedForLiveGpt,
    visualInspection,
    pageCount,
  };
}
