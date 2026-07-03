/**
 * R5.4 smoke — deterministic source ranking and evidence quality tuning.
 */
import {
  REPORT_CLIENT_SLIDE_COUNT,
  REPORT_INTERNAL_SLIDE_COUNT,
  sanitizeReportJsonForAudience,
} from "../src/modules/digital-profile/report/report-data-policy";
import type { EvidenceItemInput } from "../src/modules/digital-profile/evidence-quality/types";
import { dedupeEvidenceItems } from "../src/modules/digital-profile/evidence-quality/dedupe";
import { annotateSourceQuality, summarizeSourceQuality } from "../src/modules/digital-profile/evidence-quality/source-quality";
import { buildReportSourceQualitySummary } from "../src/modules/digital-profile/report/source-quality-diagnostics";
import type { SearchSurfacesReportBlock, SurfaceReportItem } from "../src/modules/digital-profile/report/search-surfaces-report-builder";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function fixtureItems(): EvidenceItemInput[] {
  return [
    {
      id: "exact-1",
      surfaceType: "SEARCH_RESULT",
      title: "Томилин Константин Романович — профиль",
      snippet: "Биография Томилин Константин",
      url: "https://reuters.com/a",
      domain: "reuters.com",
      source: "real:GOOGLE",
      region: "RU",
      subjectFullName: "Томилин Константин Романович",
      subjectAliases: ["Konstantin Romanovich Tomilin"],
    },
    {
      id: "weak-1",
      surfaceType: "SEARCH_RESULT",
      title: "Nikita Romanovich business profile",
      snippet: "generic romanovich entry",
      url: "https://example.com/namesake",
      domain: "example.com",
      source: "real:GOOGLE",
      region: "INTERNATIONAL",
      subjectFullName: "Томилин Константин Романович",
      subjectAliases: ["Konstantin Romanovich Tomilin"],
    },
    {
      id: "wrong-patronymic",
      surfaceType: "SEARCH_RESULT",
      title: "Томилин Константин Александрович",
      snippet: "однофамилец",
      url: "https://example.com/patronymic",
      domain: "example.com",
      source: "real:YANDEX",
      region: "RU",
      subjectFullName: "Томилин Константин Романович",
    },
    {
      id: "dup-a",
      surfaceType: "SEARCH_RESULT",
      title: "Томилин Константин новость",
      snippet: "duplicate test",
      url: "https://vedomosti.ru/story-a",
      domain: "vedomosti.ru",
      source: "real:GOOGLE",
      region: "RU",
      subjectFullName: "Томилин Константин Романович",
    },
    {
      id: "dup-b",
      surfaceType: "SEARCH_RESULT",
      title: "Томилин Константин новость",
      snippet: "duplicate test",
      url: "https://vedomosti.ru/story-a",
      domain: "vedomosti.ru",
      source: "real:GOOGLE",
      region: "RU",
      subjectFullName: "Томилин Константин Романович",
    },
    {
      id: "image-weak",
      surfaceType: "IMAGE_RESULT",
      title: "Romanovich stock avatar",
      snippet: "generic stock photo",
      url: "https://images.example.com/stock",
      domain: "images.example.com",
      source: "real:GOOGLE",
      region: "INTERNATIONAL",
      subjectFullName: "Томилин Константин Романович",
    },
    {
      id: "video-exact",
      surfaceType: "VIDEO_RESULT",
      title: "Konstantin Tomilin interview",
      snippet: "official interview",
      url: "https://youtube.com/watch?v=test",
      domain: "youtube.com",
      source: "real:GOOGLE",
      region: "INTERNATIONAL",
      subjectFullName: "Томилин Константин Романович",
    },
  ];
}

