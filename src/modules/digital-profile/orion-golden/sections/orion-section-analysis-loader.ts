/**
 * Load persisted R10.6 section analyses + synthesis artifacts from case output root.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutiveSynthesisOutput } from "../gpt/orion-executive-synthesis-from-sections";
import type { SectionDerivedRiskMatrix } from "./orion-risk-matrix-from-sections";
import type { OrionSectionAnalysis, OrionSectionAnalysisIndex } from "./orion-section-analysis";

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function loadOrionSectionAnalysesFromRoot(artifactRoot: string): OrionSectionAnalysis[] {
  const indexPath = join(artifactRoot, "section-analyses", "index.json");
  const index = readJson<OrionSectionAnalysisIndex>(indexPath);
  if (!index?.analyses?.length) return [];

  const out: OrionSectionAnalysis[] = [];
  for (const entry of index.analyses) {
    const analysis = readJson<OrionSectionAnalysis>(
      join(artifactRoot, "section-analyses", `${entry.sectionId}.analysis.json`)
    );
    if (analysis) out.push(analysis);
  }
  return out.sort((a, b) => a.order - b.order);
}

export function loadExecutiveSynthesisFromRoot(artifactRoot: string): ExecutiveSynthesisOutput | null {
  return readJson<ExecutiveSynthesisOutput>(join(artifactRoot, "executive-synthesis.output.json"));
}

export function loadSectionDerivedRiskMatrixFromRoot(artifactRoot: string): SectionDerivedRiskMatrix | null {
  return readJson<SectionDerivedRiskMatrix>(join(artifactRoot, "risk-matrix.section-derived.json"));
}

export function hasSectionBasedClientArtifacts(artifactRoot: string): boolean {
  return (
    existsSync(join(artifactRoot, "section-analyses", "index.json")) &&
    existsSync(join(artifactRoot, "executive-synthesis.output.json"))
  );
}
