/**
 * Risk Classifier v1 orchestration (Stage I).
 *
 * Runs the deterministic rules over all loaded evidence and returns the raw
 * classification results plus a count of evidence scanned. Persistence and
 * idempotency live in risk-finding-service.
 */

import type { LoadedCaseEvidence } from "./evidence-loader";
import {
  classifyDatabaseProfile,
  classifySearchResult,
  classifySurfaceItem,
  classifyWikipedia,
} from "./rules";
import type { RiskClassificationResult } from "./types";

export interface ClassifyEvidenceOutput {
  results: RiskClassificationResult[];
  totalEvidenceScanned: number;
}

export function classifyEvidence(evidence: LoadedCaseEvidence): ClassifyEvidenceOutput {
  const results: RiskClassificationResult[] = [];

  for (const r of evidence.searchResults) results.push(...classifySearchResult(r));
  for (const s of evidence.searchSurfaceItems) results.push(...classifySurfaceItem(s));
  for (const w of evidence.wikipediaChecks) results.push(...classifyWikipedia(w));
  for (const d of evidence.databaseProfiles) results.push(...classifyDatabaseProfile(d));

  const totalEvidenceScanned =
    evidence.searchResults.length +
    evidence.searchSurfaceItems.length +
    evidence.wikipediaChecks.length +
    evidence.databaseProfiles.length;

  return { results, totalEvidenceScanned };
}
