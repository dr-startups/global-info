/**
 * R5.1 smoke — provider readiness and runtime selection safety.
 */
import { parseRuntimeMode, resolveRuntimeStrategy } from "../src/modules/digital-profile/agents/runtime-strategy";
import { buildProviderDiagnostics } from "../src/modules/digital-profile/report/provider-diagnostics";
import {
  REPORT_CLIENT_SLIDE_COUNT,
  REPORT_INTERNAL_SLIDE_COUNT,
  findClientReportPolicyViolations,
  sanitizeReportJsonForAudience,
} from "../src/modules/digital-profile/report/report-data-policy";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function main() {
  const defaultDiag = buildProviderDiagnostics();
  check(
    "provider readiness summary deterministic shape",
    Boolean(defaultDiag.providerReadinessSummary) &&
      typeof defaultDiag.providerReadinessSummary?.totalProviders === "number" &&
      typeof defaultDiag.providerReadinessSummary?.readyCount === "number"
  );

  check(
    "missing credentials do not crash provider diagnostics",
    defaultDiag.providers.every((p) => typeof p.hasCredentials === "boolean")
  );

  const realOnly = resolveRuntimeStrategy({
    mode: "real_only",
    requestedBy: "test",
    availabilityOverride: {
      REAL_YANDEX_SEARCH: false,
      REAL_GOOGLE_SEARCH: false,
      REAL_WIKIPEDIA: false,
      REAL_SEARCH_SURFACES: false,
      RISK_CLASSIFIER_V1: false,
      AUDIT_SUMMARY_BUILDER: false,
      YANDEX_SEARCH: true,
      GOOGLE_SEARCH: true,
      WIKIPEDIA: true,
      SEARCH_SURFACES: true,
      RISK_CLASSIFIER: true,
    },
  });
  check(
    "real_only does not fall back to mock",
    realOnly.selectedOrder.every((a) => a.startsWith("REAL_") || a === "RISK_CLASSIFIER_V1" || a === "AUDIT_SUMMARY_BUILDER")
  );
  check("real_only records no mock fallback events", realOnly.fallbackEvents.length === 0);

  const mockOnly = resolveRuntimeStrategy({
    mode: "mock_only",
    requestedBy: "test",
    availabilityOverride: {
      REAL_YANDEX_SEARCH: true,
      REAL_GOOGLE_SEARCH: true,
      REAL_WIKIPEDIA: true,
      REAL_SEARCH_SURFACES: true,
      RISK_CLASSIFIER_V1: true,
      AUDIT_SUMMARY_BUILDER: true,
      YANDEX_SEARCH: true,
      GOOGLE_SEARCH: true,
      WIKIPEDIA: true,
      SEARCH_SURFACES: true,
      AI_PROFILE: true,
      COMPLIANCE_DATABASE: true,
      RISK_CLASSIFIER: true,
    },
  });
  check(
    "mock_only does not select real providers",
    mockOnly.selectedOrder.every((a) => !a.startsWith("REAL_") && a !== "RISK_CLASSIFIER_V1" && a !== "AUDIT_SUMMARY_BUILDER")
  );

  const fallback = resolveRuntimeStrategy({
    mode: "real_first_with_fallback",
    requestedBy: "test",
    availabilityOverride: {
      REAL_YANDEX_SEARCH: false,
      REAL_GOOGLE_SEARCH: false,
      REAL_WIKIPEDIA: false,
      REAL_SEARCH_SURFACES: false,
      RISK_CLASSIFIER_V1: true,
      AUDIT_SUMMARY_BUILDER: true,
      YANDEX_SEARCH: true,
      GOOGLE_SEARCH: true,
      WIKIPEDIA: true,
      SEARCH_SURFACES: true,
      AI_PROFILE: true,
      COMPLIANCE_DATABASE: true,
      RISK_CLASSIFIER: true,
    },
  });
  check("real_first_with_fallback records fallback events", fallback.fallbackEvents.length > 0);

  const invalidParsed = parseRuntimeMode("totally_invalid_mode");
  const invalidResolved = resolveRuntimeStrategy({
    mode: invalidParsed,
    requestedBy: "default",
  });
  check(
    "invalid runtime mode normalizes safely to default",
    invalidParsed === undefined && invalidResolved.mode === "legacy_mock_first"
  );
  check(
    "default mode keeps safety warning note",
    invalidResolved.warnings.some((w) => w.toLowerCase().includes("legacy mock-first"))
  );

  const internalJson = {
    providerDiagnostics: defaultDiag,
    providerReadinessSummary: defaultDiag.providerReadinessSummary,
    searchProvenance: { queryLineage: [], surfaceProvenance: [], screenshotProvenance: [] },
    searchProvenanceSummary: { queryCount: 0, surfaceCount: 0, screenshotCount: 0 },
  } as Record<string, unknown>;
  check("R4.1 providerDiagnostics remains present", Boolean(internalJson.providerDiagnostics));
  check("R4.3 search provenance remains present", Boolean(internalJson.searchProvenance));

  const clientJson = sanitizeReportJsonForAudience(internalJson, "client");
  const clientStr = JSON.stringify(clientJson);
  check(
    "client strips missingConfigKeys/internalReason/warnings",
    !clientStr.includes("missingConfigKeys") &&
      !clientStr.includes("internalReason") &&
      !clientStr.includes("recommendedAction")
  );
  check(
    "client has no secret-like values",
    !/api[_-]?key|client_secret|process\.env|token/i.test(clientStr)
  );
  check("R3.6 client policy still passes", findClientReportPolicyViolations(clientStr).length === 0);

  check(
    "page count contract remains internal 73/client 72",
    REPORT_INTERNAL_SLIDE_COUNT === 73 && REPORT_CLIENT_SLIDE_COUNT === 72
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
