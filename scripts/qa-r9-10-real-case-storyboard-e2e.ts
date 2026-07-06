/**
 * R9.10 — Real CASE_ID client-quality E2E for ORION ClientStoryboard pipeline.
 * Loads AI keys from .env without overriding Docker-local DATABASE_URL.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

function bootstrapEnv(): void {
  if (process.env.R910_DOCKER_NETWORK === "1") {
    // Host .env.production often points at localhost; inside dp-app use compose service DNS.
    process.env.RENDERER_URL = "http://renderer:8080";
  } else {
    process.env.DATABASE_URL =
      process.env.R910_DATABASE_URL ??
      process.env.DATABASE_URL ??
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
      ...(process.env.R910_DOCKER_NETWORK === "1" ? ([] as const) : (["RENDERER_URL"] as const)),
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

async function resolveCaseId(): Promise<string | null> {
  const envCase = process.env.CASE_ID?.trim();
  if (envCase) return envCase;

  const { prisma } = await import("../src/server/prisma/client");
  const FIXTURE = ["ivan petrov", "иван петров", "example.com", "qa-r98a-fixture"];
  try {
    const rows = await prisma.case.findMany({
      where: { deletedAt: null, searchResults: { some: {} }, searchSurfaceItems: { some: {} } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        subjects: { take: 1, select: { fullName: true } },
        _count: { select: { searchResults: true } },
      },
    });
    for (const row of rows) {
      const name = (row.subjects[0]?.fullName ?? "").toLowerCase();
      if (FIXTURE.some((f) => name.includes(f) || row.id.includes(f))) continue;
      if (row._count.searchResults > 0) return row.id;
    }
  } finally {
    await prisma.$disconnect();
  }
  return null;
}

async function main() {
  const { describeOrionV2AiReadiness } = await import("../src/modules/digital-profile/config");
  const {
    OpenAiRateLimitError,
    R910_OUTPUT_ROOT,
    runR910RealCaseStoryboardE2e,
  } = await import("../src/modules/digital-profile/orion-client-storyboard/run-r910-real-case-storyboard-e2e");

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

  const caseId = await resolveCaseId();
  if (!caseId) {
    console.log("\nVERDICT: BLOCKED_REAL_CASE_REQUIRED");
    process.exit(1);
  }
  console.log(`[INFO] CASE_ID=${caseId}`);

  try {
    const result = await runR910RealCaseStoryboardE2e({
      caseId,
      outputRoot: R910_OUTPUT_ROOT,
    });

    const out = result.outputRoot;
    const required = [
      "real-case-data-inspection.json",
      "normalized-evidence.json",
      "report-assets.json",
      "gpt-section-analyses.json",
      "client-storyboard.json",
      "rendered-client.pdf",
      "rendered-client.pptx",
      "serp-visual-inspection.json",
      "media-visual-inspection.json",
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
    check("Real case inspection", result.realCaseInspection.passed);
    check("GPT generatedBy gpt-5.5", result.generatedBy === "gpt-5.5", result.generatedBy);
    check("PDF export libreoffice", result.pdfExportMode === "libreoffice", result.pdfExportMode);

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
