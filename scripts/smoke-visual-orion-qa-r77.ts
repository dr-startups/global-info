import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function main() {
  const out = join(process.cwd(), "storage/digital-profile/qa-r7-7-visual-orion-qa");
  const artifactPath = join(out, "artifact-inspection.json");
  const visualPath = join(out, "visual-orion-qa-inspection.json");
  const contentPath = join(out, "report-content-polish-inspection.json");
  const clientPolicyPath = join(out, "client-policy-inspection.json");
  const lexisPath = join(out, "lexisnexis-hybrid-import-inspection.json");
  const fullAuditPath = join(out, "full-audit-run-inspection.json");

  check("R7.7 artifact inspection exists", existsSync(artifactPath));
  check("R7.7 visual QA inspection exists", existsSync(visualPath));
  check("R7.7 content polish inspection exists", existsSync(contentPath));
  check("R7.7 client policy inspection exists", existsSync(clientPolicyPath));
  check("R7.7 Lexis inspection exists", existsSync(lexisPath));
  check("R7.7 full audit inspection exists", existsSync(fullAuditPath));
  if (failures) {
    process.exit(1);
  }

  const artifact = readJson<{ internalSlides: number; clientSlides: number }>(artifactPath);
  const visual = readJson<{ status: string; baseline: { internalPngCount: number; clientPngCount: number } }>(visualPath);
  const content = readJson<{
    rawThemeLeakInClientJson: boolean;
    englishLeakRuSlides: boolean;
    domainDerivedExists: boolean;
    reportPlacementOk: boolean;
    inspectInternalExit: number;
    inspectClientExit: number;
  }>(contentPath);
  const policy = readJson<{ totalViolations: number }>(clientPolicyPath);
  const lexis = readJson<{ renderedPages: number; status: string }>(lexisPath);
  const fullAudit = readJson<{ runtimeMode: string; status: string }>(fullAuditPath);

  check("Internal page count equals slide count", visual.baseline.internalPngCount === artifact.internalSlides, `${visual.baseline.internalPngCount}/${artifact.internalSlides}`);
  check("Client page count equals slide count", visual.baseline.clientPngCount === artifact.clientSlides, `${visual.baseline.clientPngCount}/${artifact.clientSlides}`);
  check("Visual ORION QA status PASS", visual.status === "PASS", visual.status);

  check("R7.6 flag rawThemeLeakInClientJson=false", content.rawThemeLeakInClientJson === false);
  check("R7.6 flag englishLeakRuSlides=false", content.englishLeakRuSlides === false);
  check("R7.6 flag domainDerivedExists=true", content.domainDerivedExists === true);
  check("Lexis placement markers present", content.reportPlacementOk === true);
  check("Internal inspect passed", content.inspectInternalExit === 0, String(content.inspectInternalExit));
  check("Client inspect passed", content.inspectClientExit === 0, String(content.inspectClientExit));
  check("Client policy violations = 0", policy.totalViolations === 0, String(policy.totalViolations));

  check("Lexis inspection PASS", lexis.status === "PASS", lexis.status);
  check("Lexis rendered pages present", Number(lexis.renderedPages) >= 7, String(lexis.renderedPages));
  check("Full audit runtime mode preserved", fullAudit.runtimeMode === "real_first_with_fallback", fullAudit.runtimeMode);
  check("Full audit status PASS", fullAudit.status === "PASS", fullAudit.status);

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
