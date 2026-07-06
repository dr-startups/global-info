import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness } from "../src/modules/digital-profile/config";
import { runR98aLegacyVisualGpt, R98A_OUTPUT_ROOT } from "../src/modules/digital-profile/orion-report-spec/run-r98a-legacy-visual-gpt";
import { OpenAiRateLimitError } from "../src/modules/digital-profile/orion-report-spec/openai-rate-limit";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const readiness = describeOrionV2AiReadiness();
  console.log(
    `[INFO] AI readiness: hasOpenAiKey=${readiness.hasOpenAiKey} aiEnabled=${readiness.aiEnabled} model=${readiness.model}`
  );

  try {
    const result = await runR98aLegacyVisualGpt({
      outputRoot: R98A_OUTPUT_ROOT,
      requireGpt: readiness.ready,
      allowDeterministicFallback: !readiness.ready,
    });

    const out = result.outputRoot;
    const required = [
      "legacy-report-json-before-gpt.json",
      "gpt-section-analyses.json",
      "legacy-report-json-after-gpt.json",
      "rendered-client.pdf",
      "rendered-client.pptx",
      "visual-export-inspection.json",
      "serp-visual-inspection.json",
      "image-video-knowledge-inspection.json",
      "client-policy-inspection.json",
      "qa-summary.json",
    ];
    for (const name of required) {
      check(`artifact ${name}`, existsSync(join(out, name)));
    }

    const pngs = existsSync(join(out, "pages-png"))
      ? readdirSync(join(out, "pages-png")).filter((f) => f.endsWith(".png"))
      : [];
    check("PNG pages", pngs.length >= 10, String(pngs.length));

    check("1. GPT generatedBy for live sign-off", !readiness.ready || result.generatedBy === "gpt-5.5", result.generatedBy);
    check("2. Legacy visual renderer used", result.visualInspection.legacyRendererUsed);
    check("3. PDF size > 0", result.visualInspection.pdfSizeBytes > 0, String(result.visualInspection.pdfSizeBytes));
    check("4. PPTX size > 0", result.visualInspection.pptxSizeBytes > 0, String(result.visualInspection.pptxSizeBytes));
    check("5. PDF SERP/images", result.visualInspection.pdfSerpHasImages);
    check("6. PPTX pictures", result.visualInspection.pptxHasPictures || result.visualInspection.pdfSerpHasImages);
    check("7. PDF not text-only fallback", result.pdfExportMode === "libreoffice", result.pdfExportMode);
    check("8. Client policy", result.visualInspection.checks.find((c) => c.id === "client-policy")?.passed === true);
    check("9. No blank visual deck", !result.visualInspection.blankVisualSlides);
    check("10. Visual QA overall", result.visualInspection.passed, JSON.stringify(result.visualInspection.checks.filter((c) => !c.passed).map((c) => c.id)));

    if (result.blockedRealCaseRequired && readiness.ready) {
      console.log("\nVERDICT: BLOCKED_REAL_CASE_REQUIRED (fixture used; client-quality sign-off needs real case)");
      process.exit(1);
    }

    if (result.visualInspection.pdfExportBlocked) {
      console.log("\nVERDICT: BLOCKED_VISUAL_EXPORT");
      process.exit(1);
    }

    if (readiness.ready && result.generatedBy !== "gpt-5.5") {
      console.log("\nVERDICT: BLOCKED (GPT required but not used)");
      process.exit(1);
    }

    console.log(`\nVERDICT: ${failures ? "BLOCKED" : "PASS"}`);
    process.exit(failures ? 1 : 0);
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
