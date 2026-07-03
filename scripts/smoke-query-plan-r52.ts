/**
 * R5.2 smoke — deterministic query planning and client-safe diagnostics.
 */
import {
  buildOrionQueryPlanDetailed,
  type OrionQuerySpec,
} from "../src/modules/digital-profile/search-surfaces/orion-query-plan";
import { buildQueryPlanDiagnostics } from "../src/modules/digital-profile/search-surfaces/query-plan-diagnostics";
import { buildProviderDiagnostics } from "../src/modules/digital-profile/report/provider-diagnostics";
import { resolveRuntimeStrategy } from "../src/modules/digital-profile/agents/runtime-strategy";
import {
  REPORT_CLIENT_SLIDE_COUNT,
  REPORT_INTERNAL_SLIDE_COUNT,
  sanitizeReportJsonForAudience,
} from "../src/modules/digital-profile/report/report-data-policy";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function hasPurpose(plan: OrionQuerySpec[], purpose: OrionQuerySpec["purpose"]): boolean {
  return plan.some((q) => q.purpose === purpose);
}

function main() {
  const subject = {
    fullName: "Томилин Константин Романович",
    aliases: ["Konstantin Romanovich Tomilin"],
    targetRegions: ["RU", "INTERNATIONAL", "UAE"],
    location: "Тверская область Осташков",
  };
  const p1 = buildOrionQueryPlanDetailed(subject, { includeRiskProbes: true });
  const p2 = buildOrionQueryPlanDetailed(subject, { includeRiskProbes: true });
  check("query plan is deterministic", JSON.stringify(p1.plan) === JSON.stringify(p2.plan));

  check(
    "RU exact full-FIO queries exist",
    p1.plan.some((q) => q.region === "RU" && q.purpose === "subject_lookup" && q.query.includes("Томилин"))
  );
  check(
    "RU weak patronymic-only queries are suppressed/absent",
    !p1.plan.some((q) => q.region === "RU" && /^романович$/i.test(q.normalizedQuery))
  );
  check(
    "INTL transliteration variants exist",
    p1.plan.some((q) => q.region !== "RU" && /konstantin/i.test(q.query) && /tomilin/i.test(q.query))
  );
  check(
    "INTL weak Romanovich-only not strict",
    !p1.plan.some((q) => /romanovich/i.test(q.query) && q.query.trim().split(/\s+/).length === 1 && q.identityStrictness === "strict")
  );

  check("query purposes include adverse", hasPurpose(p1.plan, "adverse_lookup"));
  check("query purposes include media/image/video", hasPurpose(p1.plan, "media_lookup") && hasPurpose(p1.plan, "image_lookup") && hasPurpose(p1.plan, "video_lookup"));
  check("query purposes include suggestion/related/wiki", hasPurpose(p1.plan, "suggestion_lookup") && hasPurpose(p1.plan, "related_lookup") && hasPurpose(p1.plan, "wikipedia_lookup"));

  const runtimeRealOnly = resolveRuntimeStrategy({
    mode: "real_only",
    requestedBy: "test",
    availabilityOverride: {
      REAL_YANDEX_SEARCH: true,
      REAL_GOOGLE_SEARCH: true,
      REAL_WIKIPEDIA: true,
      REAL_SEARCH_SURFACES: true,
      YANDEX_SEARCH: true,
      GOOGLE_SEARCH: true,
      WIKIPEDIA: true,
      SEARCH_SURFACES: true,
      RISK_CLASSIFIER_V1: true,
      AUDIT_SUMMARY_BUILDER: true,
      RISK_CLASSIFIER: true,
      AI_PROFILE: true,
      COMPLIANCE_DATABASE: true,
    },
  });
  check(
    "real_only does not assign mock fallback",
    runtimeRealOnly.steps.every((s) => s.primaryRuntime === "real")
  );

  const runtimeMockOnly = resolveRuntimeStrategy({
    mode: "mock_only",
    requestedBy: "test",
    availabilityOverride: {
      REAL_YANDEX_SEARCH: true,
      REAL_GOOGLE_SEARCH: true,
      REAL_WIKIPEDIA: true,
      REAL_SEARCH_SURFACES: true,
      YANDEX_SEARCH: true,
      GOOGLE_SEARCH: true,
      WIKIPEDIA: true,
      SEARCH_SURFACES: true,
      RISK_CLASSIFIER_V1: true,
      AUDIT_SUMMARY_BUILDER: true,
      RISK_CLASSIFIER: true,
      AI_PROFILE: true,
      COMPLIANCE_DATABASE: true,
    },
  });
  check(
    "mock_only does not assign real providers",
    runtimeMockOnly.steps.every((s) => s.primaryRuntime === "mock")
  );

  const providerDiagnostics = buildProviderDiagnostics({ mode: "real_first_with_fallback", requestedBy: "test" });
  const queryPlanDiagnostics = buildQueryPlanDiagnostics({
    details: p1,
    providerDiagnostics,
  });
  check("queryPlanDiagnostics exists internally", queryPlanDiagnostics.totalQueries > 0 && queryPlanDiagnostics.queryRows.length > 0);

  const internalJson = {
    queryPlanDiagnostics,
    providerReadinessSummary: providerDiagnostics.providerReadinessSummary,
    searchProvenanceSummary: { queryCount: 1, surfaceCount: 1, screenshotCount: 1, linkedEvidenceCount: 1 },
    providerDiagnostics,
  } as Record<string, unknown>;
  const clientJson = sanitizeReportJsonForAudience(internalJson, "client");
  const clientStr = JSON.stringify(clientJson);
  check("client strips queryPlanDiagnostics", !clientStr.includes("queryPlanDiagnostics"));
  check("client strips internal query fields", !clientStr.includes("internalReason") && !clientStr.includes("queryId"));
  check("R4.3 searchProvenanceSummary remains present", clientStr.includes("searchProvenanceSummary"));
  check("R5.1 providerReadinessSummary remains present", clientStr.includes("providerReadinessSummary"));

  check(
    "page count remains internal 73/client 72",
    REPORT_INTERNAL_SLIDE_COUNT === 73 && REPORT_CLIENT_SLIDE_COUNT === 72
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
