import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness } from "../src/modules/digital-profile/config";
import {
  runOrionReportSpecVisualFidelitySlice,
  R97B_OUTPUT_ROOT,
} from "../src/modules/digital-profile/orion-report-spec/run-orion-reportspec-visual-fidelity";
import { validateOrionReportSpecV1 } from "../src/modules/digital-profile/orion-report-spec/report-spec-schema";
import {
  scanReportSpecObject,
  scanReportSpecForEnglishStatus,
} from "../src/modules/digital-profile/orion-report-spec/client-policy-scan";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const readiness = describeOrionV2AiReadiness();
  console.log(
    `[INFO] AI readiness: hasOpenAiKey=${readiness.hasOpenAiKey} aiEnabled=${readiness.aiEnabled} model=${readiness.model} requireAi=${readiness.requireAi}`
  );

  check("orion-serp-snapshot-builder exists", existsSync(join(process.cwd(), "src/modules/digital-profile/orion-report-spec/orion-serp-snapshot-builder.ts")));
  check("slide-composer exists", existsSync(join(process.cwd(), "src/modules/digital-profile/orion-report-spec/slide-composer.ts")));
  check("visual-quality-inspection exists", existsSync(join(process.cwd(), "src/modules/digital-profile/orion-report-spec/visual-quality-inspection.ts")));

  const result = await runOrionReportSpecVisualFidelitySlice();
  const out = result.outputRoot;

  const spec = validateOrionReportSpecV1(
    JSON.parse(readFileSync(join(out, "orion-report-spec-v1.json"), "utf-8"))
  );

  check("1. ReportSpec schema valid", true);
  check("2. Executive Summary section", spec.sections.some((s) => s.sectionKey === "executive_summary"));
  check("3. RU 2.1 section", spec.sections.some((s) => s.sectionKey === "ru_audit_summary"));
  check("4. RU 2.2 section", spec.sections.some((s) => s.sectionKey === "ru_search_results"));

  if (readiness.ready) {
    check("5. Live GPT-5.5 used for all sections", result.liveGptUsed, result.liveGptUsed ? "gpt-5.5" : result.blockedForLiveGpt ? "BLOCKED" : "mixed");
  } else {
    check("5. Live GPT blocked (no key or AI disabled)", result.blockedForLiveGpt);
    failures += 1;
    console.log("[FAIL] QA quality sign-off blocked — BLOCKED_FOR_LIVE_GPT");
  }

  const evidenceRefs = new Set(spec.evidence.map((e) => e.evidenceRef));
  const cited = spec.sections.flatMap((s) => [
    ...s.evidenceHighlights.map((h) => h.evidenceRef),
    ...s.slides.flatMap((sl) => sl.evidenceRefs ?? []),
  ]);
  const missing = cited.filter((r) => !evidenceRefs.has(r));
  check("6. GPT evidenceRefs valid", missing.length === 0, missing.join(", "));

  check("7. Yandex SERP asset ref", spec.assets.some((a) => a.assetRef === "ru_yandex_serp_snapshot" && a.status === "ready"));
  check("8. Google SERP asset ref", spec.assets.some((a) => a.assetRef === "ru_google_serp_snapshot" && a.status === "ready"));

  const policyIssues = scanReportSpecObject(spec);
  check("9. Client policy clean", policyIssues.length === 0, policyIssues.join("; "));
  check("10. No English status labels", !scanReportSpecForEnglishStatus(spec));

  const serpSlides = spec.sections.flatMap((s) => s.slides).filter((s) => s.template === "orion_serp_screenshot");
  check("11. SERP screenshot slides", serpSlides.length >= 2, String(serpSlides.length));

  check("12. Visual quality inspection", result.visualInspection.passed, `${result.visualInspection.score}/${result.visualInspection.maxScore}`);

  const requiredArtifacts = [
    "normalized-evidence.json",
    "report-assets.json",
    "executive-section-analysis.json",
    "ru-audit-section-analysis.json",
    "ru-search-section-analysis.json",
    "orion-report-spec-v1.json",
    "rendered-target-client.pdf",
    "rendered-target-client.pptx",
    "reportspec-inspection.json",
    "reportspec-visual-quality-inspection.json",
    "client-policy-inspection.json",
    "gpt-section-analysis-inspection.json",
    "synthetic-serp-inspection.json",
  ];
  for (const name of requiredArtifacts) {
    check(`artifact ${name}`, existsSync(join(out, name)));
  }

  const pngs = existsSync(join(out, "target-pages-png"))
    ? readdirSync(join(out, "target-pages-png")).filter((f) => f.endsWith(".png"))
    : [];
  check("Visual PNGs", pngs.length >= 5, String(pngs.length));

  if (result.blockedForLiveGpt) {
    console.log("\nVERDICT: BLOCKED_FOR_LIVE_GPT");
    process.exit(1);
  }

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
