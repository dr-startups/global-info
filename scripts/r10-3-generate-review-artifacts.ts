import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "storage/digital-profile/qa-r10-orion-golden-parallel");
const deck = JSON.parse(readFileSync(join(root, "final-deck-manifest.json"), "utf8"));
const spec = JSON.parse(readFileSync(join(root, "orion-report-spec.json"), "utf8"));
const inv = JSON.parse(readFileSync(join(root, "full-evidence-inventory.json"), "utf8"));
const rel = JSON.parse(readFileSync(join(root, "relevance-filter-inspection.json"), "utf8"));

type Issue = { id: string; severity: string; detail: string };

function classifyPage(p: (typeof deck.finalSlides)[0]) {
  const pg = p.pageNumber;
  const sec = p.sectionKey;
  const title = p.title || "";
  const narr = `${p.narrative ?? ""} ${(p.bullets ?? []).join(" ")}`;
  const issues: Issue[] = [];

  if (pg === 4) {
    issues.push({
      id: "text-clipping",
      severity: "BLOCKER",
      detail: "Executive summary bullet truncated mid-word (субъе…)",
    });
  }
  if ([16, 17].includes(pg)) {
    issues.push({
      id: "mock-demo-serp",
      severity: "BLOCKER",
      detail: "SERP slide shows [DEMO] labels, mock domains, internal E2E subject ID in UI",
    });
  }
  if (pg >= 40 && pg <= 46) {
    issues.push({
      id: "lexis-subject-mismatch",
      severity: "BLOCKER",
      detail: "Lexis visual appendix shows Oleg Deripaska sanctions profile, not case subject identity",
    });
  }
  if (pg === 45) {
    issues.push({
      id: "raw-url-dump",
      severity: "MAJOR",
      detail: "Lexis page is dense raw hyperlink list without client context",
    });
  }
  if (pg === 5) {
    issues.push({
      id: "weak-risk-matrix",
      severity: "MAJOR",
      detail: "Risk matrix is generic repeated bullets, not visual matrix with distinct themes",
    });
  }
  if (narr.includes("Комплаенс-проверка")) {
    issues.push({
      id: "awkward-enum-humanization",
      severity: "MINOR_ISSUE",
      detail: "Awkward hyphenated compliance label from enum humanizer",
    });
  }
  if (narr.includes("R7.5 Lexis UI E2E") || title.includes("R7.5")) {
    issues.push({
      id: "test-subject-on-cover",
      severity: "MAJOR",
      detail: "Internal QA/E2E subject string exposed in client report",
    });
  }
  if (narr.includes("Дерипаск")) {
    issues.push({
      id: "wrong-person-named",
      severity: "BLOCKER",
      detail: "Narrative names Deripaska while subject is E2E test string",
    });
  }
  if (narr.includes("Данные для раздела отсутствуют")) {
    issues.push({
      id: "data-poor-placeholder",
      severity: "MINOR_ISSUE",
      detail: "Placeholder page with no substantive content",
    });
  }
  if (
    ["product_overview", "solution_digital_profile", "solution_compliance_databases", "solution_wikipedia", "about", "offer"].includes(
      sec
    )
  ) {
    issues.push({
      id: "marketing-filler",
      severity: "MINOR_ISSUE",
      detail: "Product/marketing slide not core ORION audit deliverable",
    });
  }

  const dupGroups: Record<string, number[]> = {
    "3-4": [3, 4],
    "7-10": [7, 8, 9, 10],
    "11-15": [11, 12, 13, 14, 15],
    "22-24": [22, 23, 24],
    "25-27": [25, 26, 27],
    "32-35": [32, 33, 34, 35],
    "36-39": [36, 37, 38, 39],
    "47-50": [47, 48, 49, 50],
  };
  for (const [label, pages] of Object.entries(dupGroups)) {
    if (pages.includes(pg) && pages.indexOf(pg) > 0) {
      issues.push({
        id: "duplicate-narrative",
        severity: "MAJOR",
        detail: `Same narrative repeated across pages ${label} with different titles only`,
      });
    }
  }

  if (issues.some((i) => i.severity === "BLOCKER")) {
    return { page: pg, verdict: "BLOCKER", sectionKey: sec, title, issues };
  }
  if (issues.some((i) => i.severity === "MAJOR")) {
    return { page: pg, verdict: "MAJOR_ISSUE", sectionKey: sec, title, issues };
  }
  if (issues.length) {
    return { page: pg, verdict: "MINOR_ISSUE", sectionKey: sec, title, issues };
  }
  if (pg === 1) {
    return {
      page: pg,
      verdict: "MINOR_ISSUE",
      sectionKey: sec,
      title,
      issues: [{ id: "test-subject-on-cover", severity: "MINOR_ISSUE", detail: "Cover shows internal E2E subject name" }],
    };
  }
  if (pg === 2) {
    return {
      page: pg,
      verdict: "MINOR_ISSUE",
      sectionKey: sec,
      title,
      issues: [{ id: "sparse-toc", severity: "MINOR_ISSUE", detail: "TOC is high-level only; large empty area" }],
    };
  }
  return { page: pg, verdict: "PASS", sectionKey: sec, title, issues: [] };
}

