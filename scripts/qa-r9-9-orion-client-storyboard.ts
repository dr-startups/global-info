import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness } from "../src/modules/digital-profile/config";
import { OpenAiRateLimitError } from "../src/modules/digital-profile/orion-report-spec/openai-rate-limit";
import {
  FORBIDDEN_CLIENT_LABELS,
  validateClientStoryboard,
  validateGptStoryboardSectionAnalysis,
} from "../src/modules/digital-profile/orion-client-storyboard/schema";
import {
  runR99OrionClientStoryboard,
  R99_OUTPUT_ROOT,
} from "../src/modules/digital-profile/orion-client-storyboard/run-r99-orion-client-storyboard";

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
    const result = await runR99OrionClientStoryboard({
      outputRoot: R99_OUTPUT_ROOT,
      requireGpt: readiness.ready,
      allowDeterministicFallback: !readiness.ready,
      caseId: process.env.CASE_ID?.trim(),
    });

    const out = result.outputRoot;
    const required = [
      "r98a-visual-failure-audit.json",
      "normalized-evidence.json",
      "report-assets.json",
      "gpt-section-analyses.json",
      "client-storyboard.json",
      "rendered-client.pdf",
      "rendered-client.pptx",
      "serp-visual-inspection.json",
      "media-visual-inspection.json",
      "client-text-policy-inspection.json",
      "visual-density-inspection.json",
      "qa-summary.json",
    ];
    for (const name of required) {
      check(`artifact ${name}`, existsSync(join(out, name)));
    }

    const pngs = existsSync(join(out, "pages-png"))
      ? readdirSync(join(out, "pages-png")).filter((f) => f.endsWith(".png"))
      : [];
    check("PNG pages exported", pngs.length >= 8, String(pngs.length));

    const storyboard = validateClientStoryboard(
      JSON.parse(readFileSync(join(out, "client-storyboard.json"), "utf-8"))
    );
    check("1. ClientStoryboard validates", storyboard.slides.length >= 8, String(storyboard.slides.length));

    const gptAnalyses = JSON.parse(readFileSync(join(out, "gpt-section-analyses.json"), "utf-8")) as unknown[];
    check("2. GPT section analyses present", gptAnalyses.length === 3, String(gptAnalyses.length));
    for (const raw of gptAnalyses) {
      const parsed = validateGptStoryboardSectionAnalysis(raw);
      check(`GPT mapped ${parsed.sectionKey}`, Boolean(parsed.executiveTakeaway && parsed.slidePlans.length > 0));
    }

    const clientText = readFileSync(join(out, "client-text-policy-inspection.json"), "utf-8");
    check("3. No raw keys in client text", !FORBIDDEN_CLIENT_LABELS.some((t) => clientText.toLowerCase().includes(t.toLowerCase())));

    const isRealCase = result.caseResolution.source !== "fixture";
    const fixtureInText = /ivan petrov|иван петров|example\.com/i.test(
      readFileSync(join(out, "client-storyboard.json"), "utf-8")
    );
    check("4. No fixture names in real-case mode", !isRealCase || !fixtureInText);

    const serp = JSON.parse(readFileSync(join(out, "serp-visual-inspection.json"), "utf-8")) as {
      passed: boolean;
      serpAssetsReady: number;
      pdfPagesWithSerpVisual: boolean;
      pptxHasSerpEmbed?: boolean;
    };
    check("5. SERP assets exist", serp.serpAssetsReady > 0 || storyboard.slides.every((s) => s.slideType !== "serp_screenshot"), String(serp.serpAssetsReady));
    check("6. SERP visual embedded", serp.passed, serp.pptxHasSerpEmbed ? "pptx-embed" : "pdf/png");

    const media = JSON.parse(readFileSync(join(out, "media-visual-inspection.json"), "utf-8")) as { passed: boolean };
    check("7. Image/video/knowledge visual or omitted", media.passed);

    const density = JSON.parse(readFileSync(join(out, "visual-density-inspection.json"), "utf-8")) as {
      sparseRunMax: number;
      emptyTakeawaySlides: number;
    };
    check("8. Empty regions compressed", density.sparseRunMax <= 5, `sparseRun=${density.sparseRunMax}`);
    check("9. No sparse run > 5", density.sparseRunMax <= 5);
    check("10. Each slide has takeaway", density.emptyTakeawaySlides === 0, String(density.emptyTakeawaySlides));

    const maxBulletsOk = storyboard.slides.every((s) => {
      const bullets =
        s.findings.length + s.recommendedActions.length + s.evidenceRefs.length;
      return bullets <= 12;
    });
    check("11. No long bullet overflow", maxBulletsOk);

    check("12. RU report (locale)", storyboard.subject.locale === "ru");

    check(
      "13. No placeholder domains in real-case mode",
      !isRealCase || !/example\.(com|ru)/i.test(readFileSync(join(out, "client-storyboard.json"), "utf-8"))
    );

    check("14. PDF and PPTX generated", result.visualInspection.pdfSizeBytes > 0 && result.visualInspection.pptxSizeBytes > 0);

    const pageMin = isRealCase ? 8 : 10;
    const pageMax = isRealCase ? 40 : 25;
    check(
      "15. Page count reasonable",
      result.pageCount >= pageMin && result.pageCount <= pageMax,
      String(result.pageCount)
    );

    check(
      "GPT generatedBy live",
      !readiness.ready || result.generatedBy === "gpt-5.5" || result.caseResolution.source === "fixture",
      result.generatedBy
    );
    check("Visual composer used", result.pdfExportMode !== "unknown", result.pdfExportMode);

    console.log(`\nVERDICT: ${result.verdict}`);
    if (result.verdict === "BLOCKED_REAL_CASE_REQUIRED") {
      console.log("(Fixture smoke OK — client-quality sign-off requires CASE_ID)");
      process.exit(failures > 0 ? 1 : 0);
    }
    process.exit(failures || result.verdict !== "PASS" ? 1 : 0);
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
