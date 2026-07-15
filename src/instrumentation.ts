/**
 * Next.js instrumentation hook (Stage M3).
 *
 * Runs once at server startup. Validates the Digital Profile environment:
 * warnings in development, fail-fast on critical problems in production. Only
 * runs in the Node.js runtime (skips the Edge runtime). Never logs secrets.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runEnvValidation } = await import(
    "./modules/digital-profile/config/env-validation"
  );
  runEnvValidation();
  try {
    const { resumeActiveArsenkinOrchestrations } = await import(
      "./modules/digital-profile/providers/arsenkin/full-audit-orchestrator"
    );
    resumeActiveArsenkinOrchestrations();
  } catch {
    /* orchestrator resume is best-effort */
  }
}