const pageReviews = deck.finalSlides.map(classifyPage);
const counts: Record<string, number> = {};
for (const p of pageReviews) {
  counts[p.verdict] = (counts[p.verdict] ?? 0) + 1;
}

const pageVisual = {
  version: "r10-3-page-visual-review-v1",
  reviewedAt: new Date().toISOString(),
  caseId: inv.caseId,
  pageCount: deck.slideCount,
  summary: counts,
  pages: pageReviews,
  topVisualIssues: [
    { priority: 1, issue: "Text clipping on executive summary page 4", pages: [4] },
    {
      priority: 2,
      issue: "Massive duplicate filler pages from expandToMinPages (same narrative, different titles)",
      pages: [7, 8, 9, 10, 11, 12, 13, 14, 15, 32, 33, 34, 35, 36, 37, 38, 39, 47, 48, 49, 50],
    },
    {
      priority: 3,
      issue: "Excessive empty whitespace on narrative-only slides",
      pages: [3, 4, 5, 7, 8, 9, 10, 15, 20, 22, 30, 38, 57, 64],
    },
    { priority: 4, issue: "SERP slides expose [DEMO] mock results and .example domains", pages: [16, 17] },
    {
      priority: 5,
      issue: "Lexis appendix pages include low-res screenshots and raw URL dumps",
      pages: [40, 41, 42, 43, 44, 45, 46],
    },
    { priority: 6, issue: "Data-poor UAE/media placeholder pages", pages: [18, 19, 28, 29, 30, 31] },
    { priority: 7, issue: "Risk matrix template not rendered as matrix grid", pages: [5] },
    { priority: 8, issue: "Product/solution marketing slides dilute audit focus", pages: [55, 56, 57, 58, 59, 60, 61, 62] },
  ],
};
writeFileSync(join(root, "r10-3-page-visual-review.json"), `${JSON.stringify(pageVisual, null, 2)}\n`);

const parts: string[] = [];
parts.push(spec.subject.displayName, spec.subject.reportTitle);
parts.push(spec.executiveSummary.executiveSummary);
for (const k of ["mainRisks", "finalRecommendations", "nextSteps", "possibleConsequences"] as const) {
  parts.push(...(spec.executiveSummary[k] ?? []));
}
for (const b of [
  spec.ruAuditSummary,
  spec.ruSearchResults,
  spec.uaeAuditSummary,
  spec.complianceDatabases,
  spec.lexisNexis,
  spec.dowJones,
  spec.worldCheck,
]) {
  if (!b) continue;
  parts.push(b.sectionTitle, b.narrative);
  for (const c of b.evidenceCards ?? []) parts.push(c.title, c.summary);
}
const text = parts.join("\n");

