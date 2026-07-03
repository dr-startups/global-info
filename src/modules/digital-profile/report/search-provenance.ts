import type {
  ReportProviderDiagnostics,
  ReportQueryPlanDiagnostics,
  ReportQueryLineageRow,
  ReportSearchProvenanceSummary,
  ReportSearchSurfaceProvenanceRow,
  ReportScreenshotProvenanceRow,
  ReportSourceProvenanceRow,
} from "../types";
import type {
  SearchSurfacesReportBlock,
  SurfaceReportItem,
} from "./search-surfaces-report-builder";

interface SearchQueryRow {
  id: string;
  queryText: string;
  engine?: string | null;
  source?: string | null;
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function queryPurpose(queryText: string, surfaceType: string): ReportQueryLineageRow["queryPurpose"] {
  const q = queryText.toLowerCase();
  if (surfaceType === "image") return "media_lookup";
  if (surfaceType === "video") return "media_lookup";
  if (surfaceType === "suggestion") return "suggestion_lookup";
  if (surfaceType === "related") return "related_lookup";
  if (surfaceType === "wikipedia") return "wikipedia_lookup";
  if (/санкц|court|sanction|суд|fraud|скандал|offshore/i.test(q)) return "adverse_lookup";
  return "subject_lookup";
}

function providerLabel(providerId: string): string {
  if (providerId === "google") return "Google";
  if (providerId === "yandex") return "Yandex";
  if (providerId === "serper") return "Serper";
  if (providerId === "wikipedia") return "Wikipedia";
  return providerId || "unknown";
}

function flattenSurfaceRows(block: SearchSurfacesReportBlock): Array<{
  region: string;
  language: string;
  bucket: string;
  row: SurfaceReportItem;
}> {
  const out: Array<{ region: string; language: string; bucket: string; row: SurfaceReportItem }> = [];
  for (const [regionCode, region] of Object.entries(block.regions)) {
    for (const bucket of [
      "organic",
      "suggestions",
      "relatedQueries",
      "images",
      "videos",
      "knowledgePanel",
      "wikipedia",
    ] as const) {
      const b = region[bucket];
      for (const row of b.items ?? []) {
        out.push({ region: regionCode.toUpperCase(), language: region.language, bucket, row });
      }
    }
  }
  return out;
}

function bucketToSurfaceType(bucket: string): ReportSearchSurfaceProvenanceRow["surfaceType"] {
  if (bucket === "organic") return "organic";
  if (bucket === "suggestions") return "suggestion";
  if (bucket === "relatedQueries") return "related";
  if (bucket === "images") return "image";
  if (bucket === "videos") return "video";
  if (bucket === "wikipedia") return "wikipedia";
  return "unknown";
}

function mkQueryId(providerId: string, region: string, queryText: string): string {
  return `q-${providerId}-${region}-${normalizeQuery(queryText).slice(0, 32).replace(/[^a-z0-9]+/g, "-")}`;
}

export function buildSearchProvenance(input: {
  searchSurfaces?: SearchSurfacesReportBlock;
  searchQueries?: SearchQueryRow[];
  queryPlanDiagnostics?: ReportQueryPlanDiagnostics;
  providerDiagnostics?: ReportProviderDiagnostics;
  sourceProvenance?: ReportSourceProvenanceRow[];
  screenshotProvenance?: ReportScreenshotProvenanceRow[];
  reportLanguage?: "ru" | "en";
}): {
  queryLineage: ReportQueryLineageRow[];
  surfaceProvenance: ReportSearchSurfaceProvenanceRow[];
  summary: ReportSearchProvenanceSummary;
} {
  const surfaces = input.searchSurfaces;
  const queryPlanRows = input.queryPlanDiagnostics?.queryRows ?? [];
  const queryPlanByText = new Map<string, (typeof queryPlanRows)[number]>();
  for (const row of queryPlanRows) {
    const key = `${String(row.region ?? "").toUpperCase()}|${normalizeQuery(String(row.queryText ?? ""))}`;
    if (!queryPlanByText.has(key)) queryPlanByText.set(key, row);
  }
  const ru = input.reportLanguage !== "en";
  if (!surfaces) {
    return {
      queryLineage: [],
      surfaceProvenance: [],
      summary: {
        queryCount: 0,
        surfaceCount: 0,
        screenshotCount: input.screenshotProvenance?.length ?? 0,
        realScreenshotCount: 0,
        syntheticScreenshotCount: 0,
        fallbackScreenshotCount: 0,
        linkedEvidenceCount: 0,
        unlinkedEvidenceCount: 0,
        byProvider: {},
        bySurfaceType: {},
        byRegion: {},
        warnings: ["search_surfaces_missing"],
        searchSourcesReviewed: 0,
        evidenceLinkedCount: 0,
        screenshotSummaryLabel: ru
          ? "Снимки поиска недоступны"
          : "Search snapshots unavailable",
        safeNote: ru
          ? "Поисковые снимки формируются из собранных результатов поиска."
          : "Search snapshots are generated from collected search results.",
      },
    };
  }

  const flat = flattenSurfaceRows(surfaces);
  const surfaceProvenance: ReportSearchSurfaceProvenanceRow[] = [];
  const byProvider: Record<string, number> = {};
  const bySurfaceType: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  const queryMap = new Map<string, ReportQueryLineageRow>();

  for (const rec of flat) {
    const row = rec.row;
    const pId = String(row.providerKey ?? "unknown");
    const pLabel = providerLabel(pId);
    const sType = bucketToSurfaceType(rec.bucket);
    const qText = String(row.query ?? row.title ?? "").trim();
    const qId = qText ? mkQueryId(pId, rec.region, qText) : undefined;
    const decision = String(row.sourceQualityDecision ?? "");
    const isExcluded = decision === "exclude" || decision === "duplicate";
    const isSelected = decision === "include" || decision === "review";
    const surfaceId = `s-${rec.region}-${rec.bucket}-${surfaceProvenance.length + 1}`;

    surfaceProvenance.push({
      surfaceId,
      surfaceType: sType,
      region: rec.region,
      language: rec.language,
      providerId: pId,
      providerLabel: pLabel,
      queryId: qId,
      sourceFingerprint: row.sourceFingerprint,
      duplicateGroupId: row.duplicateGroupId ?? undefined,
      sourceQualityDecision: decision || undefined,
      inclusionReason: row.sourceQualityReason ?? undefined,
      clientSafeReason: row.clientSafeReason ?? undefined,
      evidencePageRefs: ["appendix", "top_results"],
      reportPageRefs:
        sType === "organic"
          ? rec.region === "RU"
            ? [8, 53]
            : [24, 56]
          : sType === "image"
            ? [13, rec.region === "RU" ? 59 : 59]
            : sType === "video"
              ? [14, rec.region === "RU" ? 59 : 59]
              : undefined,
    });

    byProvider[pId] = (byProvider[pId] ?? 0) + 1;
    bySurfaceType[sType] = (bySurfaceType[sType] ?? 0) + 1;
    byRegion[rec.region] = (byRegion[rec.region] ?? 0) + 1;

    if (qId) {
      const ex = queryMap.get(qId);
      if (!ex) {
        queryMap.set(qId, {
          queryId: qId,
          queryPlanId:
            queryPlanByText.get(`${rec.region}|${normalizeQuery(qText)}`)?.queryId ?? undefined,
          queryText: qText,
          normalizedQuery: normalizeQuery(qText),
          queryLanguage: rec.language,
          queryRegion: rec.region,
          queryPurpose: queryPurpose(qText, sType),
          providerId: pId,
          providerLabel: pLabel,
          providerRuntimeKind:
            input.providerDiagnostics?.providers?.find((p) => p.id === pId)?.runtimeKind,
          issuedAtLabel: "run_current",
          resultCount: 1,
          selectedCount: isSelected ? 1 : 0,
          excludedCount: isExcluded ? 1 : 0,
          duplicateCount: decision === "duplicate" ? 1 : 0,
          fallbackUsed: decision === "fallback",
          fallbackReason: row.duplicateReason ?? undefined,
          sourceSurfaceIds: [surfaceId],
          relatedScreenshotIds: [],
        });
      } else {
        ex.resultCount += 1;
        if (isSelected) ex.selectedCount += 1;
        if (isExcluded) ex.excludedCount += 1;
        if (decision === "duplicate") ex.duplicateCount += 1;
        ex.sourceSurfaceIds.push(surfaceId);
      }
    }
  }

  for (const q of input.searchQueries ?? []) {
    const providerId =
      String(q.engine ?? "").toUpperCase() === "YANDEX"
        ? "yandex"
        : String(q.engine ?? "").toUpperCase() === "GOOGLE"
          ? "google"
          : "unknown";
    const queryRegion = providerId === "yandex" ? "RU" : "INTERNATIONAL";
    const queryId = mkQueryId(providerId, queryRegion, q.queryText);
    const planMeta = queryPlanByText.get(`${queryRegion}|${normalizeQuery(q.queryText)}`);
    if (!queryMap.has(queryId)) {
      queryMap.set(queryId, {
        queryId,
        queryPlanId: planMeta?.queryId,
        queryText: q.queryText,
        normalizedQuery: normalizeQuery(q.queryText),
        queryLanguage: queryRegion === "RU" ? "ru" : "en",
        queryRegion,
        queryPurpose:
          planMeta?.purpose === "adverse_lookup"
            ? "adverse_lookup"
            : planMeta?.purpose === "media_lookup" ||
                planMeta?.purpose === "image_lookup" ||
                planMeta?.purpose === "video_lookup"
              ? "media_lookup"
              : planMeta?.purpose === "suggestion_lookup"
                ? "suggestion_lookup"
                : planMeta?.purpose === "related_lookup"
                  ? "related_lookup"
                  : planMeta?.purpose === "wikipedia_lookup"
                    ? "wikipedia_lookup"
                    : queryPurpose(q.queryText, "organic"),
        providerId,
        providerLabel: providerLabel(providerId),
        providerRuntimeKind:
          input.providerDiagnostics?.providers?.find((p) => p.id === providerId)?.runtimeKind,
        issuedAtLabel: "run_current",
        resultCount: 0,
        selectedCount: 0,
        excludedCount: 0,
        duplicateCount: 0,
        fallbackUsed: false,
        sourceSurfaceIds: [],
        relatedScreenshotIds: [],
      });
    }
  }

  const queryLineage = [...queryMap.values()].sort((a, b) =>
    a.queryId.localeCompare(b.queryId)
  );
  const relatedScreenshotIds = (input.screenshotProvenance ?? [])
    .map((s) => s.screenshotId)
    .filter(Boolean);
  if (relatedScreenshotIds.length > 0) {
    for (const q of queryLineage) {
      q.relatedScreenshotIds = [...relatedScreenshotIds];
    }
  }
  const linkedEvidenceCount = surfaceProvenance.filter((s) => Boolean(s.queryId)).length;
  const unlinkedEvidenceCount = surfaceProvenance.length - linkedEvidenceCount;
  const screenshots = input.screenshotProvenance ?? [];
  const realScreenshotCount = screenshots.filter((s) => s.screenshotKind === "real_serp").length;
  const syntheticScreenshotCount = screenshots.filter(
    (s) => s.screenshotKind === "synthetic_serp"
  ).length;
  const fallbackScreenshotCount = screenshots.filter(
    (s) => s.screenshotKind === "fallback_serp"
  ).length;

  const summary: ReportSearchProvenanceSummary = {
    queryCount: queryLineage.length,
    surfaceCount: surfaceProvenance.length,
    screenshotCount: screenshots.length,
    realScreenshotCount,
    syntheticScreenshotCount,
    fallbackScreenshotCount,
    linkedEvidenceCount,
    unlinkedEvidenceCount,
    byProvider,
    bySurfaceType,
    byRegion,
    warnings: unlinkedEvidenceCount > 0 ? ["unlinked_surface_rows"] : [],
    searchSourcesReviewed: queryLineage.length,
    evidenceLinkedCount: linkedEvidenceCount,
    screenshotSummaryLabel:
      syntheticScreenshotCount > 0
        ? ru
          ? "Поисковые снимки сформированы из собранных результатов."
          : "Search snapshots generated from collected results."
        : ru
          ? "Снимок поисковой выдачи отсутствует."
          : "No search snapshot available.",
    safeNote: ru
      ? "Поисковые снимки формируются из собранных результатов поиска и связанных строк материалов."
      : "Search snapshots are generated from collected search results and linked evidence rows.",
  };

  return { queryLineage, surfaceProvenance, summary };
}
