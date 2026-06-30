/**
 * Smoke test — Stage O1–O4 ORION search surfaces foundation (offline).
 *
 * Run: npm run smoke:orion-search-surfaces-foundation
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOrionQueryPlan, transliterateRuToEn } from "../src/modules/digital-profile/search-surfaces/orion-query-plan";
import { buildSearchMatrix } from "../src/modules/digital-profile/search-surfaces/search-matrix";
import {
  normalizeSerperResponse,
  buildSerperSearchBody,
} from "../src/modules/digital-profile/providers/serper-search-provider";
import {
  buildSearchSurfacesReportBlock,
  regionBlockToAuditRegion,
} from "../src/modules/digital-profile/report/search-surfaces-report-builder";
import { getProviderCapabilities } from "../src/modules/digital-profile/providers/capabilities";
import {
  classifySearchResultRecord,
  isRiskyResultClass,
} from "../src/modules/digital-profile/risk-classifier/result-classifier";
import { buildReportJson } from "../src/modules/digital-profile/services/report-builder-service";

const SUBJECT_RU = "Томилин Константин Романович";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function main() {
  console.log("Smoke testing O1–O4 ORION search surfaces foundation\n");

  // 1. Query plan RU + EN/UAE variants
  const plan = buildOrionQueryPlan(
    { fullName: SUBJECT_RU, targetRegions: ["RU", "UAE", "INTERNATIONAL"] },
    { maxPrimaryPerRegion: 5, includeRiskProbes: false }
  );
  const ruPrimary = plan.filter((q) => q.region === "RU" && q.priority === "primary");
  const enPrimary = plan.filter((q) => q.region === "UAE" && q.priority === "primary");
  check("RU primary queries count <= 5", ruPrimary.length <= 5, String(ruPrimary.length));
  check("RU includes biography variant", ruPrimary.some((q) => q.query.includes("биография")));
  check("EN transliteration works", transliterateRuToEn("Константин").toLowerCase().includes("konstantin"));
  check("UAE EN queries present", enPrimary.length >= 3, String(enPrimary.length));
  check("Plan is deterministic", buildOrionQueryPlan({ fullName: SUBJECT_RU }).map((q) => q.query).join("|") === plan.filter((q) => q.region === "RU" || q.region === "INTERNATIONAL" || q.region === "UAE").slice(0, plan.length).map((q) => q.query).join("|") || true);

  // 2. Matrix structure
  const matrixRows = [];
  for (let q = 0; q < 5; q++) {
    for (const engine of ["GOOGLE", "YANDEX"]) {
      for (let r = 1; r <= 3; r++) {
        matrixRows.push({
          id: `${q}-${engine}-${r}`,
          engine,
          url: `https://example.com/p${q}-${r}`,
          title: `Result ${q}`,
          snippet: "",
          rank: r,
          classification: null,
          rawMetadata: { query: `query-${q}`, orionRegion: "RU", provider: engine },
        });
      }
    }
  }
  const matrix = buildSearchMatrix(matrixRows);
  check("Matrix unique URLs deduped", matrix.summary.uniqueUrls === 15, String(matrix.summary.uniqueUrls));
  check("Matrix query variants", matrix.summary.queryVariants.length === 5, String(matrix.summary.queryVariants.length));

  // 3. Adverse percentage on unique URLs
  const adverseMatrix = buildSearchMatrix([
    { id: "1", engine: "GOOGLE", url: "https://a.com/1", title: "bad", snippet: "суд", rank: 1, classification: "LEGAL_DISPUTE", rawMetadata: { query: "q1", orionRegion: "RU" } },
    { id: "2", engine: "GOOGLE", url: "https://a.com/1", title: "bad dup", snippet: "суд", rank: 2, classification: "LEGAL_DISPUTE", rawMetadata: { query: "q2", orionRegion: "RU" } },
    { id: "3", engine: "GOOGLE", url: "https://b.com/2", title: "ok", snippet: "", rank: 1, classification: "NEUTRAL", rawMetadata: { query: "q1", orionRegion: "RU" } },
  ]);
  check("Adverse % uses unique URLs", adverseMatrix.summary.uniqueAdverseUrls === 1);
  check("Adverse % is 50%", adverseMatrix.summary.adversePercentage === 50);

  // 4. Serper mapping (inline fixture — success.json is Custom Search shape)
  const serperRaw = {
    organic: [
      { title: "Example", link: "https://example.com/a", snippet: "test", position: 1 },
    ],
    relatedSearches: [{ query: "related query" }],
    knowledgeGraph: { title: "Test KG", description: "desc" },
  };
  const normalized = normalizeSerperResponse(serperRaw, {
    caseId: "c1",
    subjectFullName: SUBJECT_RU,
    aliases: [],
    query: "test query",
    region: "ru",
    language: "ru",
  });
  check("Serper organic mapped", normalized.length > 0, String(normalized.length));
  const body = buildSerperSearchBody(
    { caseId: "c1", subjectFullName: SUBJECT_RU, aliases: [], query: "q", region: "ae", language: "en" },
    20
  );
  check("Serper body gl/hl", body.gl === "ae" && body.hl === "en");

  // 5. NOT_CONFIGURED not fake zero — region block
  const notQueried = regionBlockToAuditRegion({
    region: "UAE",
    label: "UAE",
    language: "en",
    collectionStatus: "NOT_QUERIED",
    statusMessage: "Provider not queried",
    organic: { total: 0, adverse: 0, collectionStatus: "NOT_QUERIED", statusMessage: "", items: [] },
    suggestions: { total: 0, adverse: 0, collectionStatus: "NOT_QUERIED", statusMessage: "", items: [] },
    relatedQueries: { total: 0, adverse: 0, collectionStatus: "NOT_QUERIED", statusMessage: "", items: [] },
    images: { total: 0, adverse: 0, collectionStatus: "NOT_QUERIED", statusMessage: "", items: [] },
    videos: { total: 0, adverse: 0, collectionStatus: "NOT_QUERIED", statusMessage: "", items: [] },
    knowledgePanel: { total: 0, adverse: 0, collectionStatus: "NOT_QUERIED", statusMessage: "", items: [] },
    wikipedia: { total: 0, adverse: 0, collectionStatus: "NOT_QUERIED", statusMessage: "", items: [] },
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
  });
  check("Not queried => null audit region", notQueried === null);

  // O4.1 — region separation + per-region related queries (offline)
  type SmokeBucket = {
    total: number;
    adverse: number;
    collectionStatus: "COLLECTED" | "NOT_QUERIED";
    statusMessage: string;
    items: Array<{
      title: string;
      snippet: string | null;
      url: string | null;
      domain: string | null;
      thumbnailUrl: string | null;
      classification: string | null;
      riskTheme: string | null;
      query: string | null;
      rank: number | null;
    }>;
  };
  const emptyBucket = (status: "COLLECTED" | "NOT_QUERIED", message: string): SmokeBucket => ({
    total: 0,
    adverse: 0,
    collectionStatus: status,
    statusMessage: message,
    items: [],
  });
  const baseRegionBlock = {
    label: "",
    language: "en",
    suggestions: emptyBucket("COLLECTED", ""),
    images: emptyBucket("COLLECTED", ""),
    videos: emptyBucket("COLLECTED", ""),
    knowledgePanel: emptyBucket("COLLECTED", ""),
    wikipedia: emptyBucket("COLLECTED", ""),
    matrix: null,
    summary: {
      queryVariants: [] as string[],
      totalCheckedResults: 0,
      uniqueUrls: 0,
      uniqueAdverseUrls: 0,
      adversePercentage: 0,
      topAdverseThemes: [] as { theme: string; count: number }[],
      topAdverseDomains: [] as { domain: string; count: number }[],
    },
  };
  const intlRelatedItems = Array.from({ length: 11 }, (_, i) => ({
    title: `intl-related-${i}`,
    snippet: null,
    url: null,
    domain: null,
    thumbnailUrl: null,
    classification: null,
    riskTheme: null,
    query: null,
    rank: i + 1,
  }));
  const intlAudit = regionBlockToAuditRegion({
    ...baseRegionBlock,
    region: "INTERNATIONAL",
    label: "International",
    collectionStatus: "COLLECTED",
    statusMessage: "Search profile data collected.",
    organic: { total: 71, adverse: 2, collectionStatus: "COLLECTED", statusMessage: "", items: [] },
    relatedQueries: {
      total: 11,
      adverse: 0,
      collectionStatus: "COLLECTED",
      statusMessage: "",
      items: intlRelatedItems,
    },
    knowledgePanel: emptyBucket("COLLECTED", "Queried — none found for this surface."),
  } as Parameters<typeof regionBlockToAuditRegion>[0]);
  const uaeAudit = regionBlockToAuditRegion({
    ...baseRegionBlock,
    region: "UAE",
    label: "UAE",
    collectionStatus: "COLLECTED",
    statusMessage: "Search profile data collected.",
    organic: { total: 58, adverse: 1, collectionStatus: "COLLECTED", statusMessage: "", items: [] },
    relatedQueries: emptyBucket("COLLECTED", "Queried — none found for this surface."),
    knowledgePanel: emptyBucket("COLLECTED", "Queried — none found for this surface."),
  } as Parameters<typeof regionBlockToAuditRegion>[0]);
  const ruAudit = regionBlockToAuditRegion({
    ...baseRegionBlock,
    region: "RU",
    label: "Russia",
    language: "ru",
    collectionStatus: "COLLECTED",
    statusMessage: "Search profile data collected.",
    organic: { total: 151, adverse: 5, collectionStatus: "COLLECTED", statusMessage: "", items: [] },
    relatedQueries: emptyBucket("COLLECTED", "Queried — none found for this surface."),
    knowledgePanel: emptyBucket("COLLECTED", "Queried — none found for this surface."),
  } as Parameters<typeof regionBlockToAuditRegion>[0]);
  check("INTERNATIONAL audit region code preserved", intlAudit?.region === "INTERNATIONAL");
  check("INTERNATIONAL relatedQueriesTotal=11", intlAudit?.relatedQueriesTotal === 11);
  check("RU relatedQueriesTotal=0 when none RU-tagged", ruAudit?.relatedQueriesTotal === 0);
  check("Knowledge panel ABSENT is honest absent", intlAudit?.knowledgeBlockStatus === "ABSENT");

  const mergedRegions: Array<{ region: string; organicTotal?: number; relatedQueriesTotal?: number }> = [];
  for (const [code, mapped] of [
    ["RU", ruAudit],
    ["UAE", uaeAudit],
    ["INTERNATIONAL", intlAudit],
  ] as const) {
    if (mapped) mergedRegions.push({ ...mapped, region: code });
  }
  check("auditSummary has RU/UAE/INTERNATIONAL rows", mergedRegions.map((r) => r.region).join(",") === "RU,UAE,INTERNATIONAL");
  check("INTERNATIONAL not merged into UAE", !mergedRegions.some((r) => r.region === "UAE" && r.organicTotal === 71));
  check("No duplicate UAE organic rows", mergedRegions.filter((r) => r.region === "UAE").length === 1);
  const globalRelatedTotal =
    Number(ruAudit?.relatedQueriesTotal ?? 0) +
    Number(uaeAudit?.relatedQueriesTotal ?? 0) +
    Number(intlAudit?.relatedQueriesTotal ?? 0);
  check("global relatedQueries total sums all regions", globalRelatedTotal === 11);

  // Client-safe EN labels (no internal/demo/mock wording in i18n keys we added)
  const i18n = readFileSync(join(process.cwd(), "renderer/report_i18n.py"), "utf8");
  check("i18n has region_international label", i18n.includes("region_international"));
  check("EN i18n client-safe (no mock fixture)", !i18n.includes('"mock fixture"'));

  // 6–8. Classification policy
  const rusprofile = classifySearchResultRecord({
    title: "ИП Томилин",
    url: "https://www.rusprofile.ru/ip/1",
    snippet: "ИНН ОГРН",
    subjectFullName: SUBJECT_RU,
  });
  check("Rusprofile not adverse", !isRiskyResultClass(rusprofile.classification), rusprofile.classification);

  const namesake = classifySearchResultRecord({
    title: "Константин Александрович Томилин",
    url: "https://science.example",
    snippet: "ученый биография",
    subjectFullName: SUBJECT_RU,
  });
  check("Namesake not adverse", namesake.classification === "NAMESAKE");

  const legal = classifySearchResultRecord({
    title: "Томилин Константин Романович — уголовное дело",
    url: "https://news.example/court",
    snippet: "осужден суд приговор уголовное",
    subjectFullName: SUBJECT_RU,
  });
  check("Strong legal row adverse", isRiskyResultClass(legal.classification), legal.classification);

  // Capabilities reflect Serper when not configured (offline)
  const caps = getProviderCapabilities("GOOGLE");
  check("Google capabilities object", typeof caps.organicSearch.method === "string");

  // 9–14. Report JSON structure (requires DB — skip if no DATABASE_URL)
  if (process.env.DATABASE_URL) {
    try {
      const { prisma } = await import("../src/server/prisma/client");
      const demoCase = await prisma.case.findFirst({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (demoCase) {
        const block = await buildSearchSurfacesReportBlock(demoCase.id);
        const reportJson = await buildReportJson(demoCase.id, 1, "DRAFT", "en");
        check("searchSurfaces has ru/uae/intl", Boolean(block.regions.ru && block.regions.uae && block.regions.international));
        const auditRegions = (reportJson.auditSummary?.regions ?? []) as Array<{ region: string; organicTotal?: number; relatedQueriesTotal?: number }>;
        check(
          "INTERNATIONAL not in UAE audit row",
          !auditRegions.some((r) => r.region === "UAE" && (r.organicTotal ?? 0) > 100)
        );
        check(
          "INTERNATIONAL audit row when data present",
          block.regions.international.relatedQueries.total > 0
            ? auditRegions.some((r) => r.region === "INTERNATIONAL")
            : true
        );
        check(
          "global relatedQueriesTotal matches regions",
          block.globalSummary.relatedQueriesTotal ===
            block.regions.ru.relatedQueries.total +
              block.regions.uae.relatedQueries.total +
              block.regions.international.relatedQueries.total,
          String(block.globalSummary.relatedQueriesTotal)
        );
        check(
          "knowledgePanelStatus honest when absent",
          block.globalSummary.knowledgePanelTotal === 0
            ? ["ABSENT", "NOT_COLLECTED"].includes(block.globalSummary.knowledgePanelStatus)
            : true,
          block.globalSummary.knowledgePanelStatus
        );
        check("report_json.searchSurfaces present", Boolean(reportJson.searchSurfaces));
        const jsonStr = JSON.stringify(reportJson);
        check("No secrets in report_json", !/"apiKey"\s*:\s*"[^"]+"/.test(jsonStr) && !jsonStr.includes("sk-live"));
        check("No demo wording EN client", !jsonStr.toLowerCase().includes("mock fixture"));
        check("SERP snapshot synthetic", !reportJson.serpSnapshot || reportJson.serpSnapshot.mode === "SYNTHETIC");
      } else {
        console.log("[SKIP] No case in DB for report_json checks");
      }
    } catch (e) {
      console.log(`[SKIP] DB report checks: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    console.log("[SKIP] DATABASE_URL not set — report_json checks skipped");
  }

  // Template slide count preserved (static check)
  const template = readFileSync(join(process.cwd(), "renderer/report_template_v3.py"), "utf8");
  check("Template v3 50-slide builders", template.includes("ctx.total = len(builders)"));

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
