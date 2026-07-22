/**
 * Stage 4 characterization — ClientSummaryPack from saved analytics artifacts.
 * NETWORK_CALLS=0. Does not wire renderer.
 *
 * Usage:
 *   npx tsx scripts/characterize-client-summary-pack.ts <analyticsDir> [outDir]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalClaimsBundle } from "../src/modules/digital-profile/orion-golden/contracts/canonical-claim";
import type { RepresentativeEvidenceSelection } from "../src/modules/digital-profile/orion-golden/contracts/representative-evidence";
import {
  assertClientSummaryPackGatesPass,
  buildClientSummaryPack,
} from "../src/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import { selectRepresentativeEvidence } from "../src/modules/digital-profile/orion-golden/analytics/representative-evidence-selector";

process.env.NETWORK_CALLS = "0";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main(): void {
  const analyticsDir = process.argv[2];
  if (!analyticsDir) {
    console.error(
      "Usage: npx tsx scripts/characterize-client-summary-pack.ts <analyticsDir> [outDir]"
    );
    process.exit(2);
  }
  const outDir = process.argv[3] ?? analyticsDir;
  const claimsPath = join(analyticsDir, "canonical-claims.json");
  if (!existsSync(claimsPath)) {
    console.error(`missing ${claimsPath}`);
    process.exit(1);
  }
  const claimsBundle = readJson<CanonicalClaimsBundle>(claimsPath);
  const selPath = join(analyticsDir, "representative-evidence-selection.json");
  const representative = existsSync(selPath)
    ? readJson<RepresentativeEvidenceSelection>(selPath)
    : selectRepresentativeEvidence({
        caseId: claimsBundle.caseId,
        datasetId: claimsBundle.datasetId,
        subjectId: claimsBundle.subjectId,
        sourceHashes: claimsBundle.sourceHashes,
        claimsBundle,
      }).selection;

  const pack = buildClientSummaryPack({
    caseId: claimsBundle.caseId,
    datasetId: claimsBundle.datasetId,
    subjectId: claimsBundle.subjectId,
    sourceHashes: claimsBundle.sourceHashes,
    claimsBundle,
    representative,
  });
  assertClientSummaryPackGatesPass(pack);

  mkdirSync(outDir, { recursive: true });
  const packOut = join(outDir, "client-summary-pack.json");
  const reportOut = join(outDir, "client-summary-pack-characterization-report.json");
  writeFileSync(packOut, `${JSON.stringify(pack, null, 2)}\n`, "utf8");

  const corruption = pack.materialThemes.find((t) => t.themeId === "corruption_integrity");
  const politics = pack.materialThemes.find((t) => t.themeId === "political_public_exposure");
  const report = {
    schemaVersion: "client-summary-pack-characterization-v1",
    caseId: pack.caseId,
    subjectId: pack.subjectId,
    gates: pack.gates,
    overallRisk: pack.overallAssessment.riskLevel,
    conclusion: pack.overallAssessment.conclusion,
    themeTitles: pack.materialThemes.map((t) => t.clientTitle),
    corruption: corruption
      ? {
          included: true,
          reason: "representative selection covered corruption_integrity with evidence",
          articles: corruption.representativeArticles.map((a) => ({
            title: a.title,
            domain: a.domain,
            qualification: a.clientQualification.slice(0, 160),
          })),
        }
      : {
          included: false,
          reason: "no selected representative for corruption_integrity in Stage 3 selection",
        },
    politics: politics
      ? {
          included: true,
          reason: "representative selection covered political_public_exposure with evidence",
          articles: politics.representativeArticles.map((a) => ({
            title: a.title,
            domain: a.domain,
          })),
        }
      : {
          included: false,
          reason: "no selected representative for political_public_exposure",
        },
    internationalDatabases: pack.internationalDatabases.map((d) => d.databaseName),
    nextSteps: pack.nextSteps,
    artifacts: { pack: packOut },
  };
  writeFileSync(reportOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, gates: pack.gates, reportOut }, null, 2));
}

main();
