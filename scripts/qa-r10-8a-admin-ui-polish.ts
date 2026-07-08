/**
 * R10.8a — Admin UI polish QA entrypoint.
 */
import { writeAdminUiPolishQaReport } from "../src/modules/digital-profile/orion-golden/qa/r10-8a-admin-ui-polish-qa";

const out = writeAdminUiPolishQaReport(process.cwd());
const report = JSON.parse(require("node:fs").readFileSync(out, "utf-8")) as {
  verdict: string;
  passed: boolean;
  issues: string[];
};
console.log(`[INFO] wrote ${out}`);
console.log(`[INFO] verdict=${report.verdict} passed=${report.passed}`);
console.log(`[INFO] issues=${report.issues.join(",") || "(none)"}`);
process.exit(report.passed ? 0 : 1);
