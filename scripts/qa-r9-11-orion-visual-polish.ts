/**
 * R9.11 — Real CASE_ID visual polish run (Docker-network compatible bootstrap).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

function bootstrapEnv(): void {
  if (process.env.R911_DOCKER_NETWORK === "1" || process.env.R910_DOCKER_NETWORK === "1") {
    process.env.RENDERER_URL = "http://renderer:8080";
  } else {
    process.env.DATABASE_URL ??=
      process.env.R911_DATABASE_URL ??
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
      ...(process.env.R911_DOCKER_NETWORK === "1" || process.env.R910_DOCKER_NETWORK === "1"
        ? ([] as const)
        : (["RENDERER_URL"] as const)),
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
  const { R911_OUTPUT_ROOT, runR911OrionVisualPolish } = await import(
    "../src/modules/digital-profile/orion-client-storyboard/r911-visual-polish-inspection"
  );

  const readiness = describeOrionV2AiReadiness();
  console.log(
    `[INFO] AI readiness: hasOpenAiKey=${readiness.hasOpenAiKey} aiEnabled=${readiness.aiEnabled} model=${readiness.model}`
  );

  const rendererBase = (process.env.RENDERER_URL ?? "http://localhost:8080").replace(/\/$/, "");
  try {
    const rendererHealth = await fetch(`${rendererBase}/health`);
    const rendererJson = (await rendererHealth.json()) as {
      ok?: boolean;
      libreOfficeAvailable?: boolean;
    };
    check("Renderer health", rendererHealth.ok && rendererJson.ok === true);
    check("LibreOffice in renderer", rendererJson.libreOfficeAvailable === true);
  } catch {
    check("Renderer health", false, `${rendererBase} unreachable`);
  }

  const caseId = process.env.CASE_ID?.trim() || "cmr5oqxo301bqvdag2yf0v6sj";
  console.log(`[INFO] CASE_ID=${caseId}`);

  try {
    const result = await runR911OrionVisualPolish({ caseId, outputRoot: R911_OUTPUT_ROOT });
    const out = result.outputRoot;
    const required = [
      "r910b-visual-audit.json",
      "real-case-data-inspection.json",
      "normalized-evidence.json",
      "report-assets.json",
      "gpt-section-analyses.json",
      "client-storyboard.json",
      "rendered-client.pdf",
      "rendered-client.pptx",
      "r911-visual-polish-inspection.json",
      "serp-visual-inspection.json",
      "lexis-visual-inspection.json",
      "client-readability-inspection.json",
      "client-policy-inspection.json",
      "visual-quality-inspection.json",
      "qa-summary.json",
    ];
    for (const name of required) {
      check(`artifact ${name}`, existsSync(join(out, name)));
    }
    const pngs = existsSync(join(out, "pages-png"))
      ? readdirSync(join(out, "pages-png")).filter((f) => f.endsWith(".png"))
      : [];
    check("PNG pages", pngs.length >= 8, String(pngs.length));
    check("R911 polish inspection", result.polishInspection.passed);
    check("GPT generatedBy gpt-5.5", result.generatedBy === "gpt-5.5", result.generatedBy);
    check("PDF export libreoffice", result.pdfExportMode === "libreoffice", result.pdfExportMode);
    check("Density improved vs R9.10b", result.polishInspection.baselineComparison.densityImproved);

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
