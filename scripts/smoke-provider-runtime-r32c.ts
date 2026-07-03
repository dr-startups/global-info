import { resolveRuntimeStrategy } from "../src/modules/digital-profile/agents/runtime-strategy";
import {
  buildProviderDiagnosticsFixture,
  summarizeProviderDiagnostics,
} from "../src/modules/digital-profile/report/provider-diagnostics";
import type { ReportProviderDiagnosticItem } from "../src/modules/digital-profile/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const AVAIL = {
  REAL_YANDEX_SEARCH: true,
  YANDEX_SEARCH: true,
  REAL_GOOGLE_SEARCH: true,
  GOOGLE_SEARCH: true,
  REAL_WIKIPEDIA: true,
  WIKIPEDIA: true,
  REAL_SEARCH_SURFACES: true,
  SEARCH_SURFACES: true,
  AI_PROFILE: true,
  COMPLIANCE_DATABASE: true,
  RISK_CLASSIFIER_V1: true,
  RISK_CLASSIFIER: true,
  AUDIT_SUMMARY_BUILDER: true,
} as const;

function provider(id: string, status: ReportProviderDiagnosticItem["status"], runtime: ReportProviderDiagnosticItem["runtimeMode"], risk: ReportProviderDiagnosticItem["risk"]): ReportProviderDiagnosticItem {
  return {
    id,
    label: id,
    category: "pipeline",
    status,
    runtimeMode: runtime,
    reachesReport: true,
    clientVisible: true,
    risk,
    message: "fixture",
  };
}

function main() {
  const legacy = resolveRuntimeStrategy({
    mode: "legacy_mock_first",
    requestedBy: "test",
    availabilityOverride: AVAIL,
  });
  check(
    "legacy_mock_first keeps mock order",
    legacy.selectedOrder.join(",").startsWith("YANDEX_SEARCH,GOOGLE_SEARCH,WIKIPEDIA,AI_PROFILE,COMPLIANCE_DATABASE,RISK_CLASSIFIER"),
    legacy.selectedOrder.join(",")
  );

  const realFirst = resolveRuntimeStrategy({
    mode: "real_first_with_fallback",
    requestedBy: "test",
    availabilityOverride: AVAIL,
  });
  check(
    "real_first_with_fallback prefers real",
    realFirst.selectedOrder.includes("REAL_GOOGLE_SEARCH") && !realFirst.selectedOrder.includes("GOOGLE_SEARCH"),
    realFirst.selectedOrder.join(",")
  );

  const realMissing = resolveRuntimeStrategy({
    mode: "real_first_with_fallback",
    requestedBy: "test",
    availabilityOverride: { ...AVAIL, REAL_GOOGLE_SEARCH: false, GOOGLE_SEARCH: true },
  });
  check(
    "real_first_with_fallback records fallback",
    realMissing.fallbackEvents.some((e) => e.providerId === "google" && e.to === "mock"),
    JSON.stringify(realMissing.fallbackEvents)
  );

  const realOnly = resolveRuntimeStrategy({
    mode: "real_only",
    requestedBy: "test",
    availabilityOverride: { ...AVAIL, REAL_GOOGLE_SEARCH: false, GOOGLE_SEARCH: true },
  });
  check(
    "real_only never selects mock fallback",
    !realOnly.selectedOrder.includes("GOOGLE_SEARCH"),
    realOnly.selectedOrder.join(",")
  );

  const mockOnly = resolveRuntimeStrategy({
    mode: "mock_only",
    requestedBy: "test",
    availabilityOverride: AVAIL,
  });
  check(
    "mock_only never selects real provider",
    !mockOnly.selectedOrder.some((a) => a.startsWith("REAL_")),
    mockOnly.selectedOrder.join(",")
  );

  const providers = [
    provider("yandex", "ready", "real", "low"),
    provider("google", "fallback", "mixed", "medium"),
    provider("wikipedia", "ready", "real", "low"),
    provider("compliance", "stub", "manual", "high"),
  ];
  const diag = buildProviderDiagnosticsFixture({
    auditMode: { fullAuditOrderMode: "mixed", isMockDefault: false, notes: [] },
    runtimeStrategy: {
      mode: "real_first_with_fallback",
      selectedOrder: ["REAL_YANDEX_SEARCH", "GOOGLE_SEARCH"],
      fallbackPolicy: "allow_mock_fallback",
      requestedBy: "test",
      realProvidersAvailable: 2,
      mockProvidersAvailable: 2,
      fallbackEvents: [{ providerId: "google", reason: "missing config", from: "real", to: "mock" }],
      warnings: ["google real unavailable"],
    },
    providers,
  });
  const summary = summarizeProviderDiagnostics(providers);
  check("diagnostics summary ready count", diag.summary.readyCount === 2, JSON.stringify(diag.summary));
  check("diagnostics summary mock/stub count", summary.mockOrStubCount === 1, JSON.stringify(summary));
  check("diagnostics summary high-risk count", summary.highRiskCount === 1, JSON.stringify(summary));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
