/**
 * R10 — ORION Golden real-case QA entrypoint.
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
      ...(process.env.R10_DOCKER_NETWORK === "1" ? ([] as const) : (["RENDERER_URL"] as const)),
    ] as const) {
      if (parsed[key] && !process.env[key]) process.env[key] = parsed[key];
    }
  }
  process.env.DIGITAL_PROFILE_AI_ANALYST_ENABLED ??= "true";
  process.env.DIGITAL_PROFILE_ORION_GOLDEN_ENABLED ??= "true";
}

bootstrapEnv();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const { describeOrionV2AiReadiness } = await import("../src/modules/digital-profile/config");
  const { runR10OrionGoldenE2e, R10_OUTPUT_ROOT } = await import(
    "../src/modules/digital-profile/orion-golden/run-r10-orion-golden-e2e"
  );

  const readiness = describeOrionV2AiReadiness();
  console.log(
    `[INFO] AI readiness: hasOpenAiKey=${readiness.hasOpenAiKey} aiEnabled=${readiness.aiEnabled} model=${readiness.model}`
  );

  const rendererBase = (process.env.RENDERER_URL ?? "http://localhost:8080").replace(/\/$/, "");
  try {
    const res = await fetch(`${rendererBase}/health`);
    const json = (await res.json()) as { ok?: boolean };
    check("Renderer health", res.ok && json.ok === true);
  } catch {
    check("Renderer health", false, `${rendererBase} unreachable — local Python fallback may apply`);
  }

  const caseId = process.env.CASE_ID?.trim() || "cmr5oqxo301bqvdag2yf0v6sj";
  const calibrationCaseId = "cmqzz1vbr00d2vdrsrjsgie2g";
  const outputRoot =
    process.env.R10_OUTPUT_DIR?.trim() ||
    (caseId === calibrationCaseId
      ? join(process.cwd(), "storage", "digital-profile", "qa-r10-7-real-subject-calibration")
      : R10_OUTPUT_ROOT);
  console.log(`[INFO] CASE_ID=${caseId}`);
  console.log(`[INFO] OUTPUT_ROOT=${outputRoot}`);

  const result = await runR10OrionGoldenE2e({ caseId, outputRoot, requireAi: true });
  console.log(`[INFO] verdict=${result.verdict} pages=${result.pageCount} slides=${result.slideCount}`);

  const contentBrainOnly = process.env.R10_CONTENT_BRAIN_ONLY === "1";

  const requiredArtifacts = contentBrainOnly
    ? [
        "full-evidence-inventory.json",
        "relevance-filter-inspection.json",
        "evidence-judgment-inspection.json",
        "evidence-routing-inspection.json",
        "r10-4-evidence-bundles.json",
        "manual-review-queue.json",
        "admin-review-decisions.json",
        "admin-review-decisions.sample.json",
        "orion-client-content.pre-review.json",
        "orion-client-content.pre-review.md",
        "orion-client-content.post-review.json",
        "orion-client-content.post-review.md",
        "r10-5-admin-review-workflow-qa.json",
        "section-bundles/index.json",
        "section-analyses/index.json",
        "executive-synthesis.input.json",
        "executive-synthesis.output.json",
        "risk-matrix.section-derived.json",
        "r10-6-section-gpt-orchestration-qa.json",
        "r10-6-gpt-runtime-diagnostics.json",
        "orion-client-content.json",
        "orion-client-content.md",
        "r10-4-evidence-judgment-review.json",
        "r10-4-content-quality-review.json",
        "gpt-section-analyses.json",
        "executive-synthesis.json",
        "subject-identity-profile.json",
        "r10-7b-subject-binding-qa.json",
        "r10-7b-subject-binding-report.json",
        "qa-summary.json",
      ]
    : [
        "architecture-inspection.json",
        "orion-blueprint.json",
        "supabase-schema-plan.json",
        "full-evidence-inventory.json",
        "evidence-routing-inspection.json",
        "relevance-filter-inspection.json",
        "evidence-judgment-inspection.json",
        "r10-4-evidence-bundles.json",
        "manual-review-queue.json",
        "admin-review-decisions.json",
        "admin-review-decisions.sample.json",
        "orion-client-content.pre-review.json",
        "orion-client-content.pre-review.md",
        "orion-client-content.post-review.json",
        "orion-client-content.post-review.md",
        "r10-5-admin-review-workflow-qa.json",
        "orion-client-content.json",
        "orion-client-content.md",
        "r10-4-evidence-judgment-review.json",
        "r10-4-content-quality-review.json",
        "gpt-section-analyses.json",
        "executive-synthesis.json",
        "orion-report-spec.json",
        "report-assets.json",
        "final-deck-manifest.json",
        "visual-qa-inspection.json",
        "client-policy-inspection.json",
        "qa-summary.json",
      ];

  for (const name of requiredArtifacts) {
    check(`Artifact: ${name}`, existsSync(join(outputRoot, name)));
  }

  if (result.verdict !== "BLOCKED_GPT" && result.verdict !== "BLOCKED" && process.env.R10_CONTENT_BRAIN_ONLY !== "1") {
    check("rendered-client.pdf", existsSync(join(outputRoot, "rendered-client.pdf")));
    check("rendered-client.pptx", existsSync(join(outputRoot, "rendered-client.pptx")));
  }

  const judgmentReview = JSON.parse(
    readFileSync(join(outputRoot, "r10-4-evidence-judgment-review.json"), "utf-8")
  ) as { verdict: string; passed: boolean };
  check("Evidence judgment QA", judgmentReview.passed, judgmentReview.verdict);

  const adminWorkflow = JSON.parse(
    readFileSync(join(outputRoot, "r10-5-admin-review-workflow-qa.json"), "utf-8")
  ) as { verdict: string; passed: boolean };
  check("Admin review workflow QA", adminWorkflow.passed, adminWorkflow.verdict);

  const contentQuality = JSON.parse(
    readFileSync(join(outputRoot, "r10-4-content-quality-review.json"), "utf-8")
  ) as { verdict: string };
  console.log(`[INFO] contentQuality=${contentQuality.verdict}`);
  console.log(`[INFO] adminWorkflow=${adminWorkflow.verdict}`);

  if (existsSync(join(outputRoot, "r10-6-section-gpt-orchestration-qa.json"))) {
    const sectionOrchestration = JSON.parse(
      readFileSync(join(outputRoot, "r10-6-section-gpt-orchestration-qa.json"), "utf-8")
    ) as { verdict: string; passed: boolean };
    check("Section GPT orchestration QA", sectionOrchestration.passed, sectionOrchestration.verdict);
    console.log(`[INFO] sectionOrchestration=${sectionOrchestration.verdict}`);
  }

  if (existsSync(join(outputRoot, "r10-6-gpt-runtime-diagnostics.json"))) {
    const gptRuntime = JSON.parse(
      readFileSync(join(outputRoot, "r10-6-gpt-runtime-diagnostics.json"), "utf-8")
    ) as { successfulCalls: number; failedCalls: number; fallbackCount: number };
    check(
      "GPT runtime diagnostics",
      gptRuntime.successfulCalls > 0 && gptRuntime.failedCalls === 0,
      `successful=${gptRuntime.successfulCalls} failed=${gptRuntime.failedCalls} fallback=${gptRuntime.fallbackCount}`
    );
    console.log(
      `[INFO] gptRuntime successful=${gptRuntime.successfulCalls} failed=${gptRuntime.failedCalls} fallback=${gptRuntime.fallbackCount}`
    );
  }

  if (existsSync(join(outputRoot, "r10-7b-subject-binding-qa.json"))) {
    const bindingQa = JSON.parse(
      readFileSync(join(outputRoot, "r10-7b-subject-binding-qa.json"), "utf-8")
    ) as { verdict: string; passed: boolean };
    check("Subject binding QA", bindingQa.passed, bindingQa.verdict);
    console.log(`[INFO] subjectBindingQa=${bindingQa.verdict}`);
  }

  const qa = JSON.parse(readFileSync(join(outputRoot, "qa-summary.json"), "utf-8")) as {
    verdict: string;
    executiveAfterSections?: boolean;
    blockedReason?: string;
  };
  if (qa.executiveAfterSections != null) {
    check("Executive after sections", qa.executiveAfterSections === true);
  }
  check(
    "Final verdict acceptable",
    ["PASS", "BLOCKED_GPT", "BLOCKED_VISUAL", "BLOCKED_CLIENT_TEXT", "BLOCKED"].includes(qa.verdict)
  );

  if (result.verdict === "PASS") {
    check("QA PASS", failures === 0);
  } else {
    console.log(`[INFO] Run blocked with verdict=${result.verdict}`);
  }

  process.exit(
    result.verdict === "PASS" && failures === 0
      ? 0
      : result.verdict === "BLOCKED_GPT"
        ? 2
        : result.verdict === "BLOCKED"
          ? 3
          : 1
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
