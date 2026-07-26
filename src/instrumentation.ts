/**
 * Next.js instrumentation hook (Stage M3).
 *
 * Runs once at server startup. Validates the Digital Profile environment:
 * warnings in development, fail-fast on critical problems in production. Only
 * runs in the Node.js runtime (skips the Edge runtime). Never logs secrets.
 *
 * Возобновление прогонов после деплоя живёт в воркере (`workflow/deploy-resume.ts`)
 * и не здесь: импорты `node:` и Playwright ломают `next build`, если тянуть их
 * в этот граф, — но главное, что веб-процессу эта работа не принадлежит.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runEnvValidation } = await import(
    "./modules/digital-profile/config/env-validation"
  );
  runEnvValidation();
}
