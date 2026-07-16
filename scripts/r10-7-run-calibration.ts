/**
 * R10.7 — Real subject content calibration runner (brain-only).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

function bootstrapEnv(): void {
  if (process.env.R10_DOCKER_NETWORK === "1") {
    process.env.RENDERER_URL = "http://renderer:8080";
  } else {
    process.env.DATABASE_URL ??=
      process.env.R10_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/global_info?schema=public";
    process.env.RENDERER_URL ??= "http://localhost:8080";
  }
  const envPath = join(process.cwd(), ".env");
  const envProdPath = join(process.cwd(), ".env.production");
  const envSource = existsSync(envPath) ? envPath : existsSync(envProdPath) ? envProdPath : null;
  if (envSource) {
    const parsed = parse(readFileSync(envSource));
    for (const key of [
      "OPENAI_API_KEY",
      "DIGITAL_PROFILE_AI_ANALYST_ENABLED",
      "DIGITAL_PROFILE_AI_ANALYST_MODEL",
      "DIGITAL_PROFILE_ORION_GOLDEN_ENABLED",
    ] as const) {
      if (parsed[key] && !process.env[key]) process.env[key] = parsed[key];
    }
  }
  process.env.DIGITAL_PROFILE_AI_ANALYST_ENABLED ??= "true";
  process.env.DIGITAL_PROFILE_ORION_GOLDEN_ENABLED ??= "true";
  process.env.R10_CONTENT_BRAIN_ONLY ??= "1";
}

bootstrapEnv();

const OUTPUT_ROOT = join(process.cwd(), "storage", "digital-profile", "qa-r10-7-real-subject-calibration");
const CASE_ID = process.env.CASE_ID?.trim() || "cmqzz1vbr00d2vdrsrjsgie2g";

async function main() {
  const { describeOrionV2AiReadiness } = await import("../src/modules/digital-profile/config");
  const { runR10OrionGoldenE2e } = await import("../src/modules/digital-profile/orion-golden/run-r10-orion-golden-e2e");

  const readiness = describeOrionV2AiReadiness();
  console.log(`[INFO] CASE_ID=${CASE_ID}`);
  console.log(`[INFO] OUTPUT_ROOT=${OUTPUT_ROOT}`);
  console.log(
    `[INFO] AI readiness: hasOpenAiKey=${readiness.hasOpenAiKey} aiEnabled=${readiness.aiEnabled} model=${readiness.model}`
  );

  const result = await runR10OrionGoldenE2e({
    caseId: CASE_ID,
    outputRoot: OUTPUT_ROOT,
    requireAi: true,
  });
  console.log(`[INFO] verdict=${result.verdict} reportRunId=${result.reportRunId}`);
  process.exit(result.verdict === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
