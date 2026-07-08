/**
 * R10.8 — Admin UI QA entrypoint.
 * Prefers R10.7c real-subject calibration artifacts (CASE_ID cmqzz1vbr00d2vdrsrjsgie2g).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectAdminUiQa } from "../src/modules/digital-profile/orion-golden/qa/r10-8-admin-ui-qa";

const CASE_ID = process.env.CASE_ID?.trim() || "cmqzz1vbr00d2vdrsrjsgie2g";
const full = {
  ...inspectAdminUiQa({ workspaceRoot: process.cwd(), caseId: CASE_ID }),
  generatedAt: new Date().toISOString(),
};

const outDir = join(process.cwd(), "storage/digital-profile/qa-r10-8-admin-ui");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "r10-8-admin-ui-qa.json");
writeFileSync(outPath, `${JSON.stringify(full, null, 2)}\n`, "utf-8");

console.log(`[INFO] CASE_ID=${CASE_ID}`);
console.log(
  `[INFO] artifactSource=${full.metrics?.artifactSource} queueCaseId=${full.metrics?.queueCaseId} queueCount=${full.metrics?.queueCount}`
);
console.log(`[INFO] wrote ${outPath}`);
console.log(`[INFO] verdict=${full.verdict} passed=${full.passed}`);
console.log(`[INFO] issues=${full.issues.join(",") || "(none)"}`);
console.log(`[INFO] metrics=${JSON.stringify(full.metrics ?? {})}`);
process.exit(full.passed ? 0 : 1);
