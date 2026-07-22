/**
 * Stage 3 characterization — representative evidence from saved analytics dir.
 * NETWORK_CALLS=0.
 *
 * Usage:
 *   npx tsx scripts/characterize-representative-evidence.ts <analyticsDir> [outDir]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalClaimsBundle } from "../src/modules/digital-profile/orion-golden/contracts/canonical-claim";
import {
  assertRepresentativeGatesPass,
  selectRepresentativeEvidence,
} from "../src/modules/digital-profile/orion-golden/analytics/representative-evidence-selector";

process.env.NETWORK_CALLS = "0";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main(): void {
  const analyticsDir = process.argv[2];
  if (!analyticsDir) {
    console.error(
      "Usage: npx tsx scripts/characterize-representative-evidence.ts <analyticsDir> [outDir]"
    );
    process.exit(2);
  }
  const outDir = process.argv[3] ?? analyticsDir;
  const claimsPath = join(analyticsDir, "canonical-claims.json");
  if (!existsSync(claimsPath)) {
    console.error(`missing ${claimsPath} — run characterize-canonical-claims first`);
    process.exit(1);
  }
  const claimsBundle = readJson<CanonicalClaimsBundle>(claimsPath);
  const result = selectRepresentativeEvidence({
    caseId: claimsBundle.caseId,
    datasetId: claimsBundle.datasetId,
    subjectId: claimsBundle.subjectId,
    sourceHashes: claimsBundle.sourceHashes,
    claimsBundle,
  });
  assertRepresentativeGatesPass(result.selection);

  mkdirSync(outDir, { recursive: true });
  const selPath = join(outDir, "representative-evidence-selection.json");
  const covPath = join(outDir, "representative-evidence-coverage.json");
  const exclPath = join(outDir, "excluded-materiality-report.json");
  const reportPath = join(outDir, "representative-evidence-characterization-report.json");
  writeFileSync(selPath, `${JSON.stringify(result.selection, null, 2)}\n`, "utf8");
  writeFileSync(covPath, `${JSON.stringify(result.coverage, null, 2)}\n`, "utf8");
  writeFileSync(exclPath, `${JSON.stringify(result.excluded, null, 2)}\n`, "utf8");

  const report = {
    schemaVersion: "representative-evidence-characterization-v1",
    caseId: result.selection.caseId,
    datasetId: result.selection.datasetId,
    subjectId: result.selection.subjectId,
    gates: result.selection.gates,
    materialThemeIds: result.selection.materialThemeIds,
    selectedCounts: Object.fromEntries(
      Object.entries(result.selection.selectedByTheme).map(([k, v]) => [k, v.length])
    ),
    isolatedCount: result.selection.isolatedSignificantItems.length,
    p1p2Account: result.selection.p1p2Account.length,
    excludedCount: result.excluded.excluded.length,
    corruptionSlot: result.selection.selectedByTheme.corruption_integrity ?? [],
    politicsSlot: result.selection.selectedByTheme.political_public_exposure ?? [],
    artifacts: { selection: selPath, coverage: covPath, excluded: exclPath },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, gates: result.selection.gates, reportPath }, null, 2));
}

main();
