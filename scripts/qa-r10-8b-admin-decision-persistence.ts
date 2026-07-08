/**
 * R10.8b — Admin decision persistence QA entrypoint.
 */
import { writeAdminDecisionPersistenceQaReport } from "../src/modules/digital-profile/orion-golden/qa/r10-8b-admin-decision-persistence-qa";

async function main() {
  const out = await writeAdminDecisionPersistenceQaReport(process.cwd());
  const report = JSON.parse(
    require("node:fs").readFileSync(out, "utf-8")
  ) as { verdict: string; passed: boolean; issues: string[]; modeChosen: string };
  console.log(`[INFO] wrote ${out}`);
  console.log(`[INFO] verdict=${report.verdict} passed=${report.passed} mode=${report.modeChosen}`);
  console.log(`[INFO] issues=${report.issues.join(",") || "(none)"}`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
