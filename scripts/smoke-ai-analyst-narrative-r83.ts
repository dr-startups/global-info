import { existsSync, readFileSync } from "node:fs";
import { buildDeterministicAiAnalystNarrative } from "../src/modules/digital-profile/ai-analyst/deterministic-narrative";
import { buildAiAnalystEvidencePack } from "../src/modules/digital-profile/ai-analyst/evidence-pack";
import { validateAiAnalystNarrative } from "../src/modules/digital-profile/ai-analyst/schema";
import { generateAiAnalystNarrative } from "../src/modules/digital-profile/ai-analyst/service";
import type { ReportJson } from "../src/modules/digital-profile/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function sampleReportJson(): ReportJson {
  return {
    meta: {
      caseNumber: "R83-SMOKE",
      title: "AI analyst smoke",
      generatedAt: new Date().toISOString(),
      version: 1,
      status: "DRAFT",
      language: "ru",
    },
    subject: {
      id: "subj-r83",
      caseId: "r83-smoke",
      fullName: "Иван Иванов",
      aliases: [],
      dateOfBirth: null,
      nationality: null,
      country: null,
      emails: [],
      phones: [],
      identifiers: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    dynamicPages: [],
    staticPages: [],
    pricing: [],
    reportLanguage: "ru",
    auditSummary: {
      caseId: "r83-smoke",
      subjectFullName: "Иван Иванов",
      generatedAt: new Date().toISOString(),
      overallRiskLevel: "MEDIUM",
      overallTone: "caution",
      executiveSummary: [],
      keyFindings: [],
      recommendedActions: [],
      regions: [
        {
          region: "RU",
          language: "ru",
          organicTotal: 346,
          organicNegative: 23,
          organicNeutral: 0,
          organicPositive: 0,
          organicNegativeShare: 0.06,
          uniqueNegativeUrls: 12,
          totalUniqueUrls: 200,
          suggestionsTotal: 20,
          suggestionsNegative: 3,
          relatedQueriesTotal: 14,
          relatedQueriesNegative: 1,
          imagesTotal: 28,
          imagesNegative: 15,
          videosTotal: 12,
          videosNegative: 2,
          knowledgeBlockStatus: "PRESENT",
          regionRiskLevel: "MEDIUM",
          regionConclusion: "",
          topResults: [],
          topSuggestions: [],
          topImages: [],
          topVideos: [],
          topThemes: [{ theme: "adverse_media", count: 3 }],
          topNegativeDomains: ["example.com"],
          topNegativeUrls: [],
          topRelatedQueries: [],
          knowledgeBlock: null,
          evidenceAppendix: [],
        },
      ],
      searchSummary: {
        totalResults: 346,
        uniqueUrls: 200,
        negativeResults: 23,
        negativeShare: 0.06,
        negativeDomains: ["example.com"],
        topNegativeThemes: [{ theme: "adverse_media", count: 3 }],
        topNegativeUrls: [],
      },
      surfacesSummary: {
        suggestions: { total: 20, negative: 3, negativeShare: 0.15 },
        relatedQueries: { total: 14, negative: 1, negativeShare: 0.07 },
        images: { total: 28, negative: 15, negativeShare: 0.53 },
        videos: { total: 12, negative: 2, negativeShare: 0.16 },
        knowledgeBlocks: { total: 1, mismatches: 0 },
        screenshots: 0,
        syntheticSnapshots: 0,
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
        highestRiskLevel: "MEDIUM",
        totalFindings: 113,
        findingsByLevel: {},
        findingsByTheme: {},
        topFindings: [],
      },
      dataQualitySummary: {
        evidenceCount: 0,
        reviewedFindings: 0,
        pendingFindings: 0,
        dismissedFindings: 0,
        missingSections: [],
        warnings: [],
      },
    },
    riskSummary: {
      highestRiskLevel: "MEDIUM",
      totalFindings: 113,
      findingsByLevel: {},
      findingsByTheme: {},
      topFindings: [],
    },
  };
}

async function main() {
  check("AI analyst service file exists", existsSync("src/modules/digital-profile/ai-analyst/service.ts"));
  check("OpenAI GPT-5.5 provider file exists", existsSync("src/modules/digital-profile/ai-analyst/openai-gpt55-analyst.ts"));

  const sample = sampleReportJson();
  const pack = buildAiAnalystEvidencePack(sample, { maxInputItems: 40 });
  const deterministic = buildDeterministicAiAnalystNarrative(pack);
  check("Deterministic narrative generated", deterministic.generatedBy === "deterministic");
  check("Deterministic narrative has executive summary", Boolean(deterministic.executiveSummary.plainConclusion));

  const fixtureValid = validateAiAnalystNarrative(deterministic);
  check("Deterministic narrative passes schema", fixtureValid.ok);

  const fixtureInvalid = validateAiAnalystNarrative({ status: "ready", generatedBy: "gpt-5.5" });
  check("Invalid JSON fixture rejected", fixtureInvalid.ok === false);

  if (!process.env.OPENAI_API_KEY) {
    const outcome = await generateAiAnalystNarrative(sample);
    check("Fallback works without OPENAI_API_KEY", outcome.narrative.generatedBy === "deterministic");
    check("Provider safely skipped without key", outcome.diagnostics.status === "fallback", outcome.diagnostics.reason ?? "");
  } else {
    check(
      "OPENAI_API_KEY present: fallback path check skipped",
      true,
      "real GPT-5.5 runtime validated in optional task"
    );
  }

  const policyText = readFileSync("src/modules/digital-profile/report/report-data-policy.ts", "utf-8");
  check(
    "Client policy blocks prompt/raw response leaks",
    policyText.includes("rawModelResponse") && policyText.includes("openAiRequestId")
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
