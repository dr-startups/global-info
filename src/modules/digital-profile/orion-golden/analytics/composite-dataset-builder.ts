/**
 * Prompt 2 — analytics composite dataset builder.
 *
 * Additive merge of base Yandex/Serper evidence with all bound Arsenkin
 * enrichment runs. Unlike the render-path cell overlay
 * (composite-serp-overlay-merge.ts), this dataset is analytical:
 * - base is primary and baseCount never decreases;
 * - NO_RESULTS / 500 / NOT_SUPPORTED coverage cells never erase base evidence;
 * - deduplication is normalized by query, engine, region, surface and
 *   URL/domain/result identity; duplicate providers are merged into
 *   provenance instead of dropping rows.
 */

import { createHash } from "node:crypto";
import { publicDomainOf } from "./public-domain";
import type { RawInventoryItem } from "../types";
import {
  mapEngineBucket,
  mapRegionBucket,
  mapSurfaceBucket,
} from "../classic/composite-serp-overlay-merge";
import type { ArsenkinReportBindingV2 } from "../classic/arsenkin-report-binding";
import {
  COMPOSITE_DATASET_SCHEMA_VERSION,
  CompositeDatasetSchema,
  type CompositeDataset,
  type CompositeObservationRow,
} from "../contracts/composite-dataset";

export type CoverageCellStatusRow = {
  region: string;
  engine: string;
  surface: string;
  status: string; // OK | NO_RESULTS | ERROR | NOT_SUPPORTED | HTTP_500 | ...
  provider?: string;
  errorCode?: string | null;
};

export type CompositeProvenanceEntry = {
  observationKey: string;
  owner: "base" | "enrichment";
  providers: string[];
  reportRunIds: string[];
  evidenceRefs: string[];
  duplicateOfBase: boolean;
};

export type CompositeSerpProvenance = {
  schemaVersion: "composite-serp-provenance-v1";
  caseId: string;
  datasetId: string;
  baseReportRunId: string | null;
  enrichmentRunIds: string[];
  baseCount: number;
  compositeCount: number;
  entries: CompositeProvenanceEntry[];
  /** Coverage cells with non-OK statuses; recorded, never destructive. */
  nonOkCoverageCells: CoverageCellStatusRow[];
  preservedBaseKeys: number;
  warnings: string[];
};

export type ProviderDelta = {
  schemaVersion: "provider-delta-v1";
  caseId: string;
  datasetId: string;
  baseCount: number;
  arsenkinObservationCount: number;
  duplicateCount: number;
  uniqueArsenkinCount: number;
  uniqueDomainCount: number;
  relevantCount: number;
  ambiguousCount: number;
  otherSubjectCount: number;
  newAdverseFindingCount: number;
};

export type ReportDataBinding = {
  schemaVersion: "report-data-binding-v1";
  caseId: string;
  datasetId: string;
  baseReportRunId: string | null;
  enrichmentRunIds: string[];
  sourceBindingDigest: string | null;
  artifacts: Array<{ name: string; sha256: string }>;
  generatedAt: string;
};

export type CompositeBuildResult = {
  dataset: CompositeDataset;
  provenance: CompositeSerpProvenance;
  /** Relevance/adverse fields are zero here; the pipeline completes them. */
  providerDelta: ProviderDelta;
  itemsByObservationKey: Map<string, RawInventoryItem[]>;
};

/**
 * Статусы ячеек покрытия, которые записываются в provenance.
 *
 * Записываются, но ничего не удаляют: это единственный канал, которым
 * дека узнаёт, что было с поверхностью. `NOT_COLLECTED` — вопрос не задавали
 * (инструмент не входил в состав прогона); без него страница не отличила бы
 * непроверенную поверхность от проверенной и пустой.
 */
const RECORDED_COVERAGE_STATUSES = new Set([
  "NO_RESULTS",
  "ERROR",
  "HTTP_500",
  "500",
  "NOT_SUPPORTED",
  "NOT_COLLECTED",
]);

export function isArsenkinItem(item: RawInventoryItem): boolean {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  return (
    String(meta.provider ?? "").toLowerCase() === "arsenkin" ||
    String(item.provider ?? "").toLowerCase() === "arsenkin" ||
    String(item.sourceUrl ?? "").startsWith("arsenkin://")
  );
}

