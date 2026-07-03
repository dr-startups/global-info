/**
 * R3.5 — compliance / risk intelligence smoke test.
 *
 * Verifies the display-level normalization is client-safe and semantically
 * correct, without any external calls or data collection.
 */
import {
  buildComplianceRiskIntel,
  sanitizeComplianceRiskIntelForClient,
  normalizeReviewState,
  containsForbiddenClientTerm,
  FORBIDDEN_CLIENT_TERMS,
} from "../src/modules/digital-profile/report/compliance-risk-intel";
import type { ComplianceSummaryBlock } from "../src/modules/digital-profile/compliance-providers/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function hit(
  over: Partial<ComplianceSummaryBlock["topHits"][number]>
): ComplianceSummaryBlock["topHits"][number] {
  return {
    id: "h",
    provider: "DOW_JONES",
    matchedName: "Konstantin Tomilin",
    riskTypes: ["PEP"],
    matchScore: 60,
    confidence: "MEDIUM",
    reviewStatus: "PENDING",
    source: "OFFICIAL_API",
    ...over,
  };
}

function summary(
  hits: ComplianceSummaryBlock["topHits"]
): ComplianceSummaryBlock {
  return {
    providerStatuses: [],
    totalHits: hits.length,
    pendingHits: hits.filter((h) => h.reviewStatus === "PENDING").length,
    confirmedHits: hits.filter((h) => h.reviewStatus === "MATCH_CONFIRMED").length,
    falsePositives: hits.filter((h) => h.reviewStatus === "FALSE_POSITIVE").length,
    byRiskType: {},
    topHits: hits,
    dataQualityWarnings: [],
    reviewRequiredWarning: "",
  };
}