const contentIssues: Array<Record<string, string>> = [];
const patterns: Array<[RegExp, string]> = [
  [/review_required|requires_review|open_source|no_data/gi, "raw-enum"],
  [/\b[a-z]+_[a-z0-9_]{3,}\b/g, "snake_case"],
  [/R7\.5 Lexis UI E2E/g, "test-subject-id"],
  [/\[DEMO\]/g, "demo-label"],
  [/\.example\b/g, "mock-domain"],
  [/Комплаенс-проверка-/g, "awkward-compliance-label"],
  [/Дерипаск/g, "wrong-person-reference"],
];
for (const [re, id] of patterns) {
  const m = text.match(re);
  if (m) contentIssues.push({ id, sample: m[0] });
}

const specEnumHits = JSON.stringify(spec.executiveSummary.riskMatrix).match(/review_required/g)?.length ?? 0;
if (specEnumHits) {
  contentIssues.push({
    id: "internal-enums-in-spec",
    detail: `${specEnumHits} review_required values remain in reportSpec riskMatrix (internal, not rendered)`,
  });
}

const clientContent = {
  version: "r10-3-client-content-review-v1",
  reviewedAt: new Date().toISOString(),
  automatedPolicyPass: true,
  manualReviewPass: false,
  verdict: "FAIL",
  issues: contentIssues,
  findings: [
    {
      severity: "BLOCKER",
      id: "test-subject-name",
      detail: "Cover and narratives use internal E2E subject string instead of real client entity name",
    },
    {
      severity: "BLOCKER",
      id: "deripaska-name-leak",
      detail: "Dow Jones narrative names Deripaska while audit subject is test E2E label — identity confusion",
    },
    {
      severity: "MAJOR",
      id: "repetitive-manual-review-filler",
      detail: "Multiple sections repeat same cautious boilerplate without distinct findings per slide title",
    },
    {
      severity: "MAJOR",
      id: "awkward-humanized-labels",
      detail: "Комплаенс-проверка-* phrasing reads like machine-translated enum labels",
    },
    {
      severity: "MAJOR",
      id: "generic-risk-matrix-themes",
      detail: 'All matrix rows use identical theme "Риск требует оценки"',
    },
    {
      severity: "MINOR",
      id: "english-in-lexis-appendix",
      detail: "Lexis visual pages are English source screenshots without Russian wrapper summary on-page",
    },
    {
      severity: "MINOR",
      id: "executive-capitalization",
      detail: 'Mid-sentence capitalized "Политически значимое лицо" in executive summary',
    },
  ],
  strengths: [
    "No raw review_required in rendered deck text after R10.2 sanitization",
    "Russian narrative tone is generally professional and cautious",
    "Recommendations emphasize manual verification rather than unsupported conclusions",
  ],
};
writeFileSync(join(root, "r10-3-client-content-review.json"), `${JSON.stringify(clientContent, null, 2)}\n`);

