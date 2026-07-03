/**
 * R4.1 — provider runtime / real source collection hardening smoke test.
 *
 * Verifies the provider capability matrix, runtime selection correctness,
 * source provenance, richer diagnostics summary, and R3.6 client-safety.
 * No network calls, no DB — pure resolver + fixtures.
 */
import { resolveRuntimeStrategy } from "../src/modules/digital-profile/agents/runtime-strategy";
import {
  buildProviderDiagnostics,
  buildSourceProvenance,
  summarizeProviderDiagnostics,
} from "../src/modules/digital-profile/report/provider-diagnostics";
import {
  sanitizeReportJsonForAudience,
  findClientReportPolicyViolations,
} from "../src/modules/digital-profile/report/report-data-policy";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const ALL_AGENTS = [
  "REAL_YANDEX_SEARCH",
  "YANDEX_SEARCH",
  "REAL_GOOGLE_SEARCH",
  "GOOGLE_SEARCH",
  "REAL_WIKIPEDIA",
  "WIKIPEDIA",
  "REAL_SEARCH_SURFACES",
  "SEARCH_SURFACES",
  "AI_PROFILE",
  "COMPLIANCE_DATABASE",
  "RISK_CLASSIFIER_V1",
  "RISK_CLASSIFIER",
  "AUDIT_SUMMARY_BUILDER",
];

function override(enabled: string[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const a of ALL_AGENTS) map[a] = enabled.includes(a);
  return map;
}

function main() {
  // ---- 1) capability matrix coverage ----
  const diag = buildProviderDiagnostics();
  const ids = new Set(diag.providers.map((p) => p.id));
  for (const id of ["yandex", "google", "serper", "wikipedia", "compliance", "screenshots", "synthetic_serp"]) {
    check(`capability matrix includes ${id}`, ids.has(id));
  }
  check(
    "every provider has a support matrix",
    diag.providers.every((p) => p.supports && typeof p.supports === "object")
  );
  check(
    "every provider has runtimeKind + hasCredentials boolean",
    diag.providers.every(
      (p) => typeof p.runtimeKind === "string" && typeof p.hasCredentials === "boolean"
    )
  );
  check("wikipedia does not require secrets", diag.providers.find((p) => p.id === "wikipedia")?.requiresSecrets === false);
  check("yandex requires secrets", diag.providers.find((p) => p.id === "yandex")?.requiresSecrets === true);

  // ---- 2) no secret values exposed ----
  const diagStr = JSON.stringify(diag);
  check(
    "diagnostics free of secret patterns",
    !/API_KEY|SECRET|BEARER\s|process\.env|[A-Za-z0-9]{32,}/.test(diagStr)
  );

  // ---- 3) real_first_with_fallback selects real first ----
  const rfwf = resolveRuntimeStrategy({
    mode: "real_first_with_fallback",
    availabilityOverride: override([
      "REAL_YANDEX_SEARCH",
      "REAL_GOOGLE_SEARCH",
      "REAL_WIKIPEDIA",
      "REAL_SEARCH_SURFACES",
      "YANDEX_SEARCH",
      "GOOGLE_SEARCH",
      "RISK_CLASSIFIER_V1",
      "AUDIT_SUMMARY_BUILDER",
    ]),
  });
  check(
    "real_first_with_fallback prefers real agents",
    rfwf.selectedOrder.includes("REAL_YANDEX_SEARCH") && rfwf.selectedOrder.includes("REAL_GOOGLE_SEARCH")
  );

  // ---- 4) real_only never silently uses mocks ----
  const realOnly = resolveRuntimeStrategy({
    mode: "real_only",
    availabilityOverride: override(["REAL_YANDEX_SEARCH", "YANDEX_SEARCH", "GOOGLE_SEARCH"]),
  });
  check(
    "real_only excludes mock agents",
    realOnly.selectedOrder.every((a) => a.startsWith("REAL_") || a === "AUDIT_SUMMARY_BUILDER" || a === "RISK_CLASSIFIER_V1")
  );
  check("real_only skips unconfigured real providers with warnings", realOnly.warnings.length > 0);

  // ---- 5) mock_only never selects real providers ----
  const mockOnly = resolveRuntimeStrategy({
    mode: "mock_only",
    availabilityOverride: override([
      "REAL_YANDEX_SEARCH",
      "REAL_GOOGLE_SEARCH",
      "YANDEX_SEARCH",
      "GOOGLE_SEARCH",
      "WIKIPEDIA",
    ]),
  });
  check("mock_only excludes real agents", mockOnly.selectedOrder.every((a) => !a.startsWith("REAL_")));

  // ---- 6) missing config → warning, not crash ----
  let crashed = false;
  let emptyReal: ReturnType<typeof resolveRuntimeStrategy> | null = null;
  try {
    emptyReal = resolveRuntimeStrategy({ mode: "real_only", availabilityOverride: override([]) });
  } catch {
    crashed = true;
  }
  check("missing real config does not crash", !crashed);
  check("missing real config produces warnings", (emptyReal?.warnings.length ?? 0) > 0);

  // ---- 7) fallback events recorded ----
  const fallback = resolveRuntimeStrategy({
    mode: "real_first_with_fallback",
    availabilityOverride: override(["YANDEX_SEARCH", "GOOGLE_SEARCH", "WIKIPEDIA"]),
  });
  check("fallback events recorded when real unavailable", fallback.fallbackEvents.length > 0);
  check(
    "fallback events describe real→mock",
    fallback.fallbackEvents.some((e) => e.from === "real" && e.to === "mock")
  );

  // ---- 8) diagnostics summary counts correct ----
  const summary = summarizeProviderDiagnostics(diag.providers, rfwf);
  check("summary totalProviders matches providers", summary.totalProviders === diag.providers.length);
  check("summary manualCount >= 1", (summary.manualCount ?? 0) >= 1);
  check("summary productionReadyCount is a number", typeof summary.productionReadyCount === "number");
  check("summary fallbackUsedCount reflects runtime", summary.fallbackUsedCount === rfwf.fallbackEvents.length);

  // ---- source provenance ----
  const provenance = buildSourceProvenance(diag.providers, rfwf, {
    organicCollected: 40,
    organicIncluded: 12,
    complianceCollected: 3,
    complianceIncluded: 0,
    complianceReview: 1,
    complianceExcluded: 2,
  });
  check("provenance has one row per provider", provenance.length === diag.providers.length);
  check(
    "provenance organic counts wired for search providers",
    provenance.find((r) => r.sourceProvider === "yandex")?.collected === 40
  );
  check(
    "compliance provenance marked review (manual/stub) under default runtime",
    (diag.sourceProvenance ?? []).find((r) => r.sourceProvider === "compliance")?.inclusionDecision ===
      "review"
  );

  // ---- 9) client sanitization removes internal provider details ----
  const clientJson = sanitizeReportJsonForAudience(
    { providerDiagnostics: diag, subject: { fullName: "Test" } } as Record<string, unknown>,
    "client"
  );
  check("client JSON strips providerDiagnostics entirely", !("providerDiagnostics" in clientJson));

  // ---- 10) R3.6 production policy still passes ----
  const violations = findClientReportPolicyViolations(JSON.stringify(clientJson));
  check("client JSON has zero R3.6 policy violations", violations.length === 0, violations.join(", "));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
