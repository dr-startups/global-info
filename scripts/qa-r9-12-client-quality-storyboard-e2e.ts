/**
 * R9.12 — Client-quality storyboard E2E (Docker-network compatible).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

function bootstrapEnv(): void {
  if (process.env.R912_DOCKER_NETWORK === "1" || process.env.R911_DOCKER_NETWORK === "1" || process.env.R910_DOCKER_NETWORK === "1") {
    process.env.RENDERER_URL = "http://renderer:8080";
  } else {
    process.env.DATABASE_URL ??=
      process.env.R912_DATABASE_URL ??
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
      "DIGITAL_PROFILE_AI_ANALYST_PROVIDER",
      "DIGITAL_PROFILE_ORION_V2_REQUIRE_AI",
      ...(process.env.R912_DOCKER_NETWORK === "1" ? ([] as const) : (["RENDERER_URL"] as const)),
    ] as const) {
      if (parsed[key] && !process.env[key]) {
        process.env[key] = parsed[key];
      }
    }
  }
  process.env.DIGITAL_PROFILE_AI_ANALYST_ENABLED ??= "true";
  process.env.DIGITAL_PROFILE_ORION_V2_REQUIRE_AI ??= "true";
}

bootstrapEnv();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const { describeOrionV2AiReadiness } = await import("../src/modules/digital-profile/config");
  const { OpenAiRateLimitError } = await import("../src/modules/digital-profile/orion-report-spec/openai-rate-limit");
  const { R912_OUTPUT_ROOT, runR912ClientQualityStoryboardE2e, buildPageReviewSummary } = await import(
    "../src/modules/digital-profile/orion-client-storyboard/run-r912-real-case-storyboard-e2e"
  );

  const readiness = describeOrionV2AiReadiness();
  console.log(
    `[INFO] AI readiness: hasOpenAiKey=${readiness.hasOpenAiKey} aiEnabled=${readiness.aiEnabled} model=${readiness.model}`
  );

  const rendererBase = (process.env.RENDERER_URL ?? "http://localhost:8080").replace(/\/$/, "");
  try {
    const rendererHealth = await fetch(`${rendererBase}/health`);
    const rendererJson = (await rendererHealth.json()) as { ok?: boolean; libreOfficeAvailable?: boolean };
    check("Renderer health", rendererHealth.ok && rendererJson.ok === true);
    check("LibreOffice in renderer", rendererJson.libreOfficeAvailable === true);
  } catch {
    check("Renderer health", false, `${rendererBase} unreachable`);
  }

  const caseId = process.env.CASE_ID?.trim() || "cmr5oqxo301bqvdag2yf0v6sj";
  console.log(`[INFO] CASE_ID=${caseId}`);

  try {
    const result = await runR912ClientQualityStoryboardE2e({ caseId, outputRoot: R912_OUTPUT_ROOT });
    buildPageReviewSummary(result.outputRoot);

    const out = result.outputRoot;
    const required = [
      "r911-client-quality-audit.json",
      "rendered-client.pdf",
      "rendered-client.pptx",
      "client-storyboard.json",
      "report-assets.json",
      "gpt-section-analyses.json",
      "evidence-relevance-inspection.json",
      "client-quality-inspection.json",
      "client-policy-inspection.json",
      "visual-quality-inspection.json",
      "lexis-visual-inspection.json",
      "serp-visual-inspection.json",
      "page-review-summary.json",
      "qa-summary.json",
    ];
    for (const name of required) {
      check(`artifact ${name}`, existsSync(join(out, name)));
    }

    const pngs = existsSync(join(out, "pages-png"))
      ? readdirSync(join(out, "pages-png")).filter((f) => f.endsWith(".png"))
      : [];
    check("PNG pages", pngs.length >= 18, String(pngs.length));

    const cq = JSON.parse(readFileSync(join(out, "client-quality-inspection.json"), "utf-8"));
    check("Client-quality inspection", cq.passed, cq.verdict);
    check("GPT generatedBy gpt-5.5", result.generatedBy === "gpt-5.5", result.generatedBy);
    check("Page count 18-32", result.pageCount >= 18 && result.pageCount <= 32, String(result.pageCount));

    console.log(`\nVERDICT: ${result.verdict}`);
    process.exit(result.verdict === "PASS" && failures === 0 ? 0 : 1);
  } catch (error) {
    if (error instanceof OpenAiRateLimitError) {
      console.log("\nVERDICT: BLOCKED_OPENAI_RATE_LIMIT");
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
