/**
 * Subject-agnostic deck-input loader.
 *
 * Reads a canonical analytics artifact directory (produced by
 * `runOrionAnalyticsPipeline`) and derives the inputs `runDeckBuild` needs.
 * Contains NO subject-specific literals and NO baseline (report-72) paths — it
 * works for any subject whose analytics artifacts live in `analyticsDir`.
 *
 * This is the canonical, universal counterpart of the report-72 replay loader.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { Finding } from "../contracts/finding";
import type { SurfaceAnalysis } from "../contracts/surface-analysis";
import type { ScopedEvidenceIndex, MetricSnapshot } from "./scoped-input";
import { mapRegionBucket } from "../classic/composite-serp-overlay-merge";

type CompositeObservationRow = {
  surface: string;
  region: string;
  engine?: string;
  url?: string;
  title?: string;
  domain?: string;
  evidenceRefs: string[];
};

export type CanonicalDeckInputs = {
  caseId: string;
  reportRunId: string;
  sourceDatasetId: string;
  mergedBundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysis["units"];
  evidenceIndex: ScopedEvidenceIndex;
  knownEvidenceRefs: Set<string>;
  metricSnapshot: MetricSnapshot;
  executiveSummary: Record<string, unknown>;
  subjectResolution: { items: Array<{ decision: string }> };
  baseCountBefore: number;
  baseCountAfter: number;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const RISK_ORDER: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Build the deterministic deck-build inputs from an analytics artifact dir.
 * Fail-closed: throws if a required artifact is missing/unreadable.
 */
export function loadDeckInputsFromAnalyticsDir(analyticsDir: string): CanonicalDeckInputs {
  const bundle = readJson<VerifiedFindingBundle>(join(analyticsDir, "verified-finding-bundle.json"));
  const ambiguous = readJson<Finding[]>(join(analyticsDir, "ambiguous-findings.json"));
  const surfaceAnalysis = readJson<Record<string, SurfaceAnalysis>>(
    join(analyticsDir, "surface-analysis.json")
  );
  const executiveSummary = readJson<Record<string, unknown>>(
    join(analyticsDir, "executive-summary.json")
  );
  const binding = readJson<{ baseReportRunId: string; datasetId: string; caseId: string }>(
    join(analyticsDir, "report-data-binding.json")
  );
  const providerDelta = readJson<{ baseCount: number; arsenkinObservationCount: number }>(
    join(analyticsDir, "provider-delta.json")
  );
  const observations = readJson<{
    observations: CompositeObservationRow[];
    baseCount: number;
    compositeCount: number;
  }>(join(analyticsDir, "composite-serp-observations.json"));
  const subjectResolution = readJson<{ items: Array<{ decision: string }> }>(
    join(analyticsDir, "subject-resolution.json")
  );

  const mergedBundle: VerifiedFindingBundle = {
    ...bundle,
    findings: [...bundle.findings, ...ambiguous],
  };
  const surfaceUnits = Object.values(surfaceAnalysis).flatMap((sa) => sa.units);

  const evidenceIndex: ScopedEvidenceIndex = {};
  const knownEvidenceRefs = new Set<string>();
  const perRegionCounts: Record<string, number> = {};
  for (const obs of observations.observations) {
    const regionKey = mapRegionBucket(obs.region) === "UAE" ? "UAE" : "RU";
    perRegionCounts[regionKey] = (perRegionCounts[regionKey] ?? 0) + 1;
    for (const ref of obs.evidenceRefs) {
      knownEvidenceRefs.add(ref);
      evidenceIndex[ref] = {
        url: obs.url,
        domain: obs.domain,
        title: obs.title,
        kind: obs.surface,
        region: obs.region,
        engine: obs.engine,
      };
    }
  }
  for (const f of mergedBundle.findings) for (const r of f.evidenceRefs) knownEvidenceRefs.add(r);
  for (const u of surfaceUnits) {
    for (const r of u.evidenceRefs) knownEvidenceRefs.add(r);
    for (const c of u.claims) for (const r of c.evidenceRefs) knownEvidenceRefs.add(r);
  }

  const decisions = subjectResolution.items.reduce<Record<string, number>>((acc, i) => {
    acc[i.decision] = (acc[i.decision] ?? 0) + 1;
    return acc;
  }, {});
  const metricSnapshot: MetricSnapshot = {
    metricSnapshotId: `${binding.datasetId}-metrics`,
    datasetId: binding.datasetId,
    reportRunId: binding.baseReportRunId,
    baseCount: observations.baseCount,
    enrichmentCount: providerDelta.arsenkinObservationCount,
    compositeCount: observations.compositeCount,
    subjectMatchCount: decisions.SUBJECT_MATCH ?? 0,
    ambiguousCount: decisions.AMBIGUOUS ?? 0,
    otherSubjectCount: decisions.OTHER_SUBJECT ?? 0,
    adverseFindingCount: bundle.findings.filter(
      (f) => f.subjectMatch === "SUBJECT_MATCH" && (RISK_ORDER[f.riskLevel] ?? 0) >= 2
    ).length,
    perRegionCounts,
  };

  return {
    caseId: binding.caseId,
    reportRunId: binding.baseReportRunId,
    sourceDatasetId: binding.datasetId,
    mergedBundle,
    surfaceUnits,
    evidenceIndex,
    knownEvidenceRefs,
    metricSnapshot,
    executiveSummary,
    subjectResolution,
    baseCountBefore: providerDelta.baseCount,
    baseCountAfter: observations.baseCount,
  };
}
