/**
 * Smoke test — Stage O5.4 Report Renderer Selected Evidence Enforcement.
 *
 * Run: npm run smoke:report-selected-evidence-rendering-o54
 */

import { evaluateEvidenceItem } from "../src/modules/digital-profile/evidence-quality/gate";
import {
  buildSelectedEvidenceReportVm,
  filterReportRiskFindings,
  patchAuditSummaryWithSelectedEvidence,
} from "../src/modules/digital-profile/report/selected-evidence-report-vm";
import type { SearchSurfacesReportBlock } from "../src/modules/digital-profile/report/search-surfaces-report-builder";
import { regionBlockToAuditRegion } from "../src/modules/digital-profile/report/search-surfaces-report-builder";

const SUBJECT = "Томилин Константин Романович";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function item(title: string, overrides: Record<string, unknown> = {}) {
  return {
    title,
    snippet: null,
    url: "https://example.com/x",
    domain: "example.com",
    thumbnailUrl: null,
    classification: null,
    riskTheme: null,
    query: null,
    rank: 1,
    identityDecision: "EXACT_SUBJECT",
    reportEligibility: "CLIENT_INCLUDE",
    sourcePageUrl: "https://example.com/x",
    ...overrides,
  };
}

function emptyBucket() {
  return {
    total: 0,
    adverse: 0,
    collectionStatus: "COLLECTED" as const,
    statusMessage: "ok",
    items: [],
  };
}

function mockSearchSurfaces(): SearchSurfacesReportBlock {
  const ruImages = [
    item("Томилин Константин Романович фото", {
      thumbnailStorageKey: "cases/demo/thumb.jpg",
      identityDecision: "EXACT_SUBJECT",
    }),
  ];
  const ruVideos = [
    item("Томилин Константин Романович интервью", {
      url: "https://youtube.com/watch?v=abc",
      sourcePageUrl: "https://youtube.com/watch?v=abc",
      identityDecision: "EXACT_SUBJECT",
    }),
  ];
  const ruOrganic = [
    item("ИП Томилин Константин Романович", { classification: "CORPORATE_REGISTRY" }),
  ];

  const intlOrganic = [
    item("Anatoli Romanovich biography", {
      identityDecision: "INSUFFICIENT_MATCH",
      reportEligibility: "EXCLUDE",
    }),
  ];

  const ruBlock = {
    region: "RU" as const,
    label: "Russia",
    language: "ru",
    collectionStatus: "COLLECTED" as const,
    statusMessage: "ok",
    organic: { ...emptyBucket(), total: 5, items: ruOrganic },
    suggestions: {
      ...emptyBucket(),
      total: 3,
      items: [item("томилин константин", { autocompleteClass: "EXACT_SUBJECT_QUERY" })],
      suggestionGroups: [{ key: "exact" as const, label: "Exact", items: ["томилин константин"] }],
      exposureDisclaimer: "disclaimer",
    },
    relatedQueries: emptyBucket(),
    images: {
      ...emptyBucket(),
      total: 42,
      items: ruImages,
      qualityStats: {
        totalCollected: 42,
        selectedForReport: 1,
        excludedAsNoise: 41,
        reviewRequired: 0,
        duplicatesCollapsed: 0,
        clientIncluded: 1,
        dataQualityStatus: "COLLECTED",
      },
      excludedItems: [
        item("Томилин Ф.Н.", { identityDecision: "INSUFFICIENT_MATCH", reportEligibility: "EXCLUDE" }),
        item("Томилин Игорь Евгеньевич отделение", {
          identityDecision: "ENTITY_MISMATCH",
          reportEligibility: "EXCLUDE",
        }),
      ],
    },
    videos: {
      ...emptyBucket(),
      total: 10,
      items: ruVideos,
      excludedItems: [
        item("Random TikTok", {
          url: "https://tiktok.com/x",
          identityDecision: "INSUFFICIENT_MATCH",
          reportEligibility: "EXCLUDE",
        }),
      ],
    },
    knowledgePanel: emptyBucket(),
    wikipedia: emptyBucket(),
    matrix: null,
    summary: {
      queryVariants: [],
      totalCheckedResults: 1,
      uniqueUrls: 1,
      uniqueAdverseUrls: 0,
      adversePercentage: 0,
      topAdverseThemes: [],
      topAdverseDomains: [],
    },
  };

  const intlBlock = {
    ...ruBlock,
    region: "INTERNATIONAL" as const,
    label: "International",
    language: "en",
    organic: { ...emptyBucket(), total: 3, items: [] },
    images: { ...emptyBucket(), total: 2, items: [] },
    videos: { ...emptyBucket(), total: 2, items: [] },
  };

  return {
    regions: { ru: ruBlock, uae: { ...intlBlock, region: "UAE" as const }, international: intlBlock },
    globalSummary: {
      regionsCollected: 2,
      regionsNotQueried: 0,
      totalUniqueUrls: 1,
      totalUniqueAdverseUrls: 0,
      relatedQueriesTotal: 0,
      relatedQueriesNegative: 0,
      suggestionsTotal: 3,
      imagesTotal: 42,
      videosTotal: 10,
      knowledgePanelTotal: 0,
      knowledgePanelStatus: "ABSENT",
    },
    dataQualityWarnings: [],
  } as unknown as SearchSurfacesReportBlock;
}

