import type { OrionQueryPlanBuildResult, OrionQuerySpec } from "./orion-query-plan";
import type {
  ReportProviderDiagnostics,
  ReportQueryPlanDiagnostics,
  ReportQueryPlanDiagnosticsRow,
} from "../types";

function countBy<T>(rows: T[], keyFn: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function fallbackEligibleCount(
  plan: OrionQuerySpec[],
  providerDiagnostics: ReportProviderDiagnostics | undefined
): number {
  if (!providerDiagnostics) return 0;
  const runtime = providerDiagnostics.runtimeStrategy;
  if (runtime.mode === "real_only") return 0;
  const rowsByProvider = countBy(plan, (row) => row.providerPreference[0] ?? "unknown");
  let total = 0;
  for (const evt of runtime.fallbackEvents) {
    total += rowsByProvider[evt.providerId] ?? 0;
  }
  return total;
}

export function buildQueryPlanDiagnostics(input: {
  details: OrionQueryPlanBuildResult;
  providerDiagnostics?: ReportProviderDiagnostics;
}): ReportQueryPlanDiagnostics {
  const { details } = input;
  const rows: ReportQueryPlanDiagnosticsRow[] = details.plan.map((q) => ({
    queryId: q.queryId,
    queryText: q.query,
    normalizedQuery: q.normalizedQuery,
    region: q.region,
    language: q.language,
    purpose: q.purpose,
    providerPreference: q.providerPreference,
    requiredTokens: q.requiredTokens,
    optionalTokens: q.optionalTokens,
    identityStrictness: q.identityStrictness,
    maxResultsHint: q.maxResultsHint,
    clientVisible: q.clientVisible,
    internalReason: q.internalReason,
  }));

  const providers = input.providerDiagnostics?.providers ?? [];
  const unavailableSet = new Set(
    providers
      .filter((p) => p.available === false || p.readinessStatus === "missing_config")
      .map((p) => p.id)
  );
  const providerUnavailableQueryCount = details.plan.filter((q) =>
    q.providerPreference.some((p) => unavailableSet.has(p))
  ).length;
  const warnings = Array.from(
    new Set([
      ...details.warnings,
      ...(providerUnavailableQueryCount > 0 ? ["provider_unavailable_for_some_queries"] : []),
      ...((input.providerDiagnostics?.runtimeStrategy.warnings ?? []).map((w) =>
        `runtime:${w}`
      )),
    ])
  );

  return {
    queryPlanId: details.queryPlanId,
    totalQueries: details.plan.length,
    byPurpose: countBy(details.plan, (q) => q.purpose),
    byProviderPreference: countBy(details.plan, (q) => q.providerPreference.join(">")),
    byRegion: countBy(details.plan, (q) => q.region),
    byLanguage: countBy(details.plan, (q) => q.language),
    byIdentityStrictness: countBy(details.plan, (q) => q.identityStrictness),
    weakQuerySuppressedCount: details.weakQuerySuppressedCount,
    transliterationVariantCount: details.transliterationVariantCount,
    regionHintCount: details.regionHintCount,
    providerUnavailableQueryCount,
    fallbackEligibleQueryCount: fallbackEligibleCount(details.plan, input.providerDiagnostics),
    warnings,
    queryRows: rows,
  };
}
