/**
 * Deterministic local checks for R3.2b provider diagnostics scenarios.
 *
 * Run:
 *   npx tsx scripts/smoke-provider-diagnostics-r32b.ts
 */

import {
  buildProviderDiagnosticsFixture,
  summarizeProviderDiagnostics,
} from "../src/modules/digital-profile/report/provider-diagnostics";
import type {
  ReportProviderDiagnosticItem,
  ReportProviderDiagnostics,
} from "../src/modules/digital-profile/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function p(
  id: string,
  status: ReportProviderDiagnosticItem["status"],
  runtimeMode: ReportProviderDiagnosticItem["runtimeMode"],
  risk: ReportProviderDiagnosticItem["risk"]
): ReportProviderDiagnosticItem {
  return {
    id,
    label: id,
    category: "pipeline",
    status,
    runtimeMode,
    reachesReport: true,
    clientVisible: true,
    risk,
    message: "fixture",
  };
}

function buildScenario(
  name: string,
  auditMode: ReportProviderDiagnostics["auditMode"]["fullAuditOrderMode"],
  providers: ReportProviderDiagnosticItem[]
) {
  const diag = buildProviderDiagnosticsFixture({
    auditMode: { fullAuditOrderMode: auditMode, isMockDefault: auditMode === "mock_first", notes: [] },
    providers,
  });
  check(`${name}: providers non-empty`, diag.providers.length > 0);
  check(`${name}: summary exists`, typeof diag.summary === "object");
  return diag;
}

function main() {
  const s1 = buildScenario("all disabled/not configured", "mock_first", [
    p("yandex", "not_configured", "real", "medium"),
    p("google", "not_configured", "real", "medium"),
    p("wikipedia", "not_configured", "real", "medium"),
    p("compliance", "stub", "manual", "high"),
  ]);
  check("scenario1 high risk >= 1", s1.summary.highRiskCount >= 1, JSON.stringify(s1.summary));

  const s2 = buildScenario("partial real configured", "mixed", [
    p("yandex", "ready", "real", "low"),
    p("google", "not_configured", "real", "medium"),
    p("serper", "configured", "mixed", "medium"),
    p("wikipedia", "ready", "real", "low"),
    p("compliance", "stub", "manual", "high"),
  ]);
  check("scenario2 ready count >= 2", s2.summary.readyCount >= 2, JSON.stringify(s2.summary));

  const s3Providers = [
    p("yandex", "ready", "real", "low"),
    p("google", "ready", "real", "low"),
    p("serper", "ready", "real", "low"),
    p("wikipedia", "ready", "real", "low"),
    p("compliance", "stub", "manual", "high"),
  ];
  const s3 = buildScenario("fully real search configured", "real_first", s3Providers);
  check("scenario3 real count >= 4", s3.summary.realCount >= 4, JSON.stringify(s3.summary));

  const s4 = buildScenario("mixed historical mock/real", "mixed", [
    p("yandex", "mock", "mock", "medium"),
    p("google", "ready", "real", "low"),
    p("serper", "fallback", "mixed", "medium"),
    p("wikipedia", "ready", "real", "low"),
    p("compliance", "stub", "manual", "high"),
  ]);
  check("scenario4 has mock/stub count", s4.summary.mockOrStubCount >= 1, JSON.stringify(s4.summary));

  const s5 = buildScenario("compliance stubs/manual path", "mock_first", [
    p("compliance", "stub", "manual", "high"),
    p("screenshots", "ready", "manual", "low"),
    p("synthetic_serp", "fallback", "synthetic", "medium"),
  ]);
  check("scenario5 compliance high risk", s5.summary.highRiskCount >= 1, JSON.stringify(s5.summary));

  const summary = summarizeProviderDiagnostics(s3Providers);
  check("summary helper deterministic", summary.readyCount === 4, JSON.stringify(summary));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
