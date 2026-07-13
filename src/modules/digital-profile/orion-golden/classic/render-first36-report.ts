/**
 * Single public entry point for First36 CEO report render.
 * All smoke/e2e/CEO paths should call this with one reportRunId + mode.
 */

import { join } from "node:path";
import {
  loadPostReviewClientContent,
  runOrionClassicAuditRender,
} from "./run-orion-classic-audit-render";
import type { OrionClientContent } from "../content/orion-client-content-builder";

export type First36RenderMode = "ceo" | "internal_preview" | "acceptance";

export async function renderFirst36Report(input: {
  caseId: string;
  reportRunId?: string;
  mode?: First36RenderMode;
  outputRoot?: string;
  clientContent?: OrionClientContent;
}): Promise<{
  caseId: string;
  reportRunId: string;
  outputRoot: string;
  slideCount: number;
  pageCount: number;
  verdict: "PASS" | "FAIL";
  mode: First36RenderMode;
}> {
  const mode = input.mode ?? "ceo";
  process.env.ORION_FIRST36_CEO_MODE = "1";
  process.env.ORION_CLASSIC_AUDIT_MODE = "1";
  if (mode === "ceo" || mode === "acceptance") {
    process.env.ORION_CLASSIC_CLIENT_FINALIZE = process.env.ORION_CLASSIC_CLIENT_FINALIZE || "1";
    process.env.ORION_FIRST36_RUN_SCOPED = "1";
    // Legacy case-wide SearchResult fallback stays OFF unless explicitly enabled.
    if (process.env.ORION_FIRST36_LEGACY_CASEWIDE_FALLBACK !== "1") {
      delete process.env.ORION_FIRST36_LEGACY_CASEWIDE_FALLBACK;
    }
  }

  const clientContent =
    input.clientContent ??
    (() => {
      const loaded = loadPostReviewClientContent(input.caseId);
      if (input.reportRunId) {
        return { ...loaded, reportRunId: input.reportRunId };
      }
      return loaded;
    })();

  const reportRunId = String(input.reportRunId ?? clientContent.reportRunId ?? "").trim();
  if (!reportRunId) {
    throw new Error("renderFirst36Report: reportRunId required");
  }

  const outputRoot =
    input.outputRoot ??
    join(
      process.cwd(),
      "storage",
      "digital-profile",
      "qa-first36-acceptance",
      input.caseId,
      String(Date.now())
    );

  const result = await runOrionClassicAuditRender({
    caseId: input.caseId,
    outputRoot,
    clientContent: { ...clientContent, reportRunId },
  });

  return {
    caseId: input.caseId,
    reportRunId,
    outputRoot: result.outputRoot,
    slideCount: result.slideCount,
    pageCount: result.pageCount,
    verdict: result.verdict,
    mode,
  };
}