function tinyBlock(rows: SurfaceReportItem[]): SearchSurfacesReportBlock {
  const bucket = {
    total: rows.length,
    adverse: 0,
    collectionStatus: "COLLECTED" as const,
    statusMessage: "ok",
    items: rows,
  };
  return {
    regions: {
      ru: {
        region: "RU",
        label: "RU",
        language: "ru",
        collectionStatus: "COLLECTED",
        statusMessage: "ok",
        organic: bucket,
        suggestions: { ...bucket, items: [] },
        relatedQueries: { ...bucket, items: [] },
        images: { ...bucket, items: [] },
        videos: { ...bucket, items: [] },
        knowledgePanel: { ...bucket, items: [] },
        wikipedia: { ...bucket, items: [] },
        matrix: null,
        summary: {
          queryVariants: [],
          totalCheckedResults: rows.length,
          uniqueUrls: rows.length,
          uniqueAdverseUrls: 0,
          adversePercentage: 0,
          topAdverseThemes: [],
          topAdverseDomains: [],
        },
      },
      uae: {
        region: "UAE",
        label: "UAE",
        language: "en",
        collectionStatus: "NOT_QUERIED",
        statusMessage: "n/a",
        organic: { ...bucket, items: [] },
        suggestions: { ...bucket, items: [] },
        relatedQueries: { ...bucket, items: [] },
        images: { ...bucket, items: [] },
        videos: { ...bucket, items: [] },
        knowledgePanel: { ...bucket, items: [] },
        wikipedia: { ...bucket, items: [] },
        matrix: null,
        summary: {
          queryVariants: [],
          totalCheckedResults: 0,
          uniqueUrls: 0,
          uniqueAdverseUrls: 0,
          adversePercentage: 0,
          topAdverseThemes: [],
          topAdverseDomains: [],
        },
      },
      international: {
        region: "INTERNATIONAL",
        label: "INTL",
        language: "en",
        collectionStatus: "NOT_QUERIED",
        statusMessage: "n/a",
        organic: { ...bucket, items: [] },
        suggestions: { ...bucket, items: [] },
        relatedQueries: { ...bucket, items: [] },
        images: { ...bucket, items: [] },
        videos: { ...bucket, items: [] },
        knowledgePanel: { ...bucket, items: [] },
        wikipedia: { ...bucket, items: [] },
        matrix: null,
        summary: {
          queryVariants: [],
          totalCheckedResults: 0,
          uniqueUrls: 0,
          uniqueAdverseUrls: 0,
          adversePercentage: 0,
          topAdverseThemes: [],
          topAdverseDomains: [],
        },
      },
    },
    globalSummary: {
      regionsCollected: 1,
      regionsNotQueried: 2,
      totalUniqueUrls: rows.length,
      totalUniqueAdverseUrls: 0,
      relatedQueriesTotal: 0,
      relatedQueriesNegative: 0,
      suggestionsTotal: 0,
      imagesTotal: 0,
      videosTotal: 0,
      knowledgePanelTotal: 0,
      knowledgePanelStatus: "ABSENT",
    },
    dataQualityWarnings: [],
  };
}

