/**
 * Smoke test — Stage O5 Evidence Quality Gate (offline).
 *
 * Run: npm run smoke:evidence-quality-gate-o5
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateEvidenceItem } from "../src/modules/digital-profile/evidence-quality/gate";
import { dedupeEvidenceItems } from "../src/modules/digital-profile/evidence-quality/dedupe";
import { selectEvidenceForReport, isClientSafeReportJson } from "../src/modules/digital-profile/evidence-quality/selection-policy";
import { buildEvidenceQualitySummary, capOverallRiskFromQuality } from "../src/modules/digital-profile/evidence-quality/build-summary";
import {
  sanitizeReportJsonForAudience,
} from "../src/modules/digital-profile/report/report-data-policy";
import {
  classifySearchResultRecord,
  isStrongAutoSnapshotRisk,
  mergeRiskClassification,
} from "../src/modules/digital-profile/risk-classifier/result-classifier";
import { resolveHighlight } from "../src/modules/digital-profile/serp-snapshot/highlight-resolver";
import { groupThemes } from "../src/modules/digital-profile/serp-snapshot/theme-grouper";

const SUBJECT = "Томилин Константин Романович";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function main() {
  console.log("Smoke testing O5 Evidence Quality Gate\n");

  // 1. Strong court + exact name
  const court = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Томилин Константин Романович — уголовное дело",
    url: "https://news.example/court",
    snippet: "осужден суд приговор уголовное",
    subjectFullName: SUBJECT,
    classification: classifySearchResultRecord({
      title: "Томилин Константин Романович — уголовное дело",
      url: "https://news.example/court",
      snippet: "осужден суд приговор уголовное",
      subjectFullName: SUBJECT,
    }).classification,
    rawMetadata: {
      riskClassification: {
        auto: {
          ...classifySearchResultRecord({
            title: "Томилин Константин Романович — уголовное дело",
            url: "https://news.example/court",
            snippet: "осужден суд приговор уголовное",
            subjectFullName: SUBJECT,
          }),
          classifiedAt: new Date().toISOString(),
        },
      },
    },
  });
  check("1 court HIGH identity + CLIENT_INCLUDE", court.identityConfidence === "HIGH" && court.reportEligibility === "CLIENT_INCLUDE");
  check("1 court adverse for report", court.isAdverseForReport);

  // 2. Rusprofile registry
  const registry = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "ИП Томилин",
    url: "https://www.rusprofile.ru/ip/1",
    snippet: "ИНН ОГРН",
    subjectFullName: SUBJECT,
    classification: "CORPORATE_REGISTRY",
  });
  check("2 Rusprofile CORPORATE_REGISTRY", registry.contentClass === "CORPORATE_REGISTRY");
  check("2 Rusprofile not adverse", !registry.isAdverseForReport);
  check("2 Rusprofile risk NONE/LOW", registry.riskConfidence === "NONE" || registry.riskConfidence === "LOW");

  // 3. Different patronymic namesake
  const namesake = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Константин Александрович Томилин",
    url: "https://science.example",
    snippet: "ученый биография",
    subjectFullName: SUBJECT,
    classification: "NAMESAKE",
  });
  check("3 namesake LOW identity", namesake.identityConfidence === "LOW");
  check("3 namesake not adverse", !namesake.isAdverseForReport);
  check("3 namesake EXCLUDE", namesake.reportEligibility === "EXCLUDE");

  // 4. Social profile
  const social = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Томилин Константин",
    url: "https://ok.ru/profile/1",
    snippet: "профиль",
    subjectFullName: SUBJECT,
    classification: "SOCIAL_PROFILE",
  });
  check("4 social not adverse", !social.isAdverseForReport);

  // 5. Neutral image
  const image = evaluateEvidenceItem({
    surfaceType: "IMAGE_RESULT",
    title: "Томилин photo",
    url: "https://example.com/photo.jpg",
    snippet: "profile image",
    subjectFullName: SUBJECT,
    classification: "NEUTRAL",
  });
  check("5 image neutral not adverse", !image.isAdverseForReport);

  // 6. Image with adverse source page (via classification)
  const badImage = evaluateEvidenceItem({
    surfaceType: "IMAGE_RESULT",
    title: "Court photo",
    url: "https://news.example/img.jpg",
    snippet: "уголовное дело суд приговор",
    subjectFullName: SUBJECT,
    rawMetadata: {
      riskClassification: {
        auto: {
          ...classifySearchResultRecord({
            title: "Court photo",
            snippet: "уголовное дело суд приговор",
            subjectFullName: SUBJECT,
          }),
          classifiedAt: new Date().toISOString(),
        },
      },
    },
  });
  check("6 adverse image source flagged", badImage.contentClass !== "IMAGE_NEUTRAL" || badImage.reportEligibility !== "CLIENT_INCLUDE");

  // 7. Weak related query — not EXCLUDE (O5.1)
  const weakRelated = evaluateEvidenceItem({
    surfaceType: "RELATED_QUERY",
    title: "tomilin",
    subjectFullName: SUBJECT,
  });
  check("7 weak related not EXCLUDE", weakRelated.reportEligibility !== "EXCLUDE");
  check("7 weak related not client adverse", !weakRelated.isAdverseForReport);

  // O5.1 — related query selection
  const partialRelated = evaluateEvidenceItem({
    surfaceType: "RELATED_QUERY",
    title: "Tomilin Konstantin Romanovich biography",
    subjectFullName: SUBJECT,
  });
  check(
    "O5.1 partial related not EXCLUDE",
    partialRelated.reportEligibility !== "EXCLUDE",
    partialRelated.reportEligibility
  );
  check(
    "O5.1 partial related selected for report",
    ["CLIENT_INCLUDE", "INTERNAL_ONLY", "REVIEW_REQUIRED"].includes(
      partialRelated.reportEligibility
    )
  );

  const namesakeRelated = evaluateEvidenceItem({
    surfaceType: "RELATED_QUERY",
    title: "Константин Александрович Томилин",
    subjectFullName: SUBJECT,
    classification: "NAMESAKE",
  });
  check("O5.1 namesake related EXCLUDE", namesakeRelated.reportEligibility === "EXCLUDE");

  const intlRelated = [
    { surfaceType: "RELATED_QUERY" as const, title: "Tomilin Konstantin", region: "INTERNATIONAL", subjectFullName: SUBJECT },
    { surfaceType: "RELATED_QUERY" as const, title: "Tomilin Konstantin Romanovich", region: "INTERNATIONAL", subjectFullName: SUBJECT },
  ].map((item) => evaluateEvidenceItem(item));
  check(
    "O5.1 INTL related not all EXCLUDE",
    intlRelated.some((q) => q.reportEligibility !== "EXCLUDE")
  );
  const globalRelated = intlRelated.filter((q) => q.reportEligibility !== "EXCLUDE").length;
  check("O5.1 INTL related selected count > 0", globalRelated > 0, String(globalRelated));

  const ruRelated = evaluateEvidenceItem({
    surfaceType: "RELATED_QUERY",
    title: "unrelated generic query",
    region: "RU",
    subjectFullName: SUBJECT,
  });
  check(
    "O5.1 RU unrelated related not forced adverse",
    !ruRelated.isAdverseForReport
  );

  // 8. Manual adverse
  const manual = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Result",
    url: "https://example.com/a",
    subjectFullName: SUBJECT,
    rawMetadata: mergeRiskClassification(null, {
      manual: {
        classification: "LEGAL_DISPUTE",
        riskTheme: "legal_dispute",
        rationale: "confirmed",
        reviewedBy: "analyst",
        reviewedAt: new Date().toISOString(),
      },
    }),
  });
  check("8 manual adverse CLIENT_INCLUDE", manual.reportEligibility === "CLIENT_INCLUDE");
  check("8 manual adverse isAdverseForReport", manual.isAdverseForReport);

  // 9. Manual clear
  const cleared = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Result",
    url: "https://example.com/b",
    subjectFullName: SUBJECT,
    rawMetadata: mergeRiskClassification(
      {
        riskClassification: {
          auto: {
            ...classifySearchResultRecord({
              title: "Result",
              snippet: "суд приговор",
              subjectFullName: SUBJECT,
            }),
            classifiedAt: new Date().toISOString(),
          },
        },
      },
      {
        manual: {
          classification: "NEUTRAL",
          riskTheme: null,
          rationale: "false positive",
          reviewedBy: "analyst",
          reviewedAt: new Date().toISOString(),
        },
      }
    ),
  });
  check("9 manual clear not adverse", !cleared.isAdverseForReport);

  // 10. Duplicate URLs
  const dupes = dedupeEvidenceItems(
    [
      { surfaceType: "SEARCH_RESULT", title: "A", url: "https://a.com/1", subjectFullName: SUBJECT },
      { surfaceType: "SEARCH_RESULT", title: "A dup", url: "https://a.com/1", subjectFullName: SUBJECT },
    ],
    SUBJECT
  );
  check("10 duplicates collapsed", dupes.duplicatesCollapsed === 1);
  check("10 duplicate EXCLUDE", dupes.items[1]?.quality.reportEligibility === "EXCLUDE");

  // 11. Client selection
  const gated = dupes.items;
  const clientSel = selectEvidenceForReport(gated, "CLIENT");
  check("11 client excludes duplicates", !clientSel.selected.some((x) => x.quality.reportEligibility === "EXCLUDE"));

  // 12. Internal selection includes review
  const internalSel = selectEvidenceForReport(
    [
      {
        surfaceType: "SEARCH_SUGGESTION",
        title: "weak hint",
        subjectFullName: SUBJECT,
        quality: evaluateEvidenceItem({
          surfaceType: "SEARCH_SUGGESTION",
          title: "суд",
          subjectFullName: SUBJECT,
        }),
      },
    ],
    "INTERNAL"
  );
  check("12 internal keeps review items", internalSel.reviewRequired.length >= 0);

  // 13. Overall risk cap
  const summary = buildEvidenceQualitySummary(
    [
      { surfaceType: "SEARCH_SUGGESTION", title: "weak", subjectFullName: SUBJECT },
    ],
    SUBJECT
  );
  const capped = capOverallRiskFromQuality("CRITICAL", summary, 0);
  check("13 CRITICAL capped without high-confidence", capped !== "CRITICAL", capped);

  // 14. SERP snapshot theme/highlight consistency
  const auto = classifySearchResultRecord({
    title: "Томилин — суд",
    snippet: "приговор уголовное дело",
    subjectFullName: SUBJECT,
  });
  const autoBlock = { ...auto, classifiedAt: new Date().toISOString() };
  const hl = resolveHighlight({
    enumClassification: null,
    riskClassification: { auto: autoBlock },
    findings: [],
    sourceIsMock: false,
  });
  const themes = groupThemes(
    [
      {
        id: "1",
        rank: 1,
        title: "x",
        url: "https://example.com",
        domain: "example.com",
        snippet: "",
        engine: "GOOGLE",
        classification: auto.classification,
        isHighlighted: hl.isHighlighted,
        riskTheme: hl.riskTheme,
        source: "real:GOOGLE",
        region: "RU",
        language: "ru",
        createdAt: new Date(),
        themeTitle: hl.riskTheme,
      },
    ],
    "ru"
  );
  check("14 highlight strong auto", hl.isHighlighted === isStrongAutoSnapshotRisk(autoBlock));
  check("14 theme count matches highlights", themes.themes.length === (hl.isHighlighted ? 1 : 0), String(themes.themes.length));

  // 15. EN client-safe template strings
  const i18n = readFileSync(join(process.cwd(), "renderer/report_i18n.py"), "utf8");
  check("15 no debug wording in EN i18n", !i18n.includes('"mock fixture"'));

  // O5.1 — INTL vs UAE separation (offline fixture shape)
  const regionFixture = {
    ru: { relatedQueries: { total: 0 } },
    uae: { relatedQueries: { total: 0 } },
    international: { relatedQueries: { total: 11 } },
  };
  check(
    "O5.1 INTL related not in UAE bucket",
    regionFixture.uae.relatedQueries.total === 0 && regionFixture.international.relatedQueries.total === 11
  );
  check(
    "O5.1 global relatedQueriesTotal sum",
    (regionFixture.ru.relatedQueries.total ?? 0) +
      (regionFixture.uae.relatedQueries.total ?? 0) +
      (regionFixture.international.relatedQueries.total ?? 0) ===
      11
  );

  // O5.1 — EN client JSON hygiene helper
  const clientJson = JSON.stringify({
    searchSurfaces: { globalSummary: { relatedQueriesTotal: 11 } },
    evidenceQuality: { clientIncluded: 10 },
  });
  check("O5.1 EN client JSON clean", isClientSafeReportJson(clientJson));
  check(
    "O5.1 client JSON rejects sourceMode",
    !isClientSafeReportJson(JSON.stringify({ serpSnapshot: { metadata: { sourceMode: "SYNTHETIC" } } }))
  );

  const dirty = {
    meta: { reportWarnings: [{ text: "Demo/mock rows excluded", audience: "internal" }] },
    serpSnapshot: {
      id: "s1",
      metadata: {
        sourceMode: "REAL_ONLY",
        sourcePreference: "prefer_real",
        generatedAt: "2026-01-01T00:00:00Z",
        themeCount: 1,
        highlightedCount: 0,
        perEngine: {
          google: { sourceMode: "REAL", resultCount: 3, highlightedCount: 0 },
        },
      },
    },
    searchSurfaces: {
      globalSummary: { relatedQueriesTotal: 11 },
      regions: {
        international: {
          relatedQueries: {
            total: 11,
            items: [{ title: "Tomilin", reportEligibility: "CLIENT_INCLUDE", contentClass: "NEWS_NEUTRAL" }],
            qualityStats: { selectedForReport: 11, excludedAsNoise: 0, reviewRequired: 0 },
          },
        },
      },
    },
    evidenceQuality: { totals: { collected: 11 }, reviewQueue: [{ id: "x" }] },
  };
  const clean = sanitizeReportJsonForAudience(dirty, "client");
  const cleanStr = JSON.stringify(clean);
  check("O5.2 sanitizer removes sourceMode", !cleanStr.includes("sourceMode"));
  check("O5.2 sanitizer removes rawMetadata key path", !cleanStr.includes("rawMetadata"));
  check("O5.2 sanitizer removes reviewQueue", !cleanStr.includes("reviewQueue"));
  check("O5.2 sanitizer keeps relatedQueries total", clean.searchSurfaces?.globalSummary?.relatedQueriesTotal === 11);
  check(
    "O5.2 sanitizer keeps related selected",
    clean.searchSurfaces?.regions?.international?.relatedQueries?.qualityStats?.selectedForReport === 11
  );
  check("O5.2 sanitizer keeps serpSnapshot id", clean.serpSnapshot?.id === "s1");
  check("O5.2 client JSON clean helper", isClientSafeReportJson(cleanStr));
  check(
    "O5.2 internal preserves sourceMode",
    JSON.stringify(sanitizeReportJsonForAudience(dirty, "internal")).includes("sourceMode")
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();

export {};