export function normalizeUrlForIdentity(url: string | undefined): string {
  if (!url) return "";
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

export const domainOf = publicDomainOf;

/** Normalized identity: query|engine|region|surface|url-or-title-hash. */
export function compositeObservationKey(item: RawInventoryItem): string {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  const engine = mapEngineBucket(String(meta.engine ?? item.provider ?? ""));
  const region = mapRegionBucket(item.region);
  const surface = mapSurfaceBucket(String(meta.surface ?? item.evidenceType ?? "organic"));
  const query = String(meta.queryText ?? item.query ?? "")
    .trim()
    .toLowerCase();
  const urlIdentity = normalizeUrlForIdentity(item.sourceUrl);
  const resultIdentity =
    urlIdentity && !urlIdentity.startsWith("arsenkin:")
      ? urlIdentity
      : createHash("sha1")
          .update(String(item.title ?? "").trim().toLowerCase())
          .digest("hex")
          .slice(0, 16);
  return `${query}|${engine}|${region}|${surface}|${resultIdentity}`;
}

/** Production metadata stores evidenceRefs as strings or ref objects. */
function normalizeEvidenceRefs(value: unknown, fallback: string): string[] {
  if (!Array.isArray(value) || value.length === 0) return [fallback];
  const refs = value
    .map((v) => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const kind = String(o.kind ?? o.type ?? "evidence");
        const id = String(o.id ?? o.ref ?? o.observationId ?? "");
        return id ? `${kind}:${id}` : "";
      }
      return "";
    })
    .filter(Boolean);
  return refs.length > 0 ? refs : [fallback];
}

function toRow(
  item: RawInventoryItem,
  owner: "base" | "enrichment",
  key: string
): CompositeObservationRow {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  const evidenceRefs = normalizeEvidenceRefs(meta.evidenceRefs, `inventory:${item.inventoryId}`);
  const rawRank = typeof meta.rank === "number" ? meta.rank : Number(meta.rank);
  const queryText = String(meta.queryText ?? meta.query ?? item.query ?? "").trim();
  const queryPurpose = String(meta.queryPurpose ?? "").trim();
  const rankSource = String(meta.rankSource ?? "").trim();
  const ranksByProvider = ((): Record<string, number> | undefined => {
    const raw = meta.ranksByProvider;
    if (!raw || typeof raw !== "object") return undefined;
    const pairs = Object.entries(raw as Record<string, unknown>)
      .map(([provider, value]) => [provider, Number(value)] as const)
      .filter(([, value]) => Number.isFinite(value) && value > 0)
      .map(([provider, value]) => [provider, Math.trunc(value)] as const);
    return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
  })();
  const surface = mapSurfaceBucket(String(meta.surface ?? item.evidenceType ?? "organic"));
  const snippet = String(item.snippet ?? "").trim();
  return {
    observationKey: key,
    ...(Number.isFinite(rawRank) && rawRank > 0 ? { rank: Math.trunc(rawRank) } : {}),
    // Источник позиции без позиции не существует: поле едет вместе с рангом.
    ...(Number.isFinite(rawRank) && rawRank > 0 && rankSource ? { rankSource } : {}),
    // Номера обоих чтений — ими лист объясняет пропуск номера в таблице. Поле
    // необязательное: наборы, снятые до его проводки, его не несут, и ветка
    // «номер занят материалом, показанным выше» у них не исполняется вовсе.
    ...(ranksByProvider ? { ranksByProvider } : {}),
    ...(queryText ? { query: queryText } : {}),
    ...(queryPurpose ? { queryPurpose } : {}),
    // Пометка живёт при своём запросе: без текста запроса она не значит
    // ничего, а таблица строится по разрезу «запрос × поисковик».
    ...(queryText && meta.subjectNameQuery === true ? { subjectNameQuery: true } : {}),
    provider: String(item.provider ?? "unknown").toLowerCase(),
    providers: [String(item.provider ?? "unknown").toLowerCase()],
    engine: mapEngineBucket(String(meta.engine ?? item.provider ?? "")),
    surface,
    region: mapRegionBucket(item.region),
    url: item.sourceUrl,
    title: item.title,
    // Текст едет только у ответов ИИ-поиска: их страница печатает целиком.
    ...(surface === "ai_answer" && snippet ? { snippet } : {}),
    domain: domainOf(item.sourceUrl) || undefined,
    evidenceRefs,
    provenanceOwner: owner,
  };
}

