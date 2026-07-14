/**
 * Rebuild Orion client content for an existing reportRunId (no reportRunId stamping).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runR10OrionGoldenE2e } from "./run-r10-orion-golden-e2e";

function writeJson(path: string, payload: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

export type RebuildClientContentResult = {
  caseId: string;
  reportRunId: string;
  outputRoot: string;
};

/**
 * Run the content brain for a fixed reportRunId and write post-review client artifacts
 * under outputRoot. Does not copy prior JSON with a new reportRunId.
 */
export async function rebuildClientContentForReportRun(
  caseId: string,
  reportRunId: string,
  outputRoot: string,
  options?: { requireAi?: boolean }
): Promise<RebuildClientContentResult> {
  const trimmedCaseId = caseId.trim();
  const trimmedRunId = reportRunId.trim();
  if (!trimmedCaseId) throw new Error("CASE_ID required");
  if (!trimmedRunId) throw new Error("reportRunId required");

  mkdirSync(outputRoot, { recursive: true });

  await runR10OrionGoldenE2e({
    caseId: trimmedCaseId,
    reportRunId: trimmedRunId,
    outputRoot,
    requireAi: options?.requireAi ?? false,
    contentBrainOnly: true,
    mergeRunScopedObservations: true,
  });

  writeJson(join(outputRoot, "client-content-binding.json"), {
    sourceReportRunId: trimmedRunId,
    effectiveReportRunId: trimmedRunId,
    overridden: false,
    rebuilt: true,
  });

  return { caseId: trimmedCaseId, reportRunId: trimmedRunId, outputRoot };
}
