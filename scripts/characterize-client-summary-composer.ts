/**
 * Stage 5 characterization — ClientSummaryComposer before/after on saved case.
 * NETWORK_CALLS=0. Does not wire renderer.
 *
 * Usage:
 *   npx tsx scripts/characterize-client-summary-composer.ts <analyticsDir> [outDir]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ClientSummaryPack } from "../src/modules/digital-profile/orion-golden/contracts/client-summary-pack";
import type { CanonicalClaimsBundle } from "../src/modules/digital-profile/orion-golden/contracts/canonical-claim";
import type { RepresentativeEvidenceSelection } from "../src/modules/digital-profile/orion-golden/contracts/representative-evidence";
import {
  assertClientSummaryPackGatesPass,
  buildClientSummaryPack,
} from "../src/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import {
  assertComposedSummaryGatesPass,
  composeClientSummary,
} from "../src/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import { selectRepresentativeEvidence } from "../src/modules/digital-profile/orion-golden/analytics/representative-evidence-selector";

process.env.NETWORK_CALLS = "0";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function extractOldSummaryText(analyticsDir: string): string {
  const esPath = join(analyticsDir, "executive-summary.json");
  if (existsSync(esPath)) {
    const es = readJson<{
      executiveConclusion?: string;
      methodologyNote?: string;
      identityCaveats?: string[];
      keyFindings?: Array<{
        title?: string;
        factualBasis?: string;
        clientImpact?: string;
        recommendedAction?: string;
      }>;
      priorityActions?: string[];
      narrative?: string;
      summaryText?: string;
    }>(esPath);
    const parts: string[] = [];
    if (es.executiveConclusion) parts.push(es.executiveConclusion);
    if (es.methodologyNote) parts.push(es.methodologyNote);
    if (es.identityCaveats?.length) {
      parts.push(`Оговорки идентичности. ${es.identityCaveats.join(" ")}`);
    }
    for (const f of es.keyFindings ?? []) {
      const block = [
        f.title ? `${f.title}.` : "",
        f.factualBasis ?? "",
        f.clientImpact ?? "",
        f.recommendedAction ?? "",
      ]
        .filter(Boolean)
        .join(" ");
      if (block) parts.push(block);
    }
    if (es.priorityActions?.length) {
      parts.push(`Приоритетные действия. ${es.priorityActions.join(" ")}`);
    }
    if (es.narrative) parts.push(es.narrative);
    if (es.summaryText) parts.push(es.summaryText);
    if (parts.length) return parts.join("\n\n");
    return JSON.stringify(es, null, 2).slice(0, 4000);
  }
  const stale = join(analyticsDir, "..", "executive-summary.json.stale.json");
  if (existsSync(stale)) {
    return readFileSync(stale, "utf8").slice(0, 4000);
  }
  return "(executive-summary.json not found)";
}

function main(): void {
  const analyticsDir = process.argv[2];
  if (!analyticsDir) {
    console.error(
      "Usage: npx tsx scripts/characterize-client-summary-composer.ts <analyticsDir> [outDir]"
    );
    process.exit(2);
  }
  const outDir = process.argv[3] ?? analyticsDir;

  let pack: ClientSummaryPack;
  const packPath = join(analyticsDir, "client-summary-pack.json");
  if (existsSync(packPath)) {
    pack = readJson<ClientSummaryPack>(packPath);
  } else {
    const claimsPath = join(analyticsDir, "canonical-claims.json");
    if (!existsSync(claimsPath)) {
      console.error(`missing ${packPath} and ${claimsPath}`);
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
    pack = buildClientSummaryPack({
      caseId: claimsBundle.caseId,
      datasetId: claimsBundle.datasetId,
      subjectId: claimsBundle.subjectId,
      sourceHashes: claimsBundle.sourceHashes,
      claimsBundle,
      representative,
    });
    assertClientSummaryPackGatesPass(pack);
  }

  const composed = composeClientSummary({ pack });
  assertComposedSummaryGatesPass(composed);

  const beforeText = extractOldSummaryText(analyticsDir);
  mkdirSync(outDir, { recursive: true });
  const composedOut = join(outDir, "composed-client-summary.json");
  const beforeOut = join(outDir, "composed-summary-before.txt");
  const afterOut = join(outDir, "composed-summary-after.txt");
  const reportOut = join(outDir, "composed-client-summary-characterization-report.json");

  writeFileSync(composedOut, `${JSON.stringify(composed, null, 2)}\n`, "utf8");
  writeFileSync(beforeOut, `${beforeText}\n`, "utf8");
  writeFileSync(afterOut, `${composed.fullText}\n`, "utf8");

  const themeReport = composed.sections.themes.map((t) => ({
    themeId: t.themeId,
    heading: t.heading,
    materialityLevel: t.materialityLevel,
    evidenceRefs: t.evidenceRefs,
    articleTitles: t.articleTitles,
    articleDomains: t.articleDomains,
    bodyPreview: t.body.slice(0, 280),
  }));

  const report = {
    schemaVersion: "composed-client-summary-characterization-v1",
    caseId: composed.caseId,
    subjectId: composed.subjectId,
    gates: composed.gates,
    beforeChars: beforeText.length,
    afterChars: composed.fullText.length,
    themeCount: composed.sections.themes.length,
    continuationThemeIds: composed.continuationThemeIds,
    themes: themeReport,
    artifacts: {
      composed: composedOut,
      before: beforeOut,
      after: afterOut,
      report: reportOut,
    },
  };
  writeFileSync(reportOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        ok: true,
        gates: composed.gates,
        themeCount: composed.sections.themes.length,
        beforeChars: beforeText.length,
        afterChars: composed.fullText.length,
        reportOut,
      },
      null,
      2
    )
  );
}

main();
