import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanClientReportText } from "../src/modules/digital-profile/orion-section-pipeline/client-slide-contract";
import { runExactOrionPipeline } from "../src/modules/digital-profile/orion-section-pipeline/run-exact-orion-pipeline";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const out = join(process.cwd(), "storage", "digital-profile", "qa-r9-6a-orion-report-quality-smoke");
  const result = await runExactOrionPipeline("qa-r96a-case", {
    outputRoot: out,
    locale: "ru",
    useRealCaseData: false,
    allowDeterministicFallback: true,
  });

  const clientJsonPath = join(out, "composed", "final-report-json-client.json");
  check("client report json exists", existsSync(clientJsonPath));
  const clientJson = existsSync(clientJsonPath) ? readFileSync(clientJsonPath, "utf-8") : "";
  const issues = scanClientReportText(clientJson);
  check("no client report quality issues", issues.length === 0, issues.join("; ") || "clean");

  check("pipeline produced client pages", Number(result.compositionInspection.finalClientPageCount) > 0);
  check(
    "consistency inspection available",
    result.consistencyInspection.violations.length >= 0,
    String(result.consistencyInspection.status)
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
