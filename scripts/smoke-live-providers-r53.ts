/**
 * R5.3 smoke — safe live-provider readiness and runtime-mode behavior.
 */
import { runLiveProviderSmoke } from "../src/modules/digital-profile/providers/live-provider-smoke";
import { buildProviderDiagnostics } from "../src/modules/digital-profile/report/provider-diagnostics";
import { buildOrionQueryPlanDetailed } from "../src/modules/digital-profile/search-surfaces/orion-query-plan";
import { buildQueryPlanDiagnostics } from "../src/modules/digital-profile/search-surfaces/query-plan-diagnostics";
import { buildSearchProvenance } from "../src/modules/digital-profile/report/search-provenance";
import {
  REPORT_CLIENT_SLIDE_COUNT,
  REPORT_INTERNAL_SLIDE_COUNT,
  sanitizeReportJsonForAudience,
} from "../src/modules/digital-profile/report/report-data-policy";
import type {
  SearchSurfacesReportBlock,
  SurfaceReportItem,
} from "../src/modules/digital-profile/report/search-surfaces-report-builder";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function tinyBlock(queryText: string): SearchSurfacesReportBlock {
  const mkBucket = (items: SurfaceReportItem[]) => ({
    total: items.length,
    adverse: 0,
    collectionStatus: "COLLECTED" as const,
    statusMessage: "ok",
    items,
  });
  const emptyBucket = mkBucket([]);
  const mkRegion = (items: SurfaceReportItem[]) => ({
    region: "RU" as const,
    label: "RU",
    language: "ru",
    collectionStatus: "COLLECTED" as const,
    statusMessage: "ok",
    organic: mkBucket(items),
    suggestions: emptyBucket,
    relatedQueries: emptyBucket,
    images: emptyBucket,
    videos: emptyBucket,
    knowledgePanel: emptyBucket,
    wikipedia: emptyBucket,
    matrix: null,
    summary: {
      queryVariants: [queryText],
      totalCheckedResults: 1,
      uniqueUrls: 1,
      uniqueAdverseUrls: 0,
      adversePercentage: 0,
      topAdverseThemes: [],
      topAdverseDomains: [],
    },
  });
  const ruItems: SurfaceReportItem[] = [
    {
      title: "Test row",
      snippet: "snippet",
      url: "https://example.com/a",
      domain: "example.com",
      thumbnailUrl: null,
      classification: null,
      riskTheme: null,
      query: queryText,
      rank: 1,
      providerKey: "google",
      sourceQualityDecision: "include",
      sourceFingerprint: "fp-test",
      clientSafeReason: "ok",
    },
  ];
  return {
    regions: {
      ru: mkRegion(ruItems),
      uae: mkRegion([]),
      international: mkRegion([]),
    },
    globalSummary: {
      regionsCollected: 1,
      regionsNotQueried: 2,
      totalUniqueUrls: 1,
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

async function main() {
  const realOnly = await runLiveProviderSmoke({ requestedRuntimeMode: "real_only", allowLiveCalls: false });
  const fallbackMode = await runLiveProviderSmoke({
    requestedRuntimeMode: "real_first_with_fallback",
    allowLiveCalls: false,
    simulateRealFailure: true,
  });
  const mockOnly = await runLiveProviderSmoke({ requestedRuntimeMode: "mock_only", allowLiveCalls: false });
  const invalidMode = await runLiveProviderSmoke({ requestedRuntimeMode: "oops-not-a-mode", allowLiveCalls: false });

  const smokeBlob = JSON.stringify({ realOnly, fallbackMode, mockOnly, invalidMode });
  const sensitiveEnvValues = Object.entries(process.env)
    .filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID|API/i.test(k) && typeof v === "string" && v.length >= 8)
    .map(([, v]) => String(v))
    .filter(Boolean);
  check(
    "no secret env values emitted in diagnostics",
    sensitiveEnvValues.every((v) => !smokeBlob.includes(v))
  );
  check("missing credentials do not crash readiness checks", realOnly.providerRows.length > 0);
  check(
    "real_only does not fall back to mock",
    realOnly.providerRows.every((r) => !(r.runtimeKind === "real" && r.fallbackUsed))
  );
  check(
    "mock_only does not call real providers",
    mockOnly.providerRows.filter((r) => r.runtimeKind === "real").every((r) => !r.smokeAttempted)
  );
  check(
    "real_first_with_fallback records fallback events",
    fallbackMode.providerRows.some((r) => r.runtimeKind === "real" && r.fallbackUsed)
  );
  check(
    "unavailable providers are safely skipped/unavailable",
    realOnly.providerRows.some(
      (r) => r.runtimeKind === "real" && !r.configured && ["unavailable", "fallback"].includes(r.smokeStatus)
    )
  );
  check(
    "configured providers can be marked smokeAttempted",
    mockOnly.providerRows.some((r) => r.configured && r.smokeAttempted)
  );
  check(
    "result payload bodies are not persisted in diagnostics",
    !/rawSnapshot|rawMetadata|\"results\"\s*:/i.test(smokeBlob)
  );
  check(
    "invalid runtimeMode normalizes safely with warning",
    invalidMode.requestedRuntimeMode === "legacy_mock_first" &&
      invalidMode.providerRows.some((r) => (r.warningCodes ?? []).includes("invalid_runtime_mode_normalized"))
  );

  const providerDiagnosticsBase = buildProviderDiagnostics({
    mode: "real_first_with_fallback",
    requestedBy: "test",
  });
  const providerDiagnostics = {
    ...providerDiagnosticsBase,
    runtimeStrategy: {
      ...providerDiagnosticsBase.runtimeStrategy,
      fallbackEvents: [
        {
          providerId: "google",
          reason: "Synthetic smoke fallback",
          from: "real" as const,
          to: "mock" as const,
        },
      ],
    },
  };
  const details = buildOrionQueryPlanDetailed(
    {
      fullName: "Томилин Константин Романович",
      aliases: ["Konstantin Romanovich Tomilin"],
      targetRegions: ["RU", "INTERNATIONAL"],
    },
    { includeRiskProbes: false, maxPrimaryPerRegion: 2 }
  );
  const queryPlanDiagnostics = buildQueryPlanDiagnostics({
    details,
    providerDiagnostics,
  });
  const ruQuery = details.plan.find((q) => q.region === "RU")?.query ?? "\"Томилин Константин\"";
  const searchProvenance = buildSearchProvenance({
    searchSurfaces: tinyBlock(ruQuery),
    searchQueries: [{ id: "q1", queryText: ruQuery, engine: "GOOGLE", source: "GENERATED" }],
    queryPlanDiagnostics,
    providerDiagnostics,
    screenshotProvenance: [
      {
        screenshotId: "sc-1",
        screenshotKind: "synthetic_serp",
        providerId: "synthetic",
        region: "RU",
        language: "ru",
        queryId: "q-test",
        sourceSurfaceIds: ["s-1"],
        generatedFrom: "synthetic_renderer",
        containsHighlightedEvidence: false,
        clientSafeCaption: "Synthetic test screenshot",
      },
    ],
  });
  check("R5.1 providerReadinessSummary remains present", !!providerDiagnostics.providerReadinessSummary);
  check(
    "R5.2 queryPlanDiagnostics remains present",
    queryPlanDiagnostics.totalQueries > 0 && queryPlanDiagnostics.queryRows.length > 0
  );
  check("R4.3 searchProvenanceSummary remains present", searchProvenance.summary.queryCount >= 1);
  check(
    "query lineage carries queryPlanId/provider runtime internally",
    searchProvenance.queryLineage.some((q) => !!q.queryPlanId) &&
      searchProvenance.queryLineage.some((q) => !!q.providerRuntimeKind)
  );
  check(
    "search provenance keeps fallback lineage internally",
    searchProvenance.queryLineage.some((q) => q.fallbackUsed)
  );

  const internalJson = {
    providerReadinessSummary: providerDiagnostics.providerReadinessSummary,
    queryPlanDiagnostics,
    searchProvenanceSummary: searchProvenance.summary,
    searchProvenance,
    liveProviderSmoke: fallbackMode,
  } as Record<string, unknown>;
  const clientJson = sanitizeReportJsonForAudience(
    JSON.parse(JSON.stringify(internalJson)) as Record<string, unknown>,
    "client"
  );
  const clientStr = JSON.stringify(clientJson);
  const internalStr = JSON.stringify(internalJson);
  check("client JSON strips live smoke internals", !clientStr.includes("liveProviderSmoke"));
  check(
    "client JSON strips fallback/runtime internals",
    !clientStr.includes("fallbackProviderId") && !clientStr.includes("warningCodes")
  );
  check("internal JSON keeps safe live smoke diagnostics", internalStr.includes("liveProviderSmoke"));
  check(
    "page count remains internal 73 / client 72",
    REPORT_INTERNAL_SLIDE_COUNT === 73 && REPORT_CLIENT_SLIDE_COUNT === 72
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
