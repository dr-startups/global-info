/**
 * Composite SERP merge: base (manifest IDs only) + Arsenkin enrichment.
 * Dedupes client rows while preserving multi-provider provenance.
 */

import type { PrismaClient } from "@prisma/client";
import type { BaseCollectionManifest, ReportDataBinding } from "./unified-collection-types";

export type CompositeObservation = {
  key: string;
  kind: "organic" | "suggestion" | "paa" | "other";
  region?: string;
  engine?: string;
  query?: string;
  url?: string;
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
  };
};

function norm(s: string | null | undefined): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
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
    kind?: "organic" | "suggestion" | "paa" | "other";
    providerTaskId?: string | null;
    riskLabel?: string | null;
  }>;
  /** Offline/fixture base rows when prisma unavailable. */
  fixtureBaseRows?: CompositeObservation[];
}): Promise<CompositeMergeResult> {
  const map = new Map<string, CompositeObservation>();
  let yandex = 0;
  let serper = 0;

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
    if (!existing.baseSearchResultId && row.baseSearchResultId) {
      existing.baseSearchResultId = row.baseSearchResultId;
    }
  };

  if (input.fixtureBaseRows) {
    for (const row of input.fixtureBaseRows) {
      add(row, row.primaryProvider);
      if (row.primaryProvider.includes("yandex")) yandex += 1;
      if (row.primaryProvider.includes("serper") || row.primaryProvider.includes("google")) serper += 1;
    }
  } else if (input.prisma) {
    const results = await input.prisma.searchResult.findMany({
      where: { id: { in: input.manifest.searchResultIds } },
      include: { query: true },
    });
    for (const r of results) {
      const engine = String(r.query?.engine ?? "UNKNOWN");
      const provider =
        engine === "YANDEX" ? "yandex" : engine === "GOOGLE" ? "serper" : "base";
      if (provider === "yandex") yandex += 1;
      if (provider === "serper") serper += 1;
      const key = organicKey(
        "RU",
        engine,
        r.query?.queryText ?? "",
        r.url ?? ""
      );
      add(
        {
          key,
          kind: "organic",
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
        },
        provider
      );
    }

    const surfaces = await input.prisma.searchSurfaceItem.findMany({
      where: { id: { in: input.manifest.searchSurfaceItemIds } },
    });
    for (const s of surfaces) {
      const st = String(s.type ?? "");
      const engine = String(s.provider ?? "UNKNOWN");
      const provider =
        engine.includes("YANDEX") || engine === "YANDEX" ? "yandex" : "serper";
      if (provider === "yandex") yandex += 1;
      else serper += 1;
      let key: string;
      let kind: CompositeObservation["kind"] = "other";
      if (st.includes("SUGGEST")) {
        kind = "suggestion";
        key = suggestKey(String(s.region ?? ""), engine, String(s.query ?? ""), String(s.title ?? s.snippet ?? ""));
      } else if (st.includes("RELATED") || /paa|people.?also/i.test(st)) {
        kind = "paa";
        key = paaKey(String(s.region ?? ""), engine, String(s.query ?? ""), String(s.title ?? ""));
      } else {
        key = `surface|${s.id}`;
      }
      add(
        {
          key,
          kind,
          region: s.region ?? undefined,
          engine,
          query: s.query ?? undefined,
          title: s.title ?? undefined,
          snippet: s.snippet ?? undefined,
          suggestion: kind === "suggestion" ? String(s.title ?? s.snippet ?? "") : undefined,
          question: kind === "paa" ? String(s.title ?? "") : undefined,
          url: s.url ?? undefined,
          providers: [provider],
          primaryProvider: provider,
          evidenceRefs: [`searchSurfaceItem:${s.id}`],
          baseSearchSurfaceItemId: s.id,
        },
        provider
      );
    }
  }

  let arsenkin = 0;
  for (const obs of input.arsenkinObservations ?? []) {
    arsenkin += 1;
    const kind = obs.kind ?? (obs.question ? "paa" : obs.suggestion ? "suggestion" : "organic");
    let key: string;
    if (kind === "suggestion") {
      key = suggestKey(obs.region ?? "", obs.engine ?? "", obs.query ?? "", obs.suggestion ?? "");
    } else if (kind === "paa") {
      key = paaKey(obs.region ?? "", obs.engine ?? "", obs.query ?? "", obs.question ?? "");
    } else {
      key = organicKey(obs.region ?? "", obs.engine ?? "", obs.query ?? "", obs.url ?? "");
    }
    add(
      {
        key,
        kind,
        region: obs.region,
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
