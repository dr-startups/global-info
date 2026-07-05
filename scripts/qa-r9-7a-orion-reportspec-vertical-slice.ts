import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  hasEnglishStatusLabelsInRuOutput,
  scanReportSpecForEnglishStatus,
  scanReportSpecObject,
} from "../src/modules/digital-profile/orion-report-spec/client-policy-scan";
import { validateOrionReportSpecV1 } from "../src/modules/digital-profile/orion-report-spec/report-spec-schema";
import { runOrionReportSpecVerticalSlice } from "../src/modules/digital-profile/orion-report-spec/run-orion-reportspec-vertical-slice";
import { describeOrionV2AiReadiness } from "../src/modules/digital-profile/config";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  check("orion-report-spec module exists", existsSync(join(process.cwd(), "src/modules/digital-profile/orion-report-spec/normalized-evidence.ts")));
  check("section-evidence-adapter exists", existsSync(join(process.cwd(), "src/modules/digital-profile/orion-report-spec/section-evidence-adapter.ts")));
  check("asset-builder exists", existsSync(join(process.cwd(), "src/modules/digital-profile/orion-report-spec/asset-builder.ts")));
  check("gpt-section-analyzer exists", existsSync(join(process.cwd(), "src/modules/digital-profile/orion-report-spec/gpt-section-analyzer.ts")));
  check("renderer endpoint exists", readFileSync(join(process.cwd(), "renderer/app.py"), "utf-8").includes("/orion/render-report-spec"));

  const readiness = describeOrionV2AiReadiness();
  const requireAiForRun = readiness.ready;
  const out = join(process.cwd(), "storage", "digital-profile", "qa-r9-7a-orion-reportspec-vertical-slice");
  const result = await runOrionReportSpecVerticalSlice({
    outputRoot: out,
    useRealCaseData: false,
    requireAi: requireAiForRun,
    allowDeterministicFallback: !requireAiForRun,
  });

  const spec = validateOrionReportSpecV1(result.reportSpec);
  check("1. ReportSpec JSON schema valid", true);
  check("2. Executive Summary exists", spec.sections.some((s) => s.sectionKey === "executive_summary"));
  check("3. RU 2.1 exists", spec.sections.some((s) => s.sectionKey === "ru_audit_summary"));
  check("4. RU 2.2 exists", spec.sections.some((s) => s.sectionKey === "ru_search_results"));

  if (requireAiForRun) {
    check("5. GPT section analysis used", result.generatedBy === "gpt-5.5" || result.generatedBy === "mixed", result.generatedBy);
  } else {
    check("5. GPT skipped (AI unavailable) — deterministic acceptable", result.generatedBy === "deterministic");
  }

  const evidenceRefs = new Set(spec.evidence.map((e) => e.evidenceRef));
  const highlightRefs = spec.sections.flatMap((s) => s.evidenceHighlights.map((h) => h.evidenceRef));
  const slideRefs = spec.sections.flatMap((s) => s.slides.flatMap((sl) => sl.evidenceRefs ?? []));
  const missingRefs = [...highlightRefs, ...slideRefs].filter((r) => !evidenceRefs.has(r));
  check("6. EvidenceRefs used by analysis exist", missingRefs.length === 0, missingRefs.join(", "));

  const hasSearchRows = spec.evidence.some((e) => e.sourceKind === "search_result");
  const serpReady = spec.assets.some((a) => a.kind === "synthetic_serp" && a.status === "ready");
  check("7. Synthetic SERP when search rows exist", !hasSearchRows || serpReady);

  const policyIssues = scanReportSpecObject(spec);
  check("8. No forbidden terms in client ReportSpec", policyIssues.length === 0, policyIssues.join("; "));

  const specText = JSON.stringify(spec);
  check("9. No generic Поле/Значение tables", !/поле\s*\/\s*значение/i.test(specText));
  check("10. No Showing top X leakage", !/showing top \d+/i.test(specText));
  check("11. No English status labels in RU output", !scanReportSpecForEnglishStatus(spec));

  const pngDir = join(out, "target-pages-png");
  const pngs = existsSync(pngDir) ? readdirSync(pngDir).filter((f) => f.startsWith("page-") && f.endsWith(".png")) : [];
  check("12. Visual QA PNGs for target slides", pngs.length >= 3, String(pngs.length));

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
    "client-policy-inspection.json",
  ];
  for (const name of requiredArtifacts) {
    check(`artifact ${name}`, existsSync(join(out, name)));
  }

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
