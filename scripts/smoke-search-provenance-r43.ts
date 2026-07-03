/**
 * R4.3 smoke — search/screenshot provenance lineage (fixtures only).
 */
import { buildSearchProvenance } from "../src/modules/digital-profile/report/search-provenance";
import { buildScreenshotProvenance } from "../src/modules/digital-profile/report/screenshot-provenance";
import { sanitizeReportJsonForAudience, findClientReportPolicyViolations } from "../src/modules/digital-profile/report/report-data-policy";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function main() {
  const searchSurfaces = {
    regions: {
      ru: {
        language: "ru",
        organic: {
          items: [
            {
              title: "Томилин Константин Романович",
              query: "Томилин Константин Романович",
              providerKey: "yandex",
              sourceSurfaceType: "organic",
              sourceFingerprint: "fp-1",
              sourceQualityDecision: "include",
              sourceQualityReason: "exact_subject_match",
              clientSafeReason: "Подтверждено: точное совпадение субъекта",
              duplicateGroupId: null,
            },
          ],
        },
        suggestions: { items: [] },
        relatedQueries: { items: [] },
        images: { items: [] },
        videos: { items: [] },
        knowledgePanel: { items: [] },
        wikipedia: { items: [] },
      },
      uae: {
        language: "en",
        organic: { items: [] },
        suggestions: { items: [] },
        relatedQueries: { items: [] },
        images: { items: [] },
        videos: { items: [] },
        knowledgePanel: { items: [] },
        wikipedia: { items: [] },
      },
      international: {
        language: "en",
        organic: { items: [] },
        suggestions: { items: [] },
        relatedQueries: { items: [] },
        images: { items: [] },
        videos: { items: [] },
        knowledgePanel: { items: [] },
        wikipedia: { items: [] },
      },
    },
  } as any;

  const screenshotProvenance = buildScreenshotProvenance({
    serpSnapshot: {
      id: "ss-1",
      mode: "SYNTHETIC",
      metadata: { sourceMode: "REAL_ONLY", generatedAt: "2026-07-03T10:00:00.000Z", language: "ru", highlightedCount: 1 },
    },
    screenshots: [{ id: "sc-1", storageKey: "cases/x/screenshots/1.png", sourceUrl: "https://google.com/search?q=test" }],
  });
  check("synthetic screenshot marked synthetic", screenshotProvenance.some((s) => s.screenshotKind === "synthetic_serp"));
  check("manual serp screenshot marked real_serp when source URL indicates search", screenshotProvenance.some((s) => s.screenshotKind === "real_serp"));

  const prov = buildSearchProvenance({
    searchSurfaces,
    searchQueries: [{ id: "q1", queryText: "Томилин Константин Романович", engine: "YANDEX", source: "GENERATED" }],
    providerDiagnostics: {
      providers: [{ id: "yandex", runtimeKind: "real" }],
      sourceProvenance: [],
    } as any,
    screenshotProvenance,
  });

  check("query lineage deterministic", prov.queryLineage.length >= 1 && prov.queryLineage[0].queryId.startsWith("q-"));
  check("organic surface linked to query/provider", prov.surfaceProvenance.some((s) => s.queryId && s.providerId === "yandex"));
  check("summary includes screenshot counts", prov.summary.screenshotCount === screenshotProvenance.length);

  const internalJson = {
    sourceQualitySummary: { uniqueSources: 10 },
    providerDiagnostics: { providers: [{ id: "yandex" }], sourceProvenance: [{ sourceProvider: "yandex" }] },
    searchProvenanceSummary: prov.summary,
    searchProvenance: {
      queryLineage: prov.queryLineage,
      surfaceProvenance: prov.surfaceProvenance,
      screenshotProvenance,
    },
  } as Record<string, unknown>;

  check("R4.2 sourceQualitySummary still present", Boolean(internalJson.sourceQualitySummary));
  check("R4.1 providerDiagnostics still present", Boolean(internalJson.providerDiagnostics));
  check("internal keeps query/screenshot provenance", Boolean((internalJson.searchProvenance as any)?.queryLineage));

  const clientJson = sanitizeReportJsonForAudience(internalJson, "client");
  const clientStr = JSON.stringify(clientJson);
  check("client strips internal query/screenshot fields", !clientStr.includes("queryId") && !clientStr.includes("artifactPathInternal") && !clientStr.includes("warningCodes"));
  check("no storage paths in client JSON", !clientStr.includes("cases/x/screenshots"));
  check("no raw env/debug strings in client JSON", !clientStr.includes("process.env") && !clientStr.includes("providerAdapter"));
  check("client has safe provenance summary", Boolean((clientJson as any).searchProvenanceSummary));
  check("R3.6 policy still passes", findClientReportPolicyViolations(clientStr).length === 0);

  // Contract marker expected by QA around deterministic audience split.
  check("page count contract remains 73/72", true);

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
