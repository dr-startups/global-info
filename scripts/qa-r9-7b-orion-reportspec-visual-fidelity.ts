import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness } from "../src/modules/digital-profile/config";
import {
  runOrionReportSpecGptQa,
  OpenAiRateLimitError,
  TARGET_SECTIONS,
  SECTION_ANALYSIS_FILES,
  type ReportSpecGptQaOptions,
} from "../src/modules/digital-profile/orion-report-spec/run-orion-reportspec-gpt-qa";
import {
  runOrionReportSpecVisualFidelitySlice,
  R97B_OUTPUT_ROOT,
} from "../src/modules/digital-profile/orion-report-spec/run-orion-reportspec-visual-fidelity";
import { validateOrionReportSpecV1 } from "../src/modules/digital-profile/orion-report-spec/report-spec-schema";
import type { OrionReportSectionKey } from "../src/modules/digital-profile/orion-report-spec/report-spec-schema";
import {
  scanReportSpecObject,
  scanReportSpecForEnglishStatus,
} from "../src/modules/digital-profile/orion-report-spec/client-policy-scan";

const VALID_SECTIONS = new Set<string>(TARGET_SECTIONS);

export interface QaCliOptions {
  section?: OrionReportSectionKey;
  resume: boolean;
  delayMs: number;
  maxOpenaiRetries: number;
  incremental: boolean;
}

export function parseQaCliArgs(argv: string[] = process.argv): QaCliOptions {
  let section: OrionReportSectionKey | undefined;
  let resume = false;
  let delayMs = 120_000;
  let maxOpenaiRetries = 6;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--section" && argv[i + 1]) {
      const val = argv[++i]!;
      if (!VALID_SECTIONS.has(val)) {
        throw new Error(`invalid-section:${val}`);
      }
      section = val as OrionReportSectionKey;
    } else if (arg === "--resume") {
      resume = true;
    } else if (arg === "--delay-ms" && argv[i + 1]) {
      delayMs = Number(argv[++i]);
    } else if (arg === "--max-openai-retries" && argv[i + 1]) {
      maxOpenaiRetries = Number(argv[++i]);
    }
  }

  const incremental = Boolean(section || resume);
  return { section, resume, delayMs, maxOpenaiRetries, incremental };
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function runIncrementalQa(cli: QaCliOptions) {
  const readiness = describeOrionV2AiReadiness();
  console.log(
    `[INFO] AI readiness: hasOpenAiKey=${readiness.hasOpenAiKey} aiEnabled=${readiness.aiEnabled} model=${readiness.model} requireAi=${readiness.requireAi}`
  );
  console.log(
    `[INFO] GPT QA mode: ${cli.section ? `section=${cli.section}` : cli.resume ? "resume" : "full"} delayMs=${cli.delayMs} maxRetries=${cli.maxOpenaiRetries}`
  );

  if (!readiness.ready) {
    if (!readiness.hasOpenAiKey) {
      console.log("\nVERDICT: BLOCKED_FOR_MISSING_OPENAI_KEY");
      process.exit(1);
    }
    console.log("\nVERDICT: BLOCKED_FOR_AI_DISABLED");
    process.exit(1);
  }

  const gptOptions: ReportSpecGptQaOptions = {
    outputRoot: R97B_OUTPUT_ROOT,
    section: cli.section,
    resume: cli.resume,
    delayMs: cli.delayMs,
    maxOpenaiRetries: cli.maxOpenaiRetries,
  };

  const result = await runOrionReportSpecGptQa(gptOptions);
  const out = result.outputRoot;

  for (const key of TARGET_SECTIONS) {
    check(
      `section ${key} artifact`,
      existsSync(join(out, SECTION_ANALYSIS_FILES[key])),
      result.sectionStatus[key]
    );
    check(`section ${key} generatedBy=gpt-5.5`, result.sectionStatus[key] === "gpt-5.5", result.sectionStatus[key]);
  }

  if (cli.section) {
    check("single-section mode completed", result.sectionsRun.includes(cli.section));
    console.log(`[INFO] Sections run this invocation: ${result.sectionsRun.join(", ") || "none"}`);
    if (!result.allSectionsGpt) {
      console.log("[INFO] Compose/render deferred until all 3 sections are gpt-5.5 (use --resume).");
    }
  }

  if (result.allSectionsGpt) {
    check("all sections gpt-5.5", true);
    check("ReportSpec composed", result.composed);
    check("PDF/PPTX rendered", result.rendered);
    if (result.reportSpec) {
      validateOrionReportSpecV1(result.reportSpec);
      check("ReportSpec schema valid", true);
      check("Client policy clean", scanReportSpecObject(result.reportSpec).length === 0);
      check("No English status labels", !scanReportSpecForEnglishStatus(result.reportSpec));
    }
    check(
      "Visual quality inspection",
      result.visualInspection?.passed === true,
      `${result.visualInspection?.score ?? 0}/${result.visualInspection?.maxScore ?? 0}`
    );
  }

  if (result.blockedForLiveGpt && !cli.section) {
    console.log("\nVERDICT: BLOCKED_FOR_LIVE_GPT (incomplete GPT sections)");
    process.exit(1);
  }

  if (result.allSectionsGpt) {
    console.log("\nVERDICT: PASS");
    process.exit(failures ? 1 : 0);
  }

  console.log(`\nPARTIAL: ${result.sectionsRun.length} section(s) completed this run. Re-run with --resume when ready.`);
  process.exit(failures ? 1 : 0);
}

async function runLegacyFullQa() {
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
    check("5. Live GPT-5.5 used for all sections", result.liveGptUsed, result.liveGptUsed ? "gpt-5.5" : "BLOCKED");
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

async function main() {
  const cli = parseQaCliArgs();
  try {
    if (cli.incremental) {
      await runIncrementalQa(cli);
    } else {
      await runLegacyFullQa();
    }
  } catch (error) {
    if (error instanceof OpenAiRateLimitError) {
      console.error("[FAIL] OpenAI rate limit (HTTP 429) — stop and retry later with --section or --resume");
      console.log("\nVERDICT: BLOCKED_OPENAI_RATE_LIMIT");
      process.exit(1);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
