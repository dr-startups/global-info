import { existsSync } from "node:fs";
import { parseLexisTextDeterministicForTest } from "../src/modules/digital-profile/compliance-providers/lexisnexis-hybrid-import";
import { sanitizeReportJsonForAudience, findClientReportPolicyViolations } from "../src/modules/digital-profile/report/report-data-policy";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function main() {
  check(
    "upload/import route exists",
    existsSync("src/app/api/digital-profile/cases/[id]/compliance/lexisnexis-import/route.ts")
  );
  check(
    "hybrid import service exists",
    existsSync("src/modules/digital-profile/compliance-providers/lexisnexis-hybrid-import.ts")
  );
  check(
    "renderer wiring exists",
    existsSync("renderer/report_template_v3.py") && existsSync("renderer/report_mapper.py")
  );

  const parsed = parseLexisTextDeterministicForTest(
    "doc-1",
    "Potential watchlist mention for subject. Name match is possible and requires review."
  );
  check(
    "ambiguous findings default to review_required",
    parsed.signals.every((s) => s.reviewStatus === "review_required" && s.requiresReview === true)
  );
  check(
    "parser produces client-safe summary",
    /провер|review/i.test(parsed.executiveSummaryClient)
  );

  const internal = {
    meta: { caseNumber: "R74", title: "R74", generatedAt: "2026-01-01", version: 1, status: "DRAFT", language: "ru" },
    subject: { fullName: "Test", aliases: [] },
    dynamicPages: [],
    staticPages: [],
    pricing: [],
    lexisNexisHybrid: {
      sourceLabel: "LexisNexis",
      legalSafeDisclaimer: "not legal conclusion",
      parsedSignalSummary: {
        totalDocuments: 1,
        totalSignals: 1,
        reviewRequired: 1,
        parserStatus: "warning",
        conversionStatus: "warning",
        executiveSummaryClient: "review required",
      },
      documents: [
        {
          id: "doc-1",
          kind: "lexisnexis_report",
          sourceLabel: "LexisNexis",
          fileName: "lexis.docx",
          storageKey: "cases/x/evidence/y/file.docx",
          importedAt: "2026-01-01",
          status: "parse_warning",
          pageCount: 1,
          renderedPages: [
            {
              pageNumber: 1,
              storageKey: "cases/x/evidence/y/page-001.png",
              renderStatus: "warning",
              renderWarning: "test",
            },
          ],
          parsedAnalytics: {
            parserVersion: "v1",
            parserStatus: "warning",
            executiveSummaryClient: "ok",
            overallReviewStatus: "review_required",
            riskLevelSuggestion: "unknown",
            confidenceLabel: "low",
            signalCounts: {
              totalSignals: 1,
              reviewRequired: 1,
              potentialMatches: 1,
              adverseMedia: 0,
              sanctionsOrWatchlist: 1,
              legalOrRegulatory: 0,
              pepOrPoliticalExposure: 0,
              corporateOrOwnership: 0,
              unknown: 0,
            },
            parserWarnings: ["w"],
            rawExtractedText: "raw",
            signals: [
              {
                id: "s1",
                categoryLabelRu: "Санкционные / watchlist-сигналы",
                categoryLabelEn: "Sanctions / watchlist signals",
                reviewStatus: "review_required",
                confidenceLabel: "medium",
                clientSafeFinding: "signal",
                clientSafeReason: "review",
                internalReason: "debug",
              },
            ],
          },
          internalNotes: ["x"],
        },
      ],
    },
  } as Record<string, unknown>;
  const client = sanitizeReportJsonForAudience(internal, "client");
  const text = JSON.stringify(client);
  check("client keeps lexis hybrid summary", text.includes("lexisNexisHybrid"));
  check("client strips parser warnings", !text.includes("parserWarnings"));
  check("client strips internalReason", !text.includes("internalReason"));
  check("client strips storage keys", !text.includes("storageKey"));
  check("client strips raw extracted text", !text.includes("rawExtractedText"));
  check(
    "client contains no forbidden policy markers",
    findClientReportPolicyViolations(text).every((m) => !["parserWarnings", "rawExtractedText"].includes(m))
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