function main() {
  // --- review-state mapping ---
  check("confirmed maps to confirmed", normalizeReviewState("MATCH_CONFIRMED") === "confirmed");
  check("pending maps to review", normalizeReviewState("PENDING") === "review");
  check("needs_review maps to review", normalizeReviewState("NEEDS_REVIEW") === "review");
  check("false_positive maps to excluded", normalizeReviewState("FALSE_POSITIVE") === "excluded");
  check("dismissed maps to excluded", normalizeReviewState("DISMISSED") === "excluded");

  // --- normalized compliance labels (RU + EN exist) ---
  const ru = buildComplianceRiskIntel({ reportLanguage: "ru", complianceSummary: summary([hit({})]) });
  const en = buildComplianceRiskIntel({ reportLanguage: "en", complianceSummary: summary([hit({})]) });
  check("ru language resolved", ru.language === "ru");
  check("en language resolved", en.language === "en");
  check("ru default when unspecified", buildComplianceRiskIntel({}).language === "ru");
  check("ru hit has normalized source label", ru.complianceHits[0].sourceLabel === "Официальный источник");
  check("en hit has normalized source label", en.complianceHits[0].sourceLabel === "Official source");
  check("ru review status label localized", ru.complianceHits[0].reviewStatusLabel.length > 0);

  // --- risk level mapping LOW / MEDIUM / HIGH ---
  const high = buildComplianceRiskIntel({ complianceSummary: summary([hit({ matchScore: 90 })]) });
  const med = buildComplianceRiskIntel({ complianceSummary: summary([hit({ matchScore: 60 })]) });
  const low = buildComplianceRiskIntel({ complianceSummary: summary([hit({ matchScore: 10 })]) });
  check("HIGH risk level from high score", high.complianceHits[0].riskLevel === "HIGH");
  check("MEDIUM risk level from mid score", med.complianceHits[0].riskLevel === "MEDIUM");
  check("LOW risk level from low score", low.complianceHits[0].riskLevel === "LOW");

  // --- review vs confirmed separation ---
  const confirmed = buildComplianceRiskIntel({
    complianceSummary: summary([hit({ reviewStatus: "MATCH_CONFIRMED" })]),
  });
  check("confirmed hit isConfirmed", confirmed.complianceHits[0].isConfirmed === true);
  check("confirmed hit not requiresReview", confirmed.complianceHits[0].requiresReview === false);
  const review = buildComplianceRiskIntel({ complianceSummary: summary([hit({ reviewStatus: "PENDING" })]) });
  check("pending hit requiresReview", review.complianceHits[0].requiresReview === true);
  check("pending hit not confirmed", review.complianceHits[0].isConfirmed === false);

  // --- excluded/noise not client-confirmed ---
  const excluded = buildComplianceRiskIntel({
    complianceSummary: summary([hit({ reviewStatus: "FALSE_POSITIVE" })]),
  });
  check("excluded hit isExcludedNoise", excluded.complianceHits[0].isExcludedNoise === true);
  check("excluded hit not client visible", excluded.complianceHits[0].isClientVisible === false);
  const excludedClient = sanitizeComplianceRiskIntelForClient(excluded);
  check("client sanitize drops excluded hit", (excludedClient?.complianceHits.length ?? -1) === 0);
  check(
    "client sanitize drops internalReason",
    !confirmed.complianceHits.length ||
      !("internalReason" in (sanitizeComplianceRiskIntelForClient(confirmed)?.complianceHits[0] ?? {}))
  );

  // --- manual import semantics ---
  const manualReview = buildComplianceRiskIntel({
    complianceSummary: summary([hit({ provider: "MANUAL_IMPORT", source: "MANUAL", reviewStatus: "PENDING" })]),
  });
  check("manual import detected as manual", manualReview.complianceHits[0].isManualImport === true);
  check("manual review counted", manualReview.manualImport.review === 1);
  check(
    "manual review not confirmed wording",
    manualReview.complianceHits[0].isConfirmed === false &&
      manualReview.complianceHits[0].requiresReview === true
  );
  const manualConfirmed = buildComplianceRiskIntel({
    complianceSummary: summary([hit({ provider: "MANUAL_IMPORT", source: "MANUAL", reviewStatus: "MATCH_CONFIRMED" })]),
  });
  check("manual confirmed counted", manualConfirmed.manualImport.confirmed === 1);
  const manualExcluded = buildComplianceRiskIntel({
    complianceSummary: summary([hit({ provider: "MANUAL_IMPORT", source: "MANUAL", reviewStatus: "DISMISSED" })]),
  });
  check("manual excluded counted", manualExcluded.manualImport.excluded === 1);

  // --- risk reasoning: LOW phrased safely, disclaimer present ---
  const rr = low.riskReasoning;
  check("risk reasoning has summary", rr.reasoningSummary.length > 0);
  check("risk reasoning has legal-safe disclaimer", rr.legalSafeDisclaimer.length > 0);
  check("risk reasoning has limiting factors", rr.limitingFactors.length > 0);
  check("risk reasoning has recommended action", rr.recommendedAction.length > 0);

  // --- client-safe wording: no forbidden legal overclaiming / raw enums ---
  const allClientText: string[] = [];
  for (const intel of [ru, en, high, confirmed, review, manualReview, manualConfirmed, low]) {
    const safe = sanitizeComplianceRiskIntelForClient(intel)!;
    for (const h of safe.complianceHits) {
      allClientText.push(h.sourceLabel, h.matchTitle, h.matchType, h.reviewStatusLabel, h.actionLabel, h.clientSafeSummary);
    }
    allClientText.push(
      safe.riskReasoning.reasoningSummary,
      safe.riskReasoning.recommendedAction,
      safe.riskReasoning.legalSafeDisclaimer,
      ...safe.riskReasoning.limitingFactors,
      safe.legalSafeDisclaimer,
      safe.manualImport.note
    );
  }
  const bad = allClientText.filter((t) => t && containsForbiddenClientTerm(t));
  check("no forbidden client terms in normalized wording", bad.length === 0, bad.join(" | "));
  check("forbidden term guard is populated", FORBIDDEN_CLIENT_TERMS.length >= 10);
  check("guard detects a known bad term", containsForbiddenClientTerm("MATCH_CONFIRMED raw"));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