const orionSimilarity = {
  version: "r10-3-orion-similarity-review-v1",
  reviewedAt: new Date().toISOString(),
  sections: [
    { key: "cover", label: "Dark premium cover", classification: "ACCEPTABLE", notes: "Dark cover present but shows internal test subject name" },
    { key: "global_toc", label: "TOC", classification: "WEAK", notes: "Only 6 high-level bullets; sparse layout" },
    { key: "executive_summary", label: "Executive summary", classification: "ACCEPTABLE", notes: "Present and substantive; page 4 clipping; duplicated page 3/4" },
    { key: "compliance_risk_matrix", label: "Risk matrix", classification: "WEAK", notes: "Bulleted list not visual matrix; generic repeated themes" },
    { key: "ru_digital_profile", label: "RU region divider", classification: "ORION_LIKE", notes: "Clean section divider" },
    { key: "ru_audit_summary", label: "RU audit summary", classification: "WEAK", notes: "4 pages repeat identical narrative under different titles" },
    { key: "ru_search_results", label: "RU search results", classification: "WEAK", notes: "5 filler pages; lacks evidence tables with top results" },
    { key: "ru_serp_screenshots", label: "RU SERP screenshots", classification: "WEAK", notes: "Synthetic SERP present but shows DEMO/mock data" },
    { key: "ru_images", label: "RU images", classification: "MISSING", notes: "Placeholder only" },
    { key: "ru_videos", label: "RU videos", classification: "MISSING", notes: "Placeholder only" },
    { key: "ru_wikipedia", label: "RU Wikipedia", classification: "ACCEPTABLE", notes: "Brief narrative; sparse page" },
    { key: "uae_digital_profile", label: "UAE divider", classification: "ORION_LIKE", notes: "Present" },
    { key: "uae_audit_summary", label: "UAE audit", classification: "SHOULD_REMOVE_OR_COLLAPSE", notes: "RU-only case; 3 pages of no-data disclaimers" },
    { key: "uae_search_results", label: "UAE search", classification: "SHOULD_REMOVE_OR_COLLAPSE", notes: "No UAE results; filler pages 25-27" },
    { key: "uae_serp_images_videos", label: "UAE media sections", classification: "SHOULD_REMOVE_OR_COLLAPSE", notes: "Pages 28-31 placeholders" },
    { key: "compliance_databases", label: "Compliance DB section", classification: "ACCEPTABLE", notes: "Analytical narrative present; duplicated filler pages" },
    { key: "lexisnexis", label: "Lexis analytical + visual", classification: "WEAK", notes: "Analytical pages thin; visual appendix present but wrong-subject Lexis doc (Deripaska)" },
    { key: "dow_jones", label: "Dow Jones / World-Check", classification: "WEAK", notes: "Mentions Deripaska; 4 duplicate narrative pages" },
    { key: "offer_product_solution", label: "Offer/product/solution/about", classification: "SHOULD_REMOVE_OR_COLLAPSE", notes: "Marketing slides 52-62 not client audit deliverable for this case" },
    { key: "appendix", label: "Evidence appendix", classification: "WEAK", notes: "Two pages with generic disclaimer; no excluded-noise table visible" },
  ],
  overallOrionSimilarity: "PARTIAL",
  verdict: "NOT_ORION_CLIENT_GRADE",
};
writeFileSync(join(root, "r10-3-orion-similarity-review.json"), `${JSON.stringify(orionSimilarity, null, 2)}\n`);

const assetsRaw = readFileSync(join(root, "report-assets.json"), "utf8");
const assetCounts = {
  synthetic_serp: (assetsRaw.match(/"kind": "synthetic_serp"/g) ?? []).length,
  lexis_visual_page: (assetsRaw.match(/"kind": "lexis_visual_page"/g) ?? []).length,
  image_grid: (assetsRaw.match(/"kind": "image_grid"/g) ?? []).length,
  video_cards: (assetsRaw.match(/"kind": "video_cards"/g) ?? []).length,
  knowledge_panel: (assetsRaw.match(/"kind": "knowledge_panel"/g) ?? []).length,
};

const evidenceQuality = {
  version: "r10-3-evidence-quality-review-v1",
  reviewedAt: new Date().toISOString(),
  relevanceCounts: {
    strongRelevant: rel.strongRelevant,
    relevant: rel.relevant,
    potentiallyRelevant: rel.potentiallyRelevant,
    excludedNoise: rel.excludedNoise,
    byReason: rel.byReason,
  },
  inventoryCounts: inv.counts,
  mediaAvailability: inv.mediaAvailability,
  assetCounts,
  findings: [
    {
      severity: "BLOCKER",
      id: "lexis-doc-subject-mismatch",
      detail: "Lexis visual appendix renders Deripaska sanctions report; case subject is E2E test label — evidence not grounded to audited entity",
    },
    {
      severity: "MAJOR",
      id: "serp-shows-demo-results",
      detail: "SERP assets include [DEMO] mock results and .example domains visible to client",
    },
    {
      severity: "MAJOR",
      id: "duplicate-slide-padding",
      detail: "expandToMinPages inflates page count with repeated narratives instead of distinct evidence cards",
    },
    {
      severity: "MAJOR",
      id: "missing-search-evidence-tables",
      detail: "127 search results loaded but deck lacks structured top-results tables/screenshots beyond 2 SERP slides",
    },
    {
      severity: "MINOR",
      id: "uae-sections-empty",
      detail: "18 manual-note surfaces; no image/video/knowledge mapped — UAE sections add no evidence",
    },
    { severity: "PASS", id: "noise-excluded", detail: "34 marketplace/product/login results excluded from client routing" },
    { severity: "PASS", id: "search-accounting", detail: "127/127 searchResults accounted in routing inspection" },
  ],
  appendixUsefulness: "LOW — appendix pages 63-64 are generic disclaimers without excluded-noise inventory table",
  verdict: "NOT_CLIENT_READY_EVIDENCE",
};
writeFileSync(join(root, "r10-3-evidence-quality-review.json"), `${JSON.stringify(evidenceQuality, null, 2)}\n`);

