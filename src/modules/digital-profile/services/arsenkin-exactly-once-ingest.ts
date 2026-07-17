/**
 * Persisted exactly-once Arsenkin result ingestion (full resultHash, no silent dupes).
 */

import {
  buildArsenkinEnrichmentState,
  emptyArsenkinEnrichmentState,
  hashArsenkinResultPayload,
  normalizeArsenkinEnrichmentState,
  type ArsenkinAgentProgress,
  type ArsenkinEnrichmentState,
  type ArsenkinIngestedObservation,
} from "./arsenkin-enrichment-state";

export type ExactlyOnceIngestResult = {
  observations: ArsenkinIngestedObservation[];
  newlyIngestedCount: number;
  skippedDuplicateCount: number;
  state: ArsenkinEnrichmentState;
  conflict: boolean;
  conflictCode?: "EXTERNAL_TASK_HASH_CONFLICT";
  conflictMessage?: string;
  warnings: string[];
};

function observationIdFor(obs: ArsenkinIngestedObservation, index: number): string {
  return `obs:${obs.resultHash ?? hashArsenkinResultPayload(obs)}:${index}`;
}

/**
 * Merge candidate observations into persisted dedupe state.
 * - Same resultHash → skip (idempotent)
 * - Same externalTaskId with different resultHash → conflict (fail closed, no silent dupe)
 */
export function applyExactlyOnceIngest(input: {
  caseId: string;
  unifiedJobId: string;
  previousState?: ArsenkinEnrichmentState | null;
  previousObservations?: ArsenkinIngestedObservation[];
  candidates: ArsenkinIngestedObservation[];
  agents?: ArsenkinAgentProgress[];
}): ExactlyOnceIngestResult {
  const base =
    input.previousState != null
      ? normalizeArsenkinEnrichmentState(input.previousState, {
          caseId: input.caseId,
          unifiedJobId: input.unifiedJobId,
        })
      : emptyArsenkinEnrichmentState({
          caseId: input.caseId,
          unifiedJobId: input.unifiedJobId,
        });

  const ingested = new Set(base.ingestedResultHashes);
  const hashToIds = { ...base.resultHashToObservationIds };
  const externalTaskHash = { ...base.externalTaskIdToResultHash };
  const kept: ArsenkinIngestedObservation[] = [...(input.previousObservations ?? [])];
  let newlyIngestedCount = 0;
  let skippedDuplicateCount = 0;
  const warnings: string[] = [];

  for (const raw of input.candidates) {
    const resultHash = String(raw.resultHash ?? "").trim() || hashArsenkinResultPayload(raw);
    const obs: ArsenkinIngestedObservation = { ...raw, resultHash };
    const ext = String(obs.externalTaskId ?? "").trim();

    if (ext && externalTaskHash[ext] && externalTaskHash[ext] !== resultHash) {
      return {
        observations: kept,
        newlyIngestedCount,
        skippedDuplicateCount,
        state: {
          ...base,
          ingestedResultHashes: [...ingested],
          resultHashToObservationIds: hashToIds,
          externalTaskIdToResultHash: externalTaskHash,
          enrichmentObservationCount: kept.length,
          updatedAt: new Date().toISOString(),
        },
        conflict: true,
        conflictCode: "EXTERNAL_TASK_HASH_CONFLICT",
        conflictMessage: `externalTaskId ${ext} payload/hash changed (${externalTaskHash[ext]} → ${resultHash})`,
        warnings: [...warnings, `EXTERNAL_TASK_HASH_CONFLICT:${ext}`],
      };
    }

    if (ingested.has(resultHash)) {
      skippedDuplicateCount += 1;
      // Re-emit already-persisted hash when previousObservations omitted (idempotent tick).
      if (!kept.some((k) => k.resultHash === resultHash)) {
        kept.push(obs);
      }
      continue;
    }

    const id = observationIdFor(obs, kept.length);
    ingested.add(resultHash);
    hashToIds[resultHash] = [...(hashToIds[resultHash] ?? []), id];
    if (ext) externalTaskHash[ext] = resultHash;
    kept.push(obs);
    newlyIngestedCount += 1;
  }

  const agents = input.agents ?? base.agents;
  const rebuilt = buildArsenkinEnrichmentState({
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId,
    agents,
    ingestedResultHashes: [...ingested],
    resultHashToObservationIds: hashToIds,
    externalTaskIdToResultHash: externalTaskHash,
  });
  rebuilt.enrichmentObservationCount = kept.length;

  return {
    observations: kept,
    newlyIngestedCount,
    skippedDuplicateCount,
    state: rebuilt,
    conflict: false,
    warnings,
  };
}
