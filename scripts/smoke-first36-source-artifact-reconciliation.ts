import { reconcileSourceArtifacts } from "../src/modules/digital-profile/orion-golden/classic/source-artifact-reconciliation";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
};

// A) matching run => PASS
const matching = reconcileSourceArtifacts({
  actual: { ru: 14, uae: 17 },
  expected: { ru: 14, uae: 17, expectationRunId: "run-14-17", source: "external" },
  binding: { sourceReportRunId: "run-14-17", effectiveReportRunId: "run-14-17" },
  sourceDir: "/fixture/run-14-17",
});
check("matching run reconciliation is PASS", matching.verdict === "PASS", matching.reason);
check("matching run realCasePass=true", matching.realCasePass === true);

// B) foreign/stale expectations => mismatch
const foreign = reconcileSourceArtifacts({
  actual: { ru: 14, uae: 17 },
  expected: { ru: 16, uae: 12, expectationRunId: "run-16-12", source: "external" },
  binding: { sourceReportRunId: "run-14-17", effectiveReportRunId: "run-14-17" },
  sourceDir: "/fixture/run-14-17",
});
check("foreign run expectations trigger mismatch", foreign.verdict === "SOURCE_ARTIFACT_MISMATCH");
check("foreign run sets realCasePass=false", foreign.realCasePass === false);

if (failures > 0) process.exitCode = 1;
console.log(failures ? `FAILED ${failures}` : "ALL PASS");
