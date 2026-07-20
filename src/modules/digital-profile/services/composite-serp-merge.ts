/**
 * Composite SERP merge: base (manifest IDs only) + Arsenkin enrichment.
 * Dedupes client rows while preserving multi-provider provenance.
 */

import type { PrismaClient } from "@prisma/client";
import type { BaseCollectionManifest, ReportDataBinding } from "./unified-collection-types";
import {
  normalizeSerpProviderBucket,
  resolveSerpProviderAttribution,
} from "./unified-base-report-run";
import { preferNewerCollectedAt } from "./report-material-freshness";

export type CompositeObservation = {
  key: string;
  kind: "organic" | "suggestion" | "paa" | "other";
  /**
   * Fine-grained surface hint preserved from the source row (organic /
   * autocomplete / related / images / video / knowledge_block / wikipedia /
   * ai_answer / indexation / serp_screenshot). Keeps non-organic base surfaces
   * and Arsenkin AI/url-audit rows routable to their deck sections instead of
   * collapsing into "organic".
   */
  surface?: string;
  region?: string;
  engine?: string;
  query?: string;
  url?: string;
  /** Direct image URL for images-surface rows (preview fetch in visual assets). */
  imageUrl?: string;
  title?: string;
  snippet?: string;
  suggestion?: string;
  question?: string;
  providers: string[];
  primaryProvider: string;
  evidenceRefs: string[];
  arsenkinTaskId?: string | null;
  baseSearchResultId?: string | null;
  baseSearchSurfaceItemId?: string | null;
  riskLabel?: string | null;
  /** True when the row came from caseCorpus* manifest IDs (REMEDIATION §1.1). */
  fromCaseCorpus?: boolean;
  /** ISO capture/collection time from DB or enrichment (§7.2). */
  collectedAt?: string;
};

export type CompositeMergeResult = {
  compositeDatasetId: string;
  observations: CompositeObservation[];
  providerCounts: ReportDataBinding["providerCounts"];
  baseCount: number;
  compositeCount: number;
  provenance: {
    unifiedJobId: string;
    baseProviders: string[];
    enrichmentProviders: string[];
    baseSearchResultIds: string[];
    baseSearchSurfaceItemIds: string[];
    enrichmentRunIds: string[];
    /**
     * Case-owned rows from earlier runs of the SAME case (manifest corpus),
     * referenced in addition to the job's delta. Traceable by ID; never mock.
     */
    caseCorpusSearchResultIds?: string[];
    caseCorpusSurfaceItemIds?: string[];
    /** Manifest base IDs skipped as mock/demo (excluded from coverage expected set). */
    skippedMockBaseIds?: string[];
  };
};

/** Fail-closed mock/demo filter for SearchResult and SearchSurfaceItem rows. */
export function isMockBaseRow(row: {
  provider?: string | null;
  source?: string | null;
  title?: string | null;
  url?: string | null;
}): boolean {
  const providerOrSource = `${row.provider ?? ""} ${row.source ?? ""}`;
  return (
    /mock|demo|fixture/i.test(providerOrSource) ||
    /^\[demo\]/i.test(String(row.title ?? "")) ||
    /example\.|images\.example|\.invalid\b/i.test(String(row.url ?? ""))
  );
}

function norm(s: string | null | undefined): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Normalize raw provider region tokens to client region buckets.
 * Yandex numeric region codes (213 = Moscow, 2 = SPb, …) and RU-locale hints
 * collapse to "RU"; UAE/international hints to "UAE". Raw codes leaking into
 * findings previously showed the client "Регионы: 213, RU".
 */
export function normalizeCompositeRegion(raw: string | null | undefined): string | undefined {
  const r = String(raw ?? "").trim();
  if (!r) return undefined;
  const up = r.toUpperCase();
  if (/^\d+$/.test(up)) return "RU";
  if (/UAE|^AE$|INTL|INTERNATIONAL|GLOBAL|DUBAI/.test(up)) return "UAE";
  if (/^RU|RUSSIA|МОСКВА|MOSCOW|MSK|SPB/.test(up)) return "RU";
  return up;
}