const finalReview = {
  version: "r10-3-final-review-v1",
  reviewedAt: new Date().toISOString(),
  branch: "feature/report-quality-r10-2-orion-golden-client-quality",
  caseId: inv.caseId,
  technicalQaPass: true,
  clientSignOffPass: false,
  verdict: "NOT_CLIENT_READY_CONTENT",
  subVerdicts: {
    visual: "NOT_CLIENT_READY_VISUAL",
    content: "NOT_CLIENT_READY_CONTENT",
    structure: "NOT_CLIENT_READY_STRUCTURE",
    evidence: "NOT_CLIENT_READY_EVIDENCE",
  },
  pageStats: counts,
  top10Issues: [
    { rank: 1, issue: "Lexis visual appendix shows wrong person (Deripaska) vs audited subject", pages: [40, 41, 42, 43, 44, 45, 46], fixArea: "evidence-enrichment" },
    { rank: 2, issue: "Internal E2E/test subject name exposed on cover and client narratives", pages: [1, 3, 16, 17, 25, 33, 35], fixArea: "client-content" },
    { rank: 3, issue: "SERP slides render [DEMO] mock results and .example domains", pages: [16, 17], fixArea: "visual-layout" },
    { rank: 4, issue: "Executive summary text clipped on page 4", pages: [4], fixArea: "visual-layout" },
    {
      rank: 5,
      issue: "Duplicate filler pages: same narrative under different slide titles",
      pages: [7, 8, 9, 10, 11, 12, 13, 14, 15, 32, 33, 34, 35, 36, 37, 38, 39, 47, 48, 49, 50],
      fixArea: "structure",
    },
    { rank: 6, issue: "Risk matrix is generic bullet list, not ORION-style matrix", pages: [5], fixArea: "visual-layout" },
    { rank: 7, issue: "Dow Jones narrative names Deripaska — identity confusion", pages: [50], fixArea: "client-content" },
    { rank: 8, issue: "UAE/data-poor sections consume pages without evidence", pages: [22, 23, 24, 25, 26, 27, 28, 29, 30, 31], fixArea: "structure" },
    { rank: 9, issue: "Product/solution marketing slides not appropriate for client audit PDF", pages: [52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62], fixArea: "structure" },
    { rank: 10, issue: "Appendix lacks useful excluded-noise/source inventory", pages: [63, 64], fixArea: "evidence-enrichment" },
  ],
  quickWins: [
    "Collapse expandToMinPages filler when section has single narrative",
    "Hide/collapse UAE and empty media sections for RU-only cases",
    "Remove product/solution/about slides from client export mode",
    "Fix page-4 text clipping in executive template",
    "Strip [DEMO] and .example from SERP client view or mark as synthetic clearly in QA-only runs",
  ],
  recommendedFixBranch: "feature/report-quality-r10-4-orion-golden-client-signoff",
  recommendedNextStage:
    "Fix visual layout and deck structure first (duplicate pages, clipping, collapse data-poor sections); then evidence enrichment (Lexis subject binding, real SERP for production cases); search/media collection is lower priority until case has real surface data.",
  priorityOrder: ["visual-layout", "structure-simplification", "evidence-enrichment", "search-media-collection"],
};
writeFileSync(join(root, "r10-3-final-review.json"), `${JSON.stringify(finalReview, null, 2)}\n`);

console.log(JSON.stringify({ counts, assetCounts, verdict: finalReview.verdict }, null, 2));
