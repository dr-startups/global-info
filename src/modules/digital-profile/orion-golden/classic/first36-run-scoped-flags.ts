/**
 * First36 run-scoped evidence flags.
 * Legacy case-wide SearchResult/SearchSurfaceItem fallback is OFF by default for CEO/production.
 */

export function isFirst36LegacyCasewideFallbackEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.ORION_FIRST36_LEGACY_CASEWIDE_FALLBACK === "1";
}

/** CEO / client production must not use case-wide SearchResult for KPI/tables. */
export function mustUseRunScopedSerpObservations(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (isFirst36LegacyCasewideFallbackEnabled(env)) return false;
  return (
    env.ORION_FIRST36_CEO_MODE === "1" ||
    env.ORION_CLASSIC_CLIENT_FINALIZE === "1" ||
    env.ORION_FIRST36_RUN_SCOPED === "1"
  );
}