function organicKey(region: string, engine: string, query: string, url: string): string {
  return `organic|${norm(region)}|${norm(engine)}|${norm(query)}|${norm(url)}`;
}

function suggestKey(region: string, engine: string, query: string, suggestion: string): string {
  return `suggestion|${norm(region)}|${norm(engine)}|${norm(query)}|${norm(suggestion)}`;
}

function paaKey(region: string, engine: string, query: string, question: string): string {
  return `paa|${norm(region)}|${norm(engine)}|${norm(query)}|${norm(question)}`;
}

/** SearchSurfaceItem.type → fine-grained surface hint. */
function surfaceOfBaseSurfaceType(type: string): string {
  const t = type.toUpperCase();
  if (t.includes("SUGGEST")) return "autocomplete";
  if (t.includes("RELATED") || /PAA|PEOPLE.?ALSO/i.test(t)) return "related";
  if (t.includes("IMAGE")) return "images";
  if (t.includes("VIDEO")) return "video";
  if (t.includes("KNOWLEDGE")) return "knowledge_block";
  if (t.includes("SCREENSHOT")) return "serp_screenshot";
  if (t.includes("ORGANIC")) return "organic";
  return "other";
}

/** Arsenkin tool name → surface hint for kind:"other" rows (AI answers / URL audit). */
function surfaceOfArsenkinTool(tool: string | null | undefined): string | null {
  const t = String(tool ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/ai[-_]?(serp|search)/.test(t)) return "ai_answer";
  if (/check-?h|indexation|url[-_]?audit/.test(t)) return "indexation";
  if (/check-?top|search[-_]?top/.test(t)) return "organic";
  if (/suggest/.test(t)) return "autocomplete";
  if (/paa/.test(t)) return "related";
  return null;
}

function preferRisk(a: string | null | undefined, b: string | null | undefined): string | null {
  const rank = (x: string | null | undefined) => {
    const v = norm(x);
    if (!v) return 0;
    if (v.includes("high") || v.includes("adverse") || v.includes("санк")) return 3;
    if (v.includes("medium") || v.includes("risk")) return 2;
    if (v.includes("low") || v.includes("neutral")) return 1;
    return 1;
  };
  return rank(a) >= rank(b) ? a ?? null : b ?? null;
}

