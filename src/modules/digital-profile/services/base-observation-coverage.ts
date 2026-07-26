/**
 * Base observation coverage contract — replaces false compositeCount >= baseCount gate.
 */

import {
  manifestBaseObservationIds,
  type BaseCollectionManifest,
} from "./unified-collection-types";
import type { CompositeMergeResult, CompositeObservation } from "./composite-serp-merge";

export const BASE_OBSERVATION_COVERAGE_VERSION = "base-observation-coverage-v1" as const;

export type BaseObservationDuplicateGroup = {
  compositeKey: string;
  baseObservationIds: string[];
};

export type BaseObservationCoverage = {
  version: typeof BASE_OBSERVATION_COVERAGE_VERSION;
  caseId: string;
  unifiedJobId: string;
  compositeDatasetId: string;
  baseReportRunId: string | null;
  baseObservationIds: string[];
  coveredBaseObservationIds: string[];
  missingBaseObservationIds: string[];
  compositeRowIds: string[];
  duplicateGroups: BaseObservationDuplicateGroup[];
  coverageRatio: number;
  allBaseObservationsTraceable: boolean;
  /** Diagnostics only — not a pass/fail criterion. */
  diagnosticCounts: {
    rawBaseCount: number;
    compositeRowCount: number;
    duplicateGroupCount: number;
  };
};

function collectCitedBaseIds(obs: CompositeObservation): string[] {
  const ids = new Set<string>();
  if (obs.baseSearchResultId) ids.add(obs.baseSearchResultId);
  if (obs.baseSearchSurfaceItemId) ids.add(obs.baseSearchSurfaceItemId);
  for (const ref of obs.evidenceRefs ?? []) {
    const a = /^searchResult:(.+)$/.exec(ref);
    const b = /^searchSurfaceItem:(.+)$/.exec(ref);
    if (a) ids.add(a[1]!);
    if (b) ids.add(b[1]!);
  }
  return [...ids];
}

export function buildBaseObservationCoverage(input: {
  manifest: BaseCollectionManifest;
  merge: CompositeMergeResult;
}): BaseObservationCoverage {
  const skippedMock = new Set(input.merge.provenance.skippedMockBaseIds ?? []);
  const baseObservationIds = manifestBaseObservationIds(input.manifest).filter(
    (id) => !skippedMock.has(id)
  );
  const baseSet = new Set(baseObservationIds);
  const covered = new Set<string>();
  const byKey = new Map<string, string[]>();

  for (const obs of input.merge.observations) {
    const cites = collectCitedBaseIds(obs).filter((id) => baseSet.has(id));
    for (const id of cites) covered.add(id);
    if (cites.length > 0) {
      const prev = byKey.get(obs.key) ?? [];
      byKey.set(obs.key, Array.from(new Set([...prev, ...cites])));
    }
  }

  const coveredBaseObservationIds = baseObservationIds.filter((id) => covered.has(id));
  const missingBaseObservationIds = baseObservationIds.filter((id) => !covered.has(id));
  const duplicateGroups: BaseObservationDuplicateGroup[] = [];
  for (const [compositeKey, ids] of byKey) {
    if (ids.length > 1) {
      duplicateGroups.push({ compositeKey, baseObservationIds: ids });
    }
  }

  const coverageRatio =
    baseObservationIds.length === 0 ? 1 : coveredBaseObservationIds.length / baseObservationIds.length;

  return {
    version: BASE_OBSERVATION_COVERAGE_VERSION,
    caseId: input.manifest.caseId,
    unifiedJobId: input.manifest.unifiedJobId,
    compositeDatasetId: input.merge.compositeDatasetId,
    baseReportRunId: input.manifest.baseReportRunId,
    baseObservationIds,
    coveredBaseObservationIds,
    missingBaseObservationIds,
    compositeRowIds: input.merge.observations.map((o) => o.key),
    duplicateGroups,
    coverageRatio,
    allBaseObservationsTraceable: missingBaseObservationIds.length === 0,
    diagnosticCounts: {
      rawBaseCount: baseObservationIds.length,
      compositeRowCount: input.merge.observations.length,
      duplicateGroupCount: duplicateGroups.length,
    },
  };
}

export function assertBaseObservationCoverage(coverage: BaseObservationCoverage): {
  ok: boolean;
  code: string | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (coverage.version !== BASE_OBSERVATION_COVERAGE_VERSION) {
    errors.push(`unexpected coverage version ${coverage.version}`);
  }
  if (coverage.missingBaseObservationIds.length > 0) {
    errors.push(
      `missingBaseObservationIds=${coverage.missingBaseObservationIds.length}: ${coverage.missingBaseObservationIds.slice(0, 5).join(",")}`
    );
  }
  if (!coverage.allBaseObservationsTraceable) {
    errors.push("allBaseObservationsTraceable=false");
  }
  if (coverage.coverageRatio !== 1) {
    errors.push(`coverageRatio=${coverage.coverageRatio} (expected 1)`);
  }
  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? null : "BASE_OBSERVATION_COVERAGE_FAILED",
    errors,
  };
}