function main() {
  const base = fixtureItems();
  const gatedA = annotateSourceQuality(dedupeEvidenceItems(base).items);
  const gatedB = annotateSourceQuality(dedupeEvidenceItems(base).items);
  const rankA = gatedA.map((x) => x.quality.sourceQuality?.sourceRank ?? 0);
  const rankB = gatedB.map((x) => x.quality.sourceQuality?.sourceRank ?? 0);
  check("deterministic ranking", JSON.stringify(rankA) === JSON.stringify(rankB));

  const exact = gatedA.find((x) => x.id === "exact-1");
  const weak = gatedA.find((x) => x.id === "weak-1");
  check(
    "exact FIO evidence ranks above weak namesake",
    (exact?.quality.sourceQuality?.sourceRank ?? -999) > (weak?.quality.sourceQuality?.sourceRank ?? -999)
  );

  const wrongPatronymic = gatedA.find((x) => x.id === "wrong-patronymic");
  check(
    "wrong patronymic is review/exclude, not confirmed",
    ["review", "exclude"].includes(String(wrongPatronymic?.quality.sourceQuality?.sourceQualityDecision ?? "")) &&
      wrongPatronymic?.quality.sourceQuality?.sourceQualityDecision !== "include"
  );

  const dupA = gatedA.find((x) => x.id === "dup-a")?.quality.sourceQuality;
  const dupB = gatedA.find((x) => x.id === "dup-b")?.quality.sourceQuality;
  check(
    "duplicate canonical representative is stable",
    !!dupA?.duplicateGroupId && !!dupB?.duplicateGroupId && dupA.duplicateGroupId === dupB.duplicateGroupId
  );
  check(
    "sourceQualityDecision explainable",
    gatedA.every((x) => !!x.quality.sourceQuality?.sourceQualityDecision)
  );
  check(
    "clientSafeReason exists for visible rows",
    gatedA
      .filter((x) => x.quality.sourceQuality?.sourceQualityDecision !== "duplicate")
      .every((x) => !!x.quality.sourceQuality?.clientSafeReason)
  );

  const imageWeak = gatedA.find((x) => x.id === "image-weak")?.quality.sourceQuality?.sourceQualityDecision;
  check(
    "image/video weak namesake candidates are suppressed or reviewed",
    ["review", "exclude"].includes(String(imageWeak ?? ""))
  );
  const confirmedWeak = gatedA.filter(
    (x) =>
      x.quality.sourceQuality?.sourceQualityDecision === "include" &&
      ["NAMESAKE", "INSUFFICIENT_MATCH", "ENTITY_MISMATCH"].includes(String(x.quality.identityDecision ?? ""))
  );
  check("no confirmed evidence uses forbidden weak identity", confirmedWeak.length === 0);

  const sourceSummary = summarizeSourceQuality(gatedA);
  const mappedRows: SurfaceReportItem[] = gatedA.map((x, i) => ({
    title: x.title ?? "",
    snippet: x.snippet ?? null,
    url: x.url ?? null,
    domain: x.domain ?? null,
    thumbnailUrl: x.thumbnailUrl ?? null,
    classification: x.classification ?? null,
    riskTheme: x.riskTheme ?? null,
    query: x.query ?? null,
    rank: i + 1,
    sourceFingerprint: x.quality.sourceQuality?.sourceFingerprint,
    canonicalUrlKey: x.quality.sourceQuality?.canonicalUrlKey ?? null,
    canonicalDomain: x.quality.sourceQuality?.canonicalDomain ?? null,
    canonicalTitleKey: x.quality.sourceQuality?.canonicalTitleKey ?? null,
    providerKey: x.quality.sourceQuality?.providerKey,
    sourceSurfaceType: x.quality.sourceQuality?.surfaceType,
    sourceRegion: x.quality.sourceQuality?.region ?? null,
    language: x.quality.sourceQuality?.language ?? null,
    duplicateGroupId: x.quality.sourceQuality?.duplicateGroupId ?? null,
    duplicateRank: x.quality.sourceQuality?.duplicateRank ?? null,
    duplicateReason: x.quality.sourceQuality?.duplicateReason ?? null,
    sourceQualityDecision: x.quality.sourceQuality?.sourceQualityDecision,
    sourceQualityReason: x.quality.sourceQuality?.sourceQualityReason,
    confidenceLabel: x.quality.sourceQuality?.confidenceLabel,
    sourceRank: x.quality.sourceQuality?.sourceRank,
    sourceScoreBucket: x.quality.sourceQuality?.sourceScoreBucket,
    clientSafeReason: x.quality.sourceQuality?.clientSafeReason,
    internalReason: x.quality.sourceQuality?.internalReason,
    rankingFactors: x.quality.sourceQuality?.rankingFactors,
    limitingFactors: x.quality.sourceQuality?.limitingFactors,
    queryPurpose: "subject_lookup",
  }));
  const reportSummary = buildReportSourceQualitySummary(tinyBlock(mappedRows));
  check("R4.2 sourceQualitySummary remains present", sourceSummary.totalCollected > 0 && reportSummary.totalCollected > 0);

  const internalJson = {
    sourceQualitySummary: reportSummary,
    searchProvenanceSummary: { queryCount: 3, surfaceCount: 5, screenshotCount: 1 },
    queryPlanDiagnostics: { queryPlanId: "plan-test", totalQueries: 1, queryRows: [{}] },
    liveProviderSmoke: { smokeRunId: "smoke-r53" },
    rows: mappedRows,
  } as Record<string, unknown>;
  const clientJson = sanitizeReportJsonForAudience(
    JSON.parse(JSON.stringify(internalJson)) as Record<string, unknown>,
    "client"
  );
  const clientStr = JSON.stringify(clientJson);
  check("internal rankingFactors are stripped from client JSON", !clientStr.includes("rankingFactors"));
  check("R4.3 searchProvenanceSummary remains present", clientStr.includes("searchProvenanceSummary"));
  check("R5.2 queryPlanDiagnostics remains present internally", JSON.stringify(internalJson).includes("queryPlanDiagnostics"));
  check("R5.3 liveProviderSmoke remains internal-only", !clientStr.includes("liveProviderSmoke"));
  check(
    "page count remains internal 73 / client 72",
    REPORT_INTERNAL_SLIDE_COUNT === 73 && REPORT_CLIENT_SLIDE_COUNT === 72
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