export async function mergeCompositeSerp(input: {
  prisma?: PrismaClient | null;
  manifest: BaseCollectionManifest;
  enrichmentRunIds?: string[];
  arsenkinObservations?: Array<{
    region?: string;
    engine?: string;
    query?: string;
    url?: string;
    title?: string;
    snippet?: string;
    suggestion?: string;
    question?: string;
    kind?: "organic" | "suggestion" | "paa" | "other" | "URL_FETCH_STATUS";
    /** Producing Arsenkin tool (ai-serp / check-h / …) — used as surface hint. */
    tool?: string | null;
    surface?: string;
    providerTaskId?: string | null;
    riskLabel?: string | null;
    clientEvidence?: boolean;
    /** Optional capture time from enrichment rows (§7.2). */
    collectedAt?: string | null;
  }>;
  /** Offline/fixture base rows when prisma unavailable. */
  fixtureBaseRows?: CompositeObservation[];
}): Promise<CompositeMergeResult> {
  const map = new Map<string, CompositeObservation>();
  let yandex = 0;
  let serper = 0;
  const caseCorpusSearchResultIds: string[] = [];
  const caseCorpusSurfaceItemIds: string[] = [];
  const skippedMockBaseIds: string[] = [];
  const corpusResultIdSet = new Set(input.manifest.caseCorpusSearchResultIds ?? []);
  const corpusSurfaceIdSet = new Set(input.manifest.caseCorpusSurfaceItemIds ?? []);

  const add = (row: CompositeObservation, provider: string) => {
    const existing = map.get(row.key);
    if (!existing) {
      map.set(row.key, { ...row, providers: [...row.providers] });
      return;
    }
    const providers = Array.from(new Set([...existing.providers, ...row.providers, provider]));
    existing.providers = providers;
    existing.evidenceRefs = Array.from(new Set([...existing.evidenceRefs, ...row.evidenceRefs]));
    existing.riskLabel = preferRisk(existing.riskLabel, row.riskLabel);
    if (!existing.arsenkinTaskId && row.arsenkinTaskId) existing.arsenkinTaskId = row.arsenkinTaskId;
    if (!existing.imageUrl && row.imageUrl) existing.imageUrl = row.imageUrl;
    if (!existing.baseSearchResultId && row.baseSearchResultId) {
      existing.baseSearchResultId = row.baseSearchResultId;
    }
    if (!existing.baseSearchSurfaceItemId && row.baseSearchSurfaceItemId) {
      existing.baseSearchSurfaceItemId = row.baseSearchSurfaceItemId;
    }
    if (row.fromCaseCorpus) existing.fromCaseCorpus = true;
    const newer = preferNewerCollectedAt(existing.collectedAt, row.collectedAt);
    if (newer) existing.collectedAt = newer;
  };

  if (input.fixtureBaseRows) {
    for (const row of input.fixtureBaseRows) {
      add(row, row.primaryProvider);
      if (row.primaryProvider.includes("yandex")) yandex += 1;
      if (row.primaryProvider.includes("serper") || row.primaryProvider.includes("google")) serper += 1;
      if (row.fromCaseCorpus && row.baseSearchResultId) {
        caseCorpusSearchResultIds.push(row.baseSearchResultId);
      }
      if (row.fromCaseCorpus && row.baseSearchSurfaceItemId) {
        caseCorpusSurfaceItemIds.push(row.baseSearchSurfaceItemId);
      }
    }
  } else if (input.prisma) {
    const resultIds = [
      ...input.manifest.searchResultIds,
      ...(input.manifest.caseCorpusSearchResultIds ?? []),
    ];
    const surfaceIds = [
      ...input.manifest.searchSurfaceItemIds,
      ...(input.manifest.caseCorpusSurfaceItemIds ?? []),
    ];

    const results =
      resultIds.length === 0
        ? []
        : await input.prisma.searchResult.findMany({
            where: { id: { in: resultIds } },
            include: { query: true },
          });
    for (const r of results) {
      if (isMockBaseRow({ source: r.source, title: r.title, url: r.url })) {
        skippedMockBaseIds.push(r.id);
        continue;
      }
      const fromCaseCorpus = corpusResultIdSet.has(r.id);
      if (fromCaseCorpus) caseCorpusSearchResultIds.push(r.id);
      // Prefer SearchResult.engine / source — query.engine alone caused yandex=0 live.
      const meta = (r as { metadataJson?: Record<string, unknown> | null }).metadataJson ?? null;
      const attr = resolveSerpProviderAttribution({
        observationProvider:
          meta && typeof meta.provider === "string" ? meta.provider : null,
        manifestProviderHint:
          input.manifest.actualProviders?.find((p) => /yandex|serper|google/i.test(p.providerId ?? ""))
            ?.providerId ?? null,
        agentRunProvider:
          meta && typeof meta.agentRunProvider === "string" ? meta.agentRunProvider : null,
        providerTaskLineage:
          meta && typeof meta.providerTaskLineage === "string"
            ? meta.providerTaskLineage
            : r.engine ?? r.source,
        engine: r.engine,
        source: r.source,
        queryEngine: r.query?.engine ?? null,
      });
      const engine = attr.engineLabel;
      const provider = attr.provider;
      if (provider === "yandex") yandex += 1;
      if (provider === "serper") serper += 1;
      const key = organicKey("RU", engine, r.query?.queryText ?? "", r.url ?? "");
      add(
        {
          key,
          kind: "organic",
          surface: "organic",
          region: "RU",
          engine,
          query: r.query?.queryText ?? "",
          url: r.url ?? undefined,
          title: r.title ?? undefined,
          snippet: r.snippet ?? undefined,
          providers: [provider],
          primaryProvider: provider,
          evidenceRefs: [`searchResult:${r.id}`],
          baseSearchResultId: r.id,
          riskLabel: null,
          fromCaseCorpus,
          collectedAt: r.createdAt?.toISOString?.() ?? undefined,
        },
        provider
      );
    }

    const surfaces =
      surfaceIds.length === 0
        ? []
        : await input.prisma.searchSurfaceItem.findMany({
            where: { id: { in: surfaceIds } },
          });
    for (const s of surfaces) {
      if (isMockBaseRow({ provider: s.provider, source: s.source, title: s.title, url: s.url })) {
        skippedMockBaseIds.push(s.id);
        continue;
      }
      const fromCaseCorpus = corpusSurfaceIdSet.has(s.id);
      if (fromCaseCorpus) caseCorpusSurfaceItemIds.push(s.id);
      const st = String(s.type ?? "");
      const attr = resolveSerpProviderAttribution({
        surfaceProvider: s.provider,
        source: s.source != null ? String(s.source) : null,
      });
      const engine = attr.engineLabel === "UNKNOWN" ? String(s.provider ?? "UNKNOWN") : attr.engineLabel;
      const provider = attr.provider;
      if (provider === "yandex") yandex += 1;
      else if (provider === "serper") serper += 1;
      const region = normalizeCompositeRegion(s.region);
      let key: string;
      let kind: CompositeObservation["kind"] = "other";
      if (st.includes("SUGGEST")) {
        kind = "suggestion";
        key = suggestKey(region ?? "", engine, String(s.query ?? ""), String(s.title ?? s.snippet ?? ""));
      } else if (st.includes("RELATED") || /paa|people.?also/i.test(st)) {
        kind = "paa";
        key = paaKey(region ?? "", engine, String(s.query ?? ""), String(s.title ?? ""));
      } else if (st.includes("IMAGE")) {
        // Same image URL captured by different runs/queries is ONE client row.
        key = `images|${norm(region)}|${norm(s.url ?? "")}|${norm(s.title ?? "")}`;
      } else {
        key = `surface|${s.id}`;
      }
      const rowImageUrl =
        (s as { imageUrl?: string | null; thumbnailUrl?: string | null }).imageUrl ??
        (s as { thumbnailUrl?: string | null }).thumbnailUrl ??
        null;
      const surfaceTs = s.capturedAt ?? s.createdAt;
      const surfaceCollectedAt =
        surfaceTs instanceof Date ? surfaceTs.toISOString() : undefined;
      add(
        {
          key,
          kind,
          surface: surfaceOfBaseSurfaceType(st),
          region,
          engine,
          query: s.query ?? undefined,
          title: s.title ?? undefined,
          snippet: s.snippet ?? undefined,
          suggestion: kind === "suggestion" ? String(s.title ?? s.snippet ?? "") : undefined,
          question: kind === "paa" ? String(s.title ?? "") : undefined,
          url: s.url ?? undefined,
          imageUrl: st.includes("IMAGE") ? rowImageUrl ?? undefined : undefined,
          providers: [provider],
          primaryProvider: provider,
          evidenceRefs: [`searchSurfaceItem:${s.id}`],
          baseSearchSurfaceItemId: s.id,
          fromCaseCorpus,
          collectedAt: surfaceCollectedAt,
        },
        provider
      );
    }
  }

  let arsenkin = 0;
  for (const obs of input.arsenkinObservations ?? []) {
    // Provenance/diagnostic rows (check-h boolean slots) never enter composite/client evidence.
    if (obs.kind === "URL_FETCH_STATUS" || obs.clientEvidence === false) continue;
    arsenkin += 1;
    const kindRaw = obs.kind ?? (obs.question ? "paa" : obs.suggestion ? "suggestion" : "organic");
    const kind: CompositeObservation["kind"] =
      kindRaw === "suggestion" || kindRaw === "paa" || kindRaw === "organic" || kindRaw === "other"
        ? kindRaw
        : "other";
    const region = normalizeCompositeRegion(obs.region);
    let key: string;
    if (kind === "suggestion") {
      key = suggestKey(region ?? "", obs.engine ?? "", obs.query ?? "", obs.suggestion ?? "");
    } else if (kind === "paa") {
      key = paaKey(region ?? "", obs.engine ?? "", obs.query ?? "", obs.question ?? "");
    } else {
      key = organicKey(region ?? "", obs.engine ?? "", obs.query ?? "", obs.url ?? "");
    }
    const surface =
      obs.surface ??
      surfaceOfArsenkinTool(obs.tool) ??
      (kind === "suggestion" ? "autocomplete" : kind === "paa" ? "related" : kind === "organic" ? "organic" : undefined);
    add(
      {
        key,
        kind,
        surface,
        region,
        engine: obs.engine,
        query: obs.query,
        url: obs.url,
        title: obs.title,
        snippet: obs.snippet,
        suggestion: obs.suggestion,
        question: obs.question,
        providers: ["arsenkin"],
        primaryProvider: "arsenkin",
        evidenceRefs: obs.providerTaskId ? [`providerTask:${obs.providerTaskId}`] : [],
        arsenkinTaskId: obs.providerTaskId ?? null,
        riskLabel: obs.riskLabel,
        collectedAt: obs.collectedAt ? String(obs.collectedAt) : undefined,
      },
      "arsenkin"
    );
  }

  // Primary stays base when both present
  for (const row of map.values()) {
    if (row.providers.includes("yandex") || row.providers.includes("serper")) {
      row.primaryProvider = row.providers.includes("yandex") ? "yandex" : "serper";
    }
  }

  const observations = [...map.values()];
  const compositeDatasetId = `composite-${input.manifest.unifiedJobId}`;
  const baseCount = input.manifest.baseCount;
  if (observations.length < Math.min(baseCount, observations.length) && baseCount > 0) {
    // soft check — hard fail is in report-ready gates when compositeBaseCount < baseCount
  }

  return {
    compositeDatasetId,
    observations,
    providerCounts: {
      yandex,
      serper,
      arsenkin,
      composite: observations.length,
    },
    baseCount,
    compositeCount: observations.length,
    provenance: {
      unifiedJobId: input.manifest.unifiedJobId,
      baseProviders: Array.from(
        new Set(
          input.manifest.actualProviders
            .filter((p) => p.runtime === "real" && p.status === "completed")
            .map((p) => p.providerId)
        )
      ),
      enrichmentProviders: (input.enrichmentRunIds?.length ?? 0) > 0 || (input.arsenkinObservations?.length ?? 0) > 0
        ? ["arsenkin"]
        : [],
      baseSearchResultIds: [...input.manifest.searchResultIds],
      baseSearchSurfaceItemIds: [...input.manifest.searchSurfaceItemIds],
      enrichmentRunIds: input.enrichmentRunIds ?? [],
      ...(caseCorpusSearchResultIds.length > 0
        ? { caseCorpusSearchResultIds: [...new Set(caseCorpusSearchResultIds)] }
        : {}),
      ...(caseCorpusSurfaceItemIds.length > 0
        ? { caseCorpusSurfaceItemIds: [...new Set(caseCorpusSurfaceItemIds)] }
        : {}),
      ...(skippedMockBaseIds.length > 0
        ? { skippedMockBaseIds: [...new Set(skippedMockBaseIds)] }
        : {}),
    },
  };
}

export function buildReportDataBinding(input: {
  caseId: string;
  unifiedJobId: string;
  baseReportRunId: string | null;
  enrichmentRunIds: string[];
  compositeDatasetId: string;
  providerCounts: ReportDataBinding["providerCounts"];
}): ReportDataBinding {
  return {
    version: "report-data-binding-v1",
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId,
    baseReportRunId: input.baseReportRunId,
    enrichmentRunIds: input.enrichmentRunIds,
    compositeDatasetId: input.compositeDatasetId,
    providerCounts: input.providerCounts,
    generatedAt: new Date().toISOString(),
  };
}