export function buildAnalyticsCompositeDataset(input: {
  caseId: string;
  /**
   * Идентификатор набора, отчеканенный при слиянии (`composite-<unifiedJobId>`).
   * Параметр обязателен намеренно: пока у набора была вторая чеканка — здесь, —
   * дека несла один идентификатор, а привязка джобы другой, и реюз собранной
   * деки не срабатывал никогда. Значение по умолчанию воскресило бы второй
   * ответ. Содержательный отпечаток набора при этом не потерян: он живёт
   * отдельным полем `sourceHashes` ниже — это данные, а не идентичность.
   */
  datasetId: string;
  baseItems: RawInventoryItem[];
  enrichmentItems: RawInventoryItem[];
  binding: ArsenkinReportBindingV2 | null;
  coverageRows: CoverageCellStatusRow[];
  baseReportRunId: string | null;
  /** Reconciled, ordered enrichment runs (fail-closed). Falls back to binding. */
  enrichmentRunIds?: string[];
}): CompositeBuildResult {
  const warnings: string[] = [];
  const rows = new Map<string, CompositeObservationRow>();
  const provenanceEntries = new Map<string, CompositeProvenanceEntry>();
  const itemsByKey = new Map<string, RawInventoryItem[]>();

  const enrichmentRunIds =
    input.enrichmentRunIds ??
    input.binding?.enrichmentRuns?.map((r) => r.reportRunId).filter(Boolean) ??
    [];

  // Base first: base is primary and can never be displaced.
  for (const item of input.baseItems) {
    const key = compositeObservationKey(item);
    const bucket = itemsByKey.get(key) ?? [];
    bucket.push(item);
    itemsByKey.set(key, bucket);
    const existing = rows.get(key);
    if (existing) {
      const provider = String(item.provider ?? "unknown").toLowerCase();
      if (!existing.providers.includes(provider)) existing.providers.push(provider);
      const entry = provenanceEntries.get(key)!;
      if (!entry.providers.includes(provider)) entry.providers.push(provider);
      entry.evidenceRefs.push(`inventory:${item.inventoryId}`);
      continue;
    }
    rows.set(key, toRow(item, "base", key));
    provenanceEntries.set(key, {
      observationKey: key,
      owner: "base",
      providers: [String(item.provider ?? "unknown").toLowerCase()],
      reportRunIds: [item.reportRunId],
      evidenceRefs: [`inventory:${item.inventoryId}`],
      duplicateOfBase: false,
    });
  }
  const baseCount = rows.size;

  // Enrichment overlay: additive only. Duplicates merge provenance.
  let duplicateCount = 0;
  const newDomains = new Set<string>();
  const baseDomains = new Set(
    [...rows.values()].map((r) => r.domain ?? "").filter(Boolean)
  );
  for (const item of input.enrichmentItems) {
    const key = compositeObservationKey(item);
    const bucket = itemsByKey.get(key) ?? [];
    bucket.push(item);
    itemsByKey.set(key, bucket);
    const provider = String(item.provider ?? "arsenkin").toLowerCase();
    const existing = rows.get(key);
    if (existing) {
      duplicateCount += 1;
      if (!existing.providers.includes(provider)) existing.providers.push(provider);
      const entry = provenanceEntries.get(key)!;
      if (!entry.providers.includes(provider)) entry.providers.push(provider);
      if (!entry.reportRunIds.includes(item.reportRunId)) entry.reportRunIds.push(item.reportRunId);
      entry.evidenceRefs.push(`inventory:${item.inventoryId}`);
      entry.duplicateOfBase = entry.owner === "base";
      continue;
    }
    rows.set(key, toRow(item, "enrichment", key));
    provenanceEntries.set(key, {
      observationKey: key,
      owner: "enrichment",
      providers: [provider],
      reportRunIds: [item.reportRunId],
      evidenceRefs: [`inventory:${item.inventoryId}`],
      duplicateOfBase: false,
    });
    const d = domainOf(item.sourceUrl);
    if (d && !baseDomains.has(d)) newDomains.add(d);
  }

  // Non-OK coverage statuses are recorded but never remove evidence.
  const nonOkCoverageCells = input.coverageRows.filter((c) =>
    RECORDED_COVERAGE_STATUSES.has(String(c.status ?? "").toUpperCase())
  );
  if (nonOkCoverageCells.length > 0) {
    warnings.push(`non-ok-coverage-cells:${nonOkCoverageCells.length} (recorded, not destructive)`);
  }

  const observations = [...rows.values()];
  const compositeCount = observations.length;
  if (compositeCount < baseCount) {
    // Structurally impossible; guard for regressions.
    warnings.push(`INVARIANT_VIOLATION base=${baseCount} composite=${compositeCount}`);
  }

  const sourceHashes = [
    `sha256:${createHash("sha256")
      .update(JSON.stringify(observations.map((o) => o.observationKey).sort()))
      .digest("hex")}`,
  ];

  const dataset: CompositeDataset = CompositeDatasetSchema.parse({
    schemaVersion: COMPOSITE_DATASET_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes,
    evidenceRefs: observations.slice(0, 50).flatMap((o) => o.evidenceRefs.slice(0, 1)),
    baseReportRunId: input.baseReportRunId,
    enrichmentRunIds,
    baseCount,
    enrichmentCount: input.enrichmentItems.length,
    compositeCount,
    duplicateCount,
    observations,
  });

  const provenance: CompositeSerpProvenance = {
    schemaVersion: "composite-serp-provenance-v1",
    caseId: input.caseId,
    datasetId: input.datasetId,
    baseReportRunId: input.baseReportRunId,
    enrichmentRunIds,
    baseCount,
    compositeCount,
    entries: [...provenanceEntries.values()],
    nonOkCoverageCells,
    preservedBaseKeys: baseCount,
    warnings,
  };

  const providerDelta: ProviderDelta = {
    schemaVersion: "provider-delta-v1",
    caseId: input.caseId,
    datasetId: input.datasetId,
    baseCount,
    arsenkinObservationCount: input.enrichmentItems.length,
    duplicateCount,
    uniqueArsenkinCount: compositeCount - baseCount,
    uniqueDomainCount: newDomains.size,
    relevantCount: 0,
    ambiguousCount: 0,
    otherSubjectCount: 0,
    newAdverseFindingCount: 0,
  };

  return { dataset, provenance, providerDelta, itemsByObservationKey: itemsByKey };
}