function main() {
  console.log("Smoke testing O5.4 Selected Evidence Report Rendering\n");

  const surfaces = mockSearchSurfaces();
  const vm = buildSelectedEvidenceReportVm({
    searchSurfaces: surfaces,
    reportAudience: "INTERNAL",
    riskSummary: {
      highestRiskLevel: "HIGH",
      totalFindings: 3,
      findingsByLevel: { HIGH: 1 },
      findingsByTheme: { pep_rca: 1 },
      topFindings: [
        {
          severity: "HIGH",
          theme: "pep_rca",
          title: "Potential PEP — DOW_JONES",
          evidenceCount: 0,
        },
        {
          severity: "MEDIUM",
          theme: "search_profile",
          title: "Open-source mention",
          evidenceCount: 1,
        },
      ],
    },
    complianceSummary: {
      providerStatuses: [],
      totalHits: 0,
      pendingHits: 0,
      confirmedHits: 0,
      falsePositives: 0,
      byRiskType: {},
      topHits: [],
      dataQualityWarnings: [],
      reviewRequiredWarning: "",
    },
  });

  // 1–2 Page 13 VM
  check("1 page13 only selectedSubjectMatched images", vm.images.selectedSubjectMatched.length === 1);
  const ruAudit = vm.regions.ru.auditRegion;
  const topImages = (ruAudit.topImages as unknown[]) ?? [];
  check("2 page13 audit topImages count", topImages.length === 1);

  // 3 Page 13 excludes noise titles
  const imgTitles = vm.images.selectedSubjectMatched.map((i) => i.title).join(" ");
  check("3 excludes Tomilin F.N.", !imgTitles.includes("Ф.Н."));
  check("3 excludes Igor Evgenievich", !imgTitles.includes("Игорь"));
  check("3 excludes medical/hockey noise", !imgTitles.includes("отделение"));

  // 4–5 Page 14 videos
  check("4 excludes unrelated social video", vm.videos.selectedSubjectMatched.length === 1);
  const weakLikelyVideo = buildSelectedEvidenceReportVm({
    searchSurfaces: {
      ...surfaces,
      regions: {
        ...surfaces.regions,
        ru: {
          ...surfaces.regions.ru,
          videos: {
            ...surfaces.regions.ru.videos,
            items: [
              item("LIME fashion collection reel", {
                url: "https://instagram.com/p/x",
                identityDecision: "LIKELY_SUBJECT",
                reportEligibility: "CLIENT_INCLUDE",
              }),
              item("Томилин Константин Романович интервью", {
                url: "https://youtube.com/watch?v=abc",
                sourcePageUrl: "https://youtube.com/watch?v=abc",
                identityDecision: "EXACT_SUBJECT",
              }),
            ],
          },
        },
      },
    },
    reportAudience: "INTERNAL",
  });
  check(
    "4b weak LIKELY social video excluded",
    !weakLikelyVideo.videos.selectedSubjectMatched.some((v) => v.title.includes("LIME"))
  );
  check(
    "5 selected video has clickable URL",
    Boolean(vm.videos.selectedSubjectMatched[0]?.url?.startsWith("http"))
  );

  // 6 Page 20 appendix excludes wrong patronymics
  const appendixTitles = vm.appendix.confirmedSubjectEvidence.map((e) => e.title).join(" ");
  for (const bad of [
    "Владимирович",
    "Михайлович",
    "Александрович",
    "Богдан Романович",
    "Георгиевич",
  ]) {
    check(`6 appendix excludes ${bad}`, !appendixTitles.includes(bad));
  }
  check(
    "6 excluded namesakes tracked internally",
    vm.appendix.excludedNamesakesInternalOnly.length >= 2
  );

  // 7–8 International Romanovich-only
  check("7 intl organic selected empty", vm.regions.international.organicSelected.length === 0);
  check("8 intl images/videos empty", vm.regions.international.images.length === 0);

  // 9–10 Risk / compliance pages
  check(
    "9 no DJ/WC/PEP without manual import",
    !vm.riskFindings.selectedSubjectMatchedOnly.some((f) =>
      String(f.title).toUpperCase().includes("DOW_JONES")
    )
  );
  check("10 compliance not run flag", vm.compliance.providersRun === false);

  // 11 Suggestions remain autocomplete exposure
  check("11 suggestions kept", vm.suggestions.autocompleteExposure.total === 3);
  check("11 autocomplete impact zero", vm.metrics.autocompleteEvidenceImpact === 0);

  // 12 SERP synthetic unaffected — gate still works for namesakes
  const namesake = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Томилин Константин Владимирович",
    subjectFullName: SUBJECT,
  });
  check("12 namesake excluded", namesake.reportEligibility === "EXCLUDE");

  // Thumbnail payload path on audit region
  const mapped = regionBlockToAuditRegion(surfaces.regions.ru, {
    imagesSelected: surfaces.regions.ru.images.items,
  });
  const mappedImages = (mapped?.topImages as Array<Record<string, unknown>>) ?? [];
  check(
    "13 render payload has thumbnailStorageKey",
    Boolean(mappedImages[0]?.thumbnailStorageKey)
  );

  const patched = patchAuditSummaryWithSelectedEvidence(
    {
      overallRiskLevel: "CRITICAL",
      overallTone: "caution",
      generatedAt: new Date().toISOString(),
      subjectFullName: SUBJECT,
      executiveSummary: [],
      keyFindings: [],
      recommendedActions: [],
      searchSummary: {
        totalResults: 0,
        negativeResults: 0,
        negativeShare: 0,
        uniqueUrls: 0,
        topNegativeUrls: [],
        negativeDomains: [],
        topNegativeThemes: [],
      },
      surfacesSummary: {
        screenshots: 0,
        syntheticSnapshots: 1,
        suggestions: { total: 0, negative: 0, negativeShare: 0 },
        images: { total: 0, negative: 0, negativeShare: 0 },
        videos: { total: 0, negative: 0, negativeShare: 0 },
        knowledgeBlocks: { total: 0, mismatches: 0 },
      },
      wikipediaSummary: {
        exists: false,
        pageUrl: null,
        language: null,
        notabilityScore: 0,
        conclusion: "",
      },
      complianceDatabaseSummary: {
        providersChecked: [],
        activeMatches: 0,
        pepMatches: 0,
        rcaMatches: 0,
        sanctionsMatches: 0,
        adverseMediaMatches: 0,
        conclusion: "",
      },
      riskSummary: {
        highestRiskLevel: "HIGH",
        totalFindings: 1,
        findingsByLevel: {},
        findingsByTheme: {},
        topFindings: [
          {
            severity: "HIGH",
            theme: "sanctions",
            title: "Potential SANCTIONS — WORLD_CHECK",
            evidenceCount: 0,
            reviewStatus: "PENDING",
          },
        ],
      },
      dataQualitySummary: {
        evidenceCount: 0,
        reviewedFindings: 0,
        pendingFindings: 0,
        dismissedFindings: 0,
        missingSections: [],
        warnings: [],
      },
      regions: [],
    } as unknown as import("../src/modules/digital-profile/audit-summary/types").AuditSummary,
    vm
  );
  check(
    "14 patched audit drops compliance finding",
    (patched.riskSummary?.topFindings?.length ?? 0) === 0 ||
      !patched.riskSummary?.topFindings?.some((f) => f.theme === "sanctions")
  );

  const filtered = filterReportRiskFindings(
    [{ severity: "CRITICAL", theme: "pep_rca", title: "Potential PEP — DOW_JONES", evidenceCount: 0 }],
    { providerStatuses: [], totalHits: 0, pendingHits: 0, confirmedHits: 0, falsePositives: 0, byRiskType: {}, topHits: [], dataQualityWarnings: [], reviewRequiredWarning: "" }
  );
  check("15 filterReportRiskFindings empty without compliance", filtered.length === 0);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
