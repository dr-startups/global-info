import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
};

const routePath = join(
  process.cwd(),
  "src",
  "app",
  "api",
  "digital-profile",
  "cases",
  "[id]",
  "orion-golden",
  "report",
  "diagnostics-bundle",
  "route.ts"
);
const code = readFileSync(routePath, "utf-8");

const required = [
  "rendered-client.pdf",
  "rendered-client.pptx",
  "arsenkin-full-first36-plan.json",
  "arsenkin-surface-coverage.json",
  "ai-answer-observations.json",
  "ai-answer-evaluations.json",
  "composite-serp-merge-provenance.json",
  "client-content-binding.json",
  "report-assets.json",
  "final-deck-manifest.json",
  "cross-slide-metric-report.json",
  "client-copy-report.json",
  "geometry-report.json",
  "first36-acceptance.json",
];

check("diagnostics bundle route exists", code.length > 100);
check("zip content-type set", /application\/zip/.test(code));
check("content-disposition attachment set", /content-disposition/.test(code));
check("relative pages-png path used", /pages-png\//.test(code));
check("no token leak in route", !/ARSENKIN_TOKEN|token\s*=/.test(code));
check("required artifacts are listed", required.every((name) => code.includes(name)));

if (failures > 0) process.exitCode = 1;
console.log(failures ? `FAILED ${failures}` : "ALL PASS");
