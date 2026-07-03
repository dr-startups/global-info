/**
 * R6.1 smoke — commercial/offer block structure and client-safe output.
 */
import {
  REPORT_CLIENT_SLIDE_COUNT,
  REPORT_INTERNAL_SLIDE_COUNT,
  sanitizeReportJsonForAudience,
} from "../src/modules/digital-profile/report/report-data-policy";
import { buildOfferConfig } from "../src/modules/digital-profile/report/offer-config";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function hasRuText(input: string): boolean {
  return /[А-Яа-яЁё]/.test(input);
}

function hasEnText(input: string): boolean {
  return /[A-Za-z]/.test(input);
}

function main() {
  const ru = buildOfferConfig("ru");
  const en = buildOfferConfig("en");
  const ruSolutions = ru.solutions ?? [];
  const enSolutions = en.solutions ?? [];

  check("offer config exists for RU", !!ru && Array.isArray(ruSolutions) && ruSolutions.length >= 3);
  check("offer config exists for EN", !!en && Array.isArray(enSolutions) && enSolutions.length >= 3);

  check(
    "RU labels are present",
    hasRuText(String(ru.productName ?? "")) &&
      hasRuText(String(ru.reportSubtitle ?? "")) &&
      ruSolutions.every((s) => hasRuText(String(s.objective ?? "")))
  );
  check(
    "EN labels are present",
    hasEnText(String(en.productName ?? "")) &&
      hasEnText(String(en.reportSubtitle ?? "")) &&
      enSolutions.every((s) => hasEnText(String(s.objective ?? "")))
  );

  check(
    "offer pages 37–50 source fields are complete",
    ruSolutions.slice(0, 3).every(
      (s) =>
        !!s.title &&
        !!s.objective &&
        !!s.duration &&
        Array.isArray(s.includedItems) &&
        Array.isArray(s.workPlan) &&
        Array.isArray(s.deliverables) &&
        Array.isArray(s.expectedResults)
    ) &&
      Array.isArray(ru.processSteps) &&
      ru.processSteps.length >= 3 &&
      !!ru.callToAction &&
      !!ru.contactEmail &&
      !!ru.website
  );

  const internalJson = {
    offer: ru,
    providerDiagnostics: { runtimeStrategy: { requestedRuntimeMode: "real_first_with_fallback" } },
    queryPlanDiagnostics: { queryPlanId: "r61-smoke-plan" },
    liveProviderSmoke: { smokeRunId: "smoke-r61" },
    sourceQualitySummary: { includedCount: 1, reviewCount: 0, excludedCount: 0, duplicateCount: 0 },
  } as Record<string, unknown>;
  const clientJson = sanitizeReportJsonForAudience(
    JSON.parse(JSON.stringify(internalJson)) as Record<string, unknown>,
    "client"
  );
  const clientStr = JSON.stringify(clientJson);
  check("offer block survives client sanitization", clientStr.includes("offer"));
  check("no internal/debug terms are client-visible", !/providerDiagnostics|liveProviderSmoke|queryPlanDiagnostics/i.test(clientStr));
  check(
    "page count remains internal 73 / client 72",
    REPORT_INTERNAL_SLIDE_COUNT === 73 && REPORT_CLIENT_SLIDE_COUNT === 72
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
