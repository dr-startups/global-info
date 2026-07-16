/**
 * EXECUTIVE_SUMMARY — before/after demo for the Глинка case, NETWORK_CALLS=0.
 * BEFORE: the actual "Резюме" page text extracted from orion-classic-audit-v72.pdf.
 * AFTER: deterministic stage output on the rich-evidence fixture (no live API).
 * Artifacts land in baselines/report-72/artifacts/executive-summary/.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runExecutiveSummaryStage } from "../src/modules/digital-profile/orion-golden/executive-summary/run-stage";
import { richEvidenceFixture } from "../src/modules/digital-profile/orion-golden/executive-summary/fixtures";

const ROOT = join(__dirname, "..");
const EXTRACT = join(ROOT, "baselines", "report-72", "artifacts", "pdf-text-extract.json");
const OUT_DIR = join(ROOT, "baselines", "report-72", "artifacts", "executive-summary");
const DOC = join(ROOT, "docs", "orion-executive-summary-before-after.md");

async function main() {
  process.env.NETWORK_CALLS = "0";

  const extract = JSON.parse(readFileSync(EXTRACT, "utf8")) as {
    pages: Array<{ page?: number; pageNumber?: number; text?: string }>;
  };
  const summaryPage = extract.pages.find((p) => (p.page ?? p.pageNumber) === 3);
  const before = (summaryPage?.text ?? "(страница резюме не найдена)").trim();

  mkdirSync(OUT_DIR, { recursive: true });
  const result = await runExecutiveSummaryStage({
    input: richEvidenceFixture(),
    artifactsDir: OUT_DIR,
  });
  if (result.status !== "OK" && result.status !== "CACHED") {
    console.error("Stage failed:", result.status, result.guardViolations, result.schemaIssues);
    process.exit(1);
  }
  const out = result.output!;

  const lines: string[] = [];
  lines.push("# EXECUTIVE_SUMMARY — before/after (кейс Глинки)");
  lines.push("");
  lines.push(`Дата генерации: ${new Date().toISOString().slice(0, 10)}. NETWORK_CALLS=0, live API не вызывался.`);
  lines.push("");
  lines.push("## BEFORE — страница «Резюме» из orion-classic-audit-v72.pdf (стр. 3, MEASURED)");
  lines.push("");
  lines.push("```text");
  lines.push(before);
  lines.push("```");
  lines.push("");
  lines.push("## AFTER — EXECUTIVE_SUMMARY stage (rich-evidence fixture, deterministic composer)");
  lines.push("");
  lines.push(`- promptVersion: \`${result.promptVersion}\``);
  lines.push(`- inputHash: \`${result.inputHash}\``);
  lines.push(`- verdict: **${out.verdict}**`);
  lines.push("");
  lines.push("### Executive conclusion");
  lines.push("");
  lines.push(out.executiveConclusion);
  lines.push("");
  lines.push("### Key findings");
  lines.push("");
  for (const kf of out.keyFindings) {
    lines.push(`- **${kf.title}** (\`${kf.findingId}\`, ${kf.basisKind}, confidence ${kf.confidence})`);
    lines.push(`  - Факт: ${kf.factualBasis}`);
    lines.push(`  - Влияние: ${kf.clientImpact}`);
    lines.push(`  - Действие: ${kf.recommendedAction}`);
  }
  lines.push("");
  lines.push("### Regional overview");
  lines.push("");
  for (const r of out.regionalOverview) lines.push(`- ${r.oneLiner}`);
  lines.push("");
  lines.push("### Identity caveats");
  lines.push("");
  for (const c of out.identityCaveats) lines.push(`- ${c}`);
  lines.push("");
  lines.push("### Data limitations");
  lines.push("");
  for (const l of out.dataLimitations) lines.push(`- ${l}`);
  lines.push("");
  lines.push("### Priority actions");
  lines.push("");
  for (const a of out.priorityActions) lines.push(`- ${a}`);
  lines.push("");
  lines.push("### Methodology note");
  lines.push("");
  lines.push(out.methodologyNote);
  lines.push("");
  lines.push("## Артефакты стадии");
  lines.push("");
  lines.push("- `baselines/report-72/artifacts/executive-summary/executive-summary.json`");
  lines.push("- `baselines/report-72/artifacts/executive-summary/executive-summary-evidence-map.json`");
  lines.push("- `baselines/report-72/artifacts/executive-summary/executive-summary-prompt-version.json`");
  lines.push("");

  writeFileSync(DOC, lines.join("\n"), "utf8");
  console.log(`Stage status: ${result.status}`);
  console.log(`Verdict: ${out.verdict}; keyFindings: ${out.keyFindings.length}`);
  console.log(`Doc written: ${DOC}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
