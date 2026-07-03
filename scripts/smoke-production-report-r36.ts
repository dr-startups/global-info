/**
 * R3.6 — production mode / release gate smoke test.
 *
 * Verifies audience/production policy, client vs internal JSON parity, and that
 * client sanitization removes all internal-only diagnostics + forbidden markers.
 * No external calls or DB access.
 */
import {
  sanitizeReportJsonForAudience,
  getReportAudiencePolicy,
  normalizeProductionReportMode,
  findClientReportPolicyViolations,
  assertClientReportPolicy,
  isClientSafeReportJson,
  REPORT_INTERNAL_SLIDE_COUNT,
  REPORT_CLIENT_SLIDE_COUNT,
} from "../src/modules/digital-profile/report/report-data-policy";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** A report_json fixture loaded with internal-heavy / forbidden material. */
function makeInternalReportJson(): Record<string, unknown> {
  return {
    meta: { language: "ru", reportWarnings: [] },
    subject: { fullName: "Томилин Константин Романович" },
    providerDiagnostics: {
      auditMode: "mock_first",
      runtimeStrategy: { mode: "legacy_mock_first", selectedOrder: ["YANDEX_SEARCH"] },
      providers: [
        {
          id: "google",
          capabilityLevel: "mock",
          internalDetail: "adapter=MockGoogleAdapter; sourceMode=mock",
          providerAdapter: "MockGoogleAdapter",
        },
      ],
      summary: { readyCount: 0, mockOrStubCount: 1 },
    },
    entityFiltering: {
      enabled: true,
      subjectIdentitySummary: { hasPatronymic: true, hasLatinAliases: true, hasRegionHints: true },
      counts: { strictSubject: 1, namesake: 2, excludedByIdentity: 402 },
      topExclusionReasons: ["NAMESAKE_PATRONYMIC_CONFLICT", "WEAK_LATIN_OVERLAP"],
    },
    complianceRiskIntel: {
      enabled: true,
      language: "ru",
      counts: { confirmed: 0, review: 1, excluded: 1, total: 2 },
      complianceHits: [
        {
          sourceLabel: "Официальный источник",
          reviewState: "review",
          isClientVisible: true,
          isExcludedNoise: false,
          internalReason: "raw_review=NEEDS_REVIEW; raw_source=OFFICIAL_API; score=60",
        },
        {
          sourceLabel: "Официальный источник",
          reviewState: "excluded",
          isClientVisible: false,
          isExcludedNoise: true,
          internalReason: "raw_review=FALSE_POSITIVE; raw_source=MOCK; score=10",
        },
      ],
      riskReasoning: {
        riskLevel: "LOW",
        reasoningSummary: "По доступным данным подтверждённых материалов высокого риска не выявлено.",
        legalSafeDisclaimer: "Материалы являются аналитической сводкой и требуют проверки.",
        limitingFactors: ["Часть материалов в очереди аналитической проверки."],
      },
    },
    selectedEvidence: {
      metrics: {},
      images: {},
      videos: {},
      appendix: { confirmedSubjectEvidence: [], reviewQueue: [{ rawMetadata: { x: 1 } }] },
      compliance: {},
    },
    searchSurfaces: {
      regions: {
        RU: {
          organic: {
            items: [
              {
                title: "ok",
                reportEligibility: "CLIENT_INCLUDE",
                contentClass: "SUBJECT",
                classification: "UNCLASSIFIED",
                identityDecision: "LIKELY_SUBJECT",
              },
              { title: "hidden", reportEligibility: "EXCLUDE", contentClass: "NAMESAKE" },
            ],
            excludedItems: [{ title: "namesake", classification: "NOT_SUBJECT" }],
            qualityStats: { totalCollected: 2, selectedForReport: 1, sourceMode: "mock" },
          },
        },
      },
      dataQualityWarnings: ["ok"],
    },
  };
}

