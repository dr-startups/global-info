/**
 * Persist (or idempotently reuse) the OrionReportRun that owns a unified job's
 * base Yandex/Serper/Wikipedia collection. Arsenkin CaseAgents and binding
 * require a real DB row — never a synthetic id.
 */

import type { PrismaClient } from "@prisma/client";

export const UNIFIED_BASE_REPORT_MODE = "UNIFIED_BASE_COLLECTION";

export type EnsureUnifiedBaseReportRunResult = {
  baseReportRunId: string;
  created: boolean;
};

/**
 * Find an existing base run for this unifiedJobId or create one.
 * Idempotent: repeated calls with the same caseId+unifiedJobId return the same id.
 */
export async function ensurePersistedUnifiedBaseReportRun(input: {
  prisma: PrismaClient;
  caseId: string;
  unifiedJobId: string;
  /** Prefer reusing this id when it already exists for the case. */
  existingBaseReportRunId?: string | null;
}): Promise<EnsureUnifiedBaseReportRunResult> {
  const existingId = String(input.existingBaseReportRunId ?? "").trim();
  if (existingId) {
    const row = await input.prisma.orionReportRun.findFirst({
      where: { id: existingId, caseId: input.caseId },
      select: { id: true },
    });
    if (row) return { baseReportRunId: row.id, created: false };
  }

  const byMeta = await input.prisma.orionReportRun.findMany({
    where: {
      caseId: input.caseId,
      mode: UNIFIED_BASE_REPORT_MODE,
    },
    select: { id: true, metadataJson: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  for (const row of byMeta) {
    const meta = (row.metadataJson ?? {}) as Record<string, unknown>;
    if (meta.unifiedJobId === input.unifiedJobId) {
      return { baseReportRunId: row.id, created: false };
    }
  }

  const id = `orion-unified-base-${input.unifiedJobId}`.slice(0, 190);
  await input.prisma.orionReportRun.create({
    data: {
      id,
      caseId: input.caseId,
      mode: UNIFIED_BASE_REPORT_MODE,
      status: "SUCCEEDED",
      storeMode: "file",
      internalOnly: true,
      startedAt: new Date(),
      finishedAt: new Date(),
      metadataJson: {
        unifiedJobId: input.unifiedJobId,
        purpose: "unified-base-collection",
        createdBy: "ensurePersistedUnifiedBaseReportRun",
      },
    },
  });
  return { baseReportRunId: id, created: true };
}

/** Normalize SERP engine/provider labels to binding buckets. */
export function normalizeSerpProviderBucket(
  engineOrProvider: string | null | undefined
): "yandex" | "serper" | "base" {
  const e = String(engineOrProvider ?? "")
    .trim()
    .toUpperCase();
  if (!e) return "base";
  if (e.includes("YANDEX")) return "yandex";
  if (e.includes("GOOGLE") || e.includes("SERPER")) return "serper";
  return "base";
}

export type SerpProviderAttributionSource =
  | "persisted_observation_provider"
  | "base_manifest_provider"
  | "agent_run_provider"
  | "provider_task_lineage"
  | "surface_provider"
  | "query_engine"
  | "UNKNOWN";

export type SerpProviderAttributionResult = {
  provider: "yandex" | "serper" | "base";
  engineLabel: string;
  source: SerpProviderAttributionSource;
  /** When lower-precedence sources disagree with the winner. */
  conflictDiagnostic: string | null;
};

/**
 * Кто собрал эту строку выдачи.
 *
 * Порядок один и тот же всегда, и правило у него простое: **сначала то, что
 * записано про саму строку, и только потом то, что известно про прогон**.
 *
 * 1. provider из сохранённого наблюдения
 * 2. engine / source / происхождение задачи — поля самой строки
 * 3. provider агента
 * 4. provider поверхности
 * 5. engine запроса
 * 6. подсказка манифеста прогона — последняя, и только когда она однозначна
 * 7. UNKNOWN
 *
 * Подсказка манифеста стояла второй, и это стоило нам целого поисковика.
 * Манифест перечисляет провайдеров всего прогона, вызывающий брал оттуда
 * первого подходящего — то есть **одно и то же значение подставлялось каждой
 * строке**. Первым в манифесте шёл `yandex`, и 216 строк Google получили ярлык
 * «Яндекс», хотя в поле `engine` у каждой из них стояло `GOOGLE`. В отчёте это
 * выглядело как «Google не собрался»: строка предмета аудита называла один
 * поисковик, таблица показывала яндексовую выдачу, а собранная гугловая
 * растворялась в ней без следа.
 *
 * Признак таких ошибок — сигнал уровня прогона, применённый к отдельной
 * строке. Здесь он теперь последний и работает только когда поисковик в
 * прогоне был один: тогда выбирать не из чего и ошибиться нельзя.
 */
export function resolveSerpProviderAttribution(input: {
  /** 1 — persisted normalized observation provider */
  observationProvider?: string | null;
  /** 2 — base manifest / actualProviders hint */
  manifestProviderHint?: string | null;
  /** 3 — AgentRun provider/type */
  agentRunProvider?: string | null;
  /** 4 — ProviderTask lineage (provider/engine on task) */
  providerTaskLineage?: string | null;
  /** Legacy aliases still accepted via lineage/engine/source */
  engine?: string | null;
  source?: string | null;
  /** 5 — surface item provider */
  surfaceProvider?: string | null;
  /** 6 — query.engine (lowest non-UNKNOWN) */
  queryEngine?: string | null;
}): SerpProviderAttributionResult {
  const ordered: Array<{ value: string | null | undefined; source: SerpProviderAttributionSource }> = [
    { value: input.observationProvider, source: "persisted_observation_provider" },
    {
      value: input.providerTaskLineage ?? input.engine ?? input.source,
      source: "provider_task_lineage",
    },
    { value: input.agentRunProvider, source: "agent_run_provider" },
    { value: input.surfaceProvider, source: "surface_provider" },
    { value: input.queryEngine, source: "query_engine" },
    // Последней и только однозначной: см. объяснение над функцией.
    { value: input.manifestProviderHint, source: "base_manifest_provider" },
  ];

  let winner: SerpProviderAttributionResult | null = null;
  const seenBuckets: Array<{ source: SerpProviderAttributionSource; provider: string }> = [];

  for (const { value, source } of ordered) {
    const bucket = normalizeSerpProviderBucket(value);
    if (bucket === "base") continue;
    const label = String(value ?? "")
      .trim()
      .toUpperCase();
    const engineLabel = label.includes("YANDEX")
      ? "YANDEX"
      : label.includes("GOOGLE") || label.includes("SERPER")
        ? "GOOGLE"
        : label || bucket.toUpperCase();
    seenBuckets.push({ source, provider: bucket });
    if (!winner) {
      winner = {
        provider: bucket,
        engineLabel,
        source,
        conflictDiagnostic: null,
      };
    }
  }

  if (!winner) {
    return {
      provider: "base",
      engineLabel: "UNKNOWN",
      source: "UNKNOWN",
      conflictDiagnostic: null,
    };
  }

  const disagree = seenBuckets.filter((s) => s.provider !== winner!.provider);
  if (disagree.length > 0) {
    winner.conflictDiagnostic = `provider_conflict:winner=${winner.source}:${winner.provider};losers=${disagree
      .map((d) => `${d.source}:${d.provider}`)
      .join(",")}`;
  }
  return winner;
}
