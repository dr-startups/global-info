import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runOrionReportSpecVisualFidelitySlice } from "../src/modules/digital-profile/orion-report-spec/run-orion-reportspec-visual-fidelity";
import { validateOrionReportSpecV1 } from "../src/modules/digital-profile/orion-report-spec/report-spec-schema";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const result = await runOrionReportSpecVisualFidelitySlice();
  const out = result.outputRoot;

  check("orion-report-spec-v1.json exists", existsSync(join(out, "orion-report-spec-v1.json")));
  check("visual quality inspection exists", existsSync(join(out, "reportspec-visual-quality-inspection.json")));
  check("synthetic SERP inspection exists", existsSync(join(out, "synthetic-serp-inspection.json")));

  const spec = validateOrionReportSpecV1(
    JSON.parse(readFileSync(join(out, "orion-report-spec-v1.json"), "utf-8"))
  );
  check("ReportSpec schema valid", true);
  check("Synthetic SERP assets use new refs", spec.assets.some((a) => a.assetRef === "ru_yandex_serp_snapshot"));
  check("Visual QA score", result.visualInspection.passed, `${result.visualInspection.score}/${result.visualInspection.maxScore}`);
  check("Page count >= 3", result.pageCount >= 3, String(result.pageCount));

  const pngs = readdirSync(join(out, "target-pages-png")).filter((f) => f.endsWith(".png"));
  check("PNG previews generated", pngs.length > 0, String(pngs.length));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
