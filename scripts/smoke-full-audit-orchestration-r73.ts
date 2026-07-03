import {
  FULL_AUDIT_DEFAULT_RUNTIME_MODE,
  resolveRuntimeStrategy,
} from "../src/modules/digital-profile/agents/runtime-strategy";

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
  "REAL_ORION_SEARCH_PROFILE",
  "REAL_ORION_GOOGLE_SURFACES",
  "REAL_ORION_UAE_INTERNATIONAL",
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
  for (const name of ALL_AGENTS) map[name] = enabled.includes(name);
  return map;
}

function main() {
  check(
    "full audit default mode is real_first_with_fallback",
    FULL_AUDIT_DEFAULT_RUNTIME_MODE === "real_first_with_fallback"
  );

  const fullReady = resolveRuntimeStrategy({
    mode: "real_first_with_fallback",
    requestedBy: "test",
    availabilityOverride: override(ALL_AGENTS),
  });
  check(
    "real_first_with_fallback includes ORION/real/report steps",
    [
      "REAL_ORION_SEARCH_PROFILE",
      "REAL_ORION_UAE_INTERNATIONAL",
      "REAL_ORION_GOOGLE_SURFACES",
      "REAL_SEARCH_SURFACES",
      "RISK_CLASSIFIER_V1",
      "AUDIT_SUMMARY_BUILDER",
    ].every((agent) => fullReady.selectedOrder.includes(agent)),
    fullReady.selectedOrder.join(", ")
  );
  check(
    "real_first_with_fallback keeps mock-only enrichment steps",
    fullReady.selectedOrder.includes("AI_PROFILE") &&
      fullReady.selectedOrder.includes("COMPLIANCE_DATABASE")
  );

  const fallbackCase = resolveRuntimeStrategy({
    mode: "real_first_with_fallback",
    requestedBy: "test",
    availabilityOverride: override([
      "YANDEX_SEARCH",
      "GOOGLE_SEARCH",
      "WIKIPEDIA",
      "SEARCH_SURFACES",
      "AI_PROFILE",
      "COMPLIANCE_DATABASE",
      "RISK_CLASSIFIER",
    ]),
  });
  check(
    "real unavailable -> mock selected with fallback events",
    fallbackCase.fallbackEvents.some((evt) => evt.to === "mock") &&
      fallbackCase.decisions.some((d) => d.providerId === "yandex" && d.selectedAgent === "YANDEX_SEARCH")
  );
  check(
    "unconfigured real-only steps become unavailable decisions",
    fallbackCase.decisions.some((d) => d.providerId === "audit_summary" && d.status === "skipped_unavailable")
  );

  const legacy = resolveRuntimeStrategy({
    mode: "legacy_mock_first",
    requestedBy: "test",
    availabilityOverride: override(["YANDEX_SEARCH", "GOOGLE_SEARCH", "WIKIPEDIA", "AUDIT_SUMMARY_BUILDER"]),
  });
  check(
    "legacy_mock_first still prioritizes mock",
    legacy.decisions.some(
      (d) => d.providerId === "yandex" && d.selectedAgent === "YANDEX_SEARCH" && d.selectedRuntime === "mock"
    )
  );
  check(
    "legacy_mock_first can include real-only system steps",
    legacy.selectedOrder.includes("AUDIT_SUMMARY_BUILDER")
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