function main() {
  // --- audience / production policy ---
  const internalPolicy = getReportAudiencePolicy("internal");
  const clientPolicy = getReportAudiencePolicy("client");
  const productionPolicy = getReportAudiencePolicy("production");
  check("internal policy includes diagnostics page", internalPolicy.includeDiagnosticsPage === true);
  check("client policy excludes diagnostics page", clientPolicy.includeDiagnosticsPage === false);
  check("production resolves to client-safe", productionPolicy.audience === "client");
  check("production excludes internal diagnostics", productionPolicy.includeInternalDiagnostics === false);
  check("internal slide count contract = 73", internalPolicy.expectedSlideCount === REPORT_INTERNAL_SLIDE_COUNT && REPORT_INTERNAL_SLIDE_COUNT === 73);
  check("client slide count contract = 72", clientPolicy.expectedSlideCount === REPORT_CLIENT_SLIDE_COUNT && REPORT_CLIENT_SLIDE_COUNT === 72);
  check("normalizeProductionReportMode internal", normalizeProductionReportMode("internal") === "internal");
  check("normalizeProductionReportMode production->client", normalizeProductionReportMode("production") === "client");
  check("normalizeProductionReportMode unknown->client", normalizeProductionReportMode("weird") === "client");
  check("normalizeProductionReportMode empty->client", normalizeProductionReportMode(undefined) === "client");

  // --- internal audience: diagnostics preserved ---
  const internalJson = sanitizeReportJsonForAudience(makeInternalReportJson(), "internal");
  check("internal keeps providerDiagnostics", "providerDiagnostics" in internalJson);

  // --- client audience: diagnostics + forbidden material removed ---
  const clientJson = sanitizeReportJsonForAudience(makeInternalReportJson(), "client");
  check("client strips providerDiagnostics entirely", !("providerDiagnostics" in clientJson));

  const cri = (clientJson.complianceRiskIntel ?? {}) as Record<string, unknown>;
  const criHits = Array.isArray(cri.complianceHits) ? cri.complianceHits : [];
  check("client compliance drops excluded/noise hits", criHits.length === 1);
  check(
    "client compliance drops internalReason",
    criHits.every((h) => !("internalReason" in (h as Record<string, unknown>)))
  );

  const ef = (clientJson.entityFiltering ?? {}) as Record<string, unknown>;
  check("client entity filtering drops topExclusionReasons", !("topExclusionReasons" in ef));
  check("client entity filtering keeps safe counts", typeof ef.counts === "object");

  // --- raw enum normalization + excluded-items drop ---
  const ruOrganic =
    (((clientJson.searchSurfaces as Record<string, unknown>)?.regions as Record<string, unknown>)
      ?.RU as Record<string, unknown>)?.organic as Record<string, unknown> | undefined;
  const firstItem = (ruOrganic?.items as Record<string, unknown>[] | undefined)?.[0] ?? {};
  check("client normalizes identityDecision enum", firstItem.identityDecision === "subject_likely");
  check("client normalizes classification enum", firstItem.classification === "neutral");
  check("client drops excludedItems from search surfaces", !("excludedItems" in (ruOrganic ?? {})));

  // --- serialized client JSON is production-safe ---
  const clientStr = JSON.stringify(clientJson);
  const violations = findClientReportPolicyViolations(clientStr);
  check("client JSON has zero policy violations", violations.length === 0, violations.join(", "));
  check("isClientSafeReportJson true for sanitized client", isClientSafeReportJson(clientStr));
  for (const marker of [
    "MATCH_CONFIRMED",
    "NEEDS_REVIEW",
    "FALSE_POSITIVE",
    "providerAdapter",
    "sourceMode",
    "rawMetadata",
    "internalDetail",
    "internalReason",
    "topExclusionReasons",
    "process.env",
    "localhost",
  ]) {
    check(`client JSON free of "${marker}"`, !clientStr.includes(marker));
  }

  // --- assertion gate detects injected leakage ---
  const leaky = JSON.stringify({ note: "adapter providerAdapter=Mock; sourceMode=mock" });
  check("findClientReportPolicyViolations detects leakage", findClientReportPolicyViolations(leaky).length >= 2);
  let threw = false;
  try {
    assertClientReportPolicy(leaky, { throwOnViolation: true });
  } catch {
    threw = true;
  }
  check("assertClientReportPolicy throws on violation", threw);
  check(
    "assertClientReportPolicy silent when clean",
    assertClientReportPolicy(clientStr).length === 0
  );

  // --- client-safe wording preserved (R3.5 legal disclaimer survives) ---
  const rr = (cri.riskReasoning ?? {}) as Record<string, unknown>;
  check("client keeps legal-safe disclaimer", String(rr.legalSafeDisclaimer ?? "").length > 0);
  check(
    "client low wording remains safe",
    String(rr.reasoningSummary ?? "").includes("не выявлено")
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
