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
import type { ArsenkinIngestLedger } from "./arsenkin-ingest-ledger";

export type ExactlyOnceIngestResult = {
  /** Журнал после приёма — его и сохраняет вызывающий (шаг 12.4f). */
  ledger: ArsenkinIngestLedger;
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

/** Stable identity for a row inside a multi-item Arsenkin result. */
function observationContentKey(obs: ArsenkinIngestedObservation): string {
  return [
    String(obs.externalTaskId ?? ""),
    String(obs.kind ?? ""),
    String(obs.sourceIndex ?? ""),
    String(obs.url ?? ""),
    String(obs.suggestion ?? ""),
    String(obs.question ?? ""),
    String(obs.title ?? ""),
    String(obs.query ?? ""),
    String(obs.sourceUrlOrQuery ?? ""),
    String(obs.fetchStatusValue ?? ""),
    String(obs.respMapKey ?? ""),
  ].join("|");
}

/**
 * Merge candidate observations into persisted dedupe state.
 * - Same task-level resultHash + same content → skip (idempotent)
 * - Same resultHash, new content rows (multi-item suggest/top) → keep
 * - Same externalTaskId with different resultHash → conflict (fail closed)
 */
export function applyExactlyOnceIngest(input: {
  caseId: string;
  unifiedJobId: string;
  previousState?: ArsenkinEnrichmentState | null;
  /**
   * Журнал принятых нагрузок. Передаётся отдельно, потому что живёт отдельно
   * (шаг 12.4f): прогресс выводится из строк задач, а это единственная запись
   * о том, что уже принято. Когда не передан — берётся из блоба, как прежде.
   */
  ledger?: ArsenkinIngestLedger | null;
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

  const source = input.ledger ?? {
    ingestedResultHashes: base.ingestedResultHashes,
    resultHashToObservationIds: base.resultHashToObservationIds,
    externalTaskIdToResultHash: base.externalTaskIdToResultHash,
  };
  const ingested = new Set(source.ingestedResultHashes);
  const hashToIds = { ...source.resultHashToObservationIds };
  const externalTaskHash = { ...source.externalTaskIdToResultHash };
  const kept: ArsenkinIngestedObservation[] = [...(input.previousObservations ?? [])];
  const keptKeys = new Set(kept.map(observationContentKey));
  let newlyIngestedCount = 0;
  let skippedDuplicateCount = 0;
  const warnings: string[] = [];

  for (const raw of input.candidates) {
    const resultHash = String(raw.resultHash ?? "").trim() || hashArsenkinResultPayload(raw);
    const obs: ArsenkinIngestedObservation = { ...raw, resultHash };
    const ext = String(obs.externalTaskId ?? "").trim();
    const contentKey = observationContentKey(obs);

    if (ext && externalTaskHash[ext] && externalTaskHash[ext] !== resultHash) {
      return {
        ledger: {
          ingestedResultHashes: [...ingested],
          resultHashToObservationIds: hashToIds,
          externalTaskIdToResultHash: externalTaskHash,
        },
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

    if (keptKeys.has(contentKey)) {
      skippedDuplicateCount += 1;
      continue;
    }

    const id = observationIdFor(obs, kept.length);
    const firstForHash = !ingested.has(resultHash);
    ingested.add(resultHash);
    hashToIds[resultHash] = [...(hashToIds[resultHash] ?? []), id];
    if (ext) externalTaskHash[ext] = resultHash;
    kept.push(obs);
    keptKeys.add(contentKey);
    if (firstForHash) newlyIngestedCount += 1;
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
    ledger: {
      ingestedResultHashes: [...ingested],
      resultHashToObservationIds: hashToIds,
      externalTaskIdToResultHash: externalTaskHash,
    },
    observations: kept,
    newlyIngestedCount,
    skippedDuplicateCount,
    state: rebuilt,
    conflict: false,
    warnings,
  };
}
