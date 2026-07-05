import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runOrionReportSpecVerticalSlice } from "../src/modules/digital-profile/orion-report-spec/run-orion-reportspec-vertical-slice";
import { validateOrionReportSpecV1 } from "../src/modules/digital-profile/orion-report-spec/report-spec-schema";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const out = join(process.cwd(), "storage", "digital-profile", "qa-r9-7a-orion-reportspec-vertical-slice");
  const result = await runOrionReportSpecVerticalSlice({
    outputRoot: out,
    useRealCaseData: false,
    requireAi: false,
    allowDeterministicFallback: true,
  });

  check("orion-report-spec-v1.json exists", existsSync(join(out, "orion-report-spec-v1.json")));
  check("normalized-evidence.json exists", existsSync(join(out, "normalized-evidence.json")));
  check("report-assets.json exists", existsSync(join(out, "report-assets.json")));
  check("executive-section-analysis.json exists", existsSync(join(out, "executive-section-analysis.json")));
  check("ru-audit-section-analysis.json exists", existsSync(join(out, "ru-audit-section-analysis.json")));
  check("ru-search-section-analysis.json exists", existsSync(join(out, "ru-search-section-analysis.json")));
  check("reportspec-inspection.json exists", existsSync(join(out, "reportspec-inspection.json")));
  check("client-policy-inspection.json exists", existsSync(join(out, "client-policy-inspection.json")));

  validateOrionReportSpecV1(result.reportSpec);
  check("ReportSpec schema valid", true);

  const keys = result.reportSpec.sections.map((s) => s.sectionKey);
  check("Executive Summary section exists", keys.includes("executive_summary"));
  check("RU 2.1 section exists", keys.includes("ru_audit_summary"));
  check("RU 2.2 section exists", keys.includes("ru_search_results"));

  const serpReady = result.reportSpec.assets.filter((a) => a.kind === "synthetic_serp" && a.status === "ready");
  check("Synthetic SERP assets ready when search rows exist", serpReady.length >= 1, String(serpReady.length));

  check("Client policy scan clean", result.policyIssues.length === 0, result.policyIssues.join("; "));

  const pngDir = join(out, "target-pages-png");
  const pngCount = existsSync(pngDir) ? readdirSync(pngDir).filter((f) => f.endsWith(".png")).length : 0;
  check("Visual QA PNGs generated", pngCount > 0, String(pngCount));
  check("Rendered PPTX exists", existsSync(join(out, "rendered-target-client.pptx")));

  if (result.renderWarning) {
    console.log(`[WARN] render: ${result.renderWarning}`);
  }

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
