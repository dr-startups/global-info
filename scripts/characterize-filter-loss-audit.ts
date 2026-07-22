/**
 * Stage 7 characterization — build filter-loss matrix from saved analytics dir.
 * NETWORK_CALLS=0.
 *
 * Usage:
 *   npx tsx scripts/characterize-filter-loss-audit.ts <analyticsDir> [outDir]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ObservationDispositionLedger } from "../src/modules/digital-profile/orion-golden/contracts/observation-disposition";
import type { Finding } from "../src/modules/digital-profile/orion-golden/contracts/finding";
import type { CompositeSerpProvenance } from "../src/modules/digital-profile/orion-golden/analytics/composite-dataset-builder";
import type { VerifiedFindingBundle } from "../src/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";
import {
  assertFilterLossGatesPass,
  buildFilterLossMatrix,
} from "../src/modules/digital-profile/orion-golden/analytics/filter-loss-audit";
import {
  overlayInventoryByCoverageCells,
  type OverlayBaseLineageEntry,
} from "../src/modules/digital-profile/orion-golden/classic/composite-serp-overlay-merge";

process.env.NETWORK_CALLS = "0";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main(): void {
  const analyticsDir = process.argv[2];
  if (!analyticsDir) {
    console.error(
      "Usage: npx tsx scripts/characterize-filter-loss-audit.ts <analyticsDir> [outDir]"
    );
    process.exit(2);
  }
  const outDir = process.argv[3] ?? analyticsDir;
  mkdirSync(outDir, { recursive: true });

  const ledgerPath = join(analyticsDir, "observation-disposition-ledger.json");
  if (!existsSync(ledgerPath)) {
    console.error(`missing ${ledgerPath}`);
    process.exit(1);
  }
  const ledger = readJson<ObservationDispositionLedger>(ledgerPath);
  const provenancePath = join(analyticsDir, "composite-serp-provenance.json");
  const analyticsProvenance = existsSync(provenancePath)
    ? readJson<CompositeSerpProvenance>(provenancePath)
    : null;
  const bundlePath = join(analyticsDir, "verified-finding-bundle.json");
  const findings: Finding[] = existsSync(bundlePath)
    ? readJson<VerifiedFindingBundle>(bundlePath).findings
    : [];
  const esPath = join(analyticsDir, "executive-summary.json");
  const kpiFindingIds = new Set<string>();
  if (existsSync(esPath)) {
    const es = readJson<{ keyFindings?: Array<{ findingId?: string }> }>(esPath);
    for (const k of es.keyFindings ?? []) {
      if (k.findingId) kpiFindingIds.add(k.findingId);
    }
  }

  // Optional offline overlay replay if raw inventories exist (scratch).
  let overlayBaseLineage: OverlayBaseLineageEntry[] | null = null;
  let overlayCoverage: number | null = null;
  const beforePath = join(analyticsDir, "overlay-before-after.json");
  if (existsSync(beforePath)) {
    // Optional fixture shape for local experiments — not required.
    void overlayInventoryByCoverageCells;
  }

  const matrix = buildFilterLossMatrix({
    caseId: ledger.caseId,
    datasetId: ledger.datasetId,
    sourceHashes: ledger.sourceHashes,
    dispositionLedger: ledger,
    analyticsProvenance,
    overlayBaseLineage,
    overlayBaseLineageCoveragePercent: overlayCoverage,
    findings,
    kpiFindingIds: kpiFindingIds.size ? kpiFindingIds : undefined,
    coverageLimitations: [],
    surfaceMetricRows: [],
  });

  try {
    assertFilterLossGatesPass(matrix);
  } catch (e) {
    writeFileSync(
      join(outDir, "filter-loss-matrix.json"),
      `${JSON.stringify(matrix, null, 2)}\n`,
      "utf8"
    );
    console.error(String(e));
    process.exit(1);
  }

  const matrixOut = join(outDir, "filter-loss-matrix.json");
  const reportOut = join(outDir, "filter-loss-characterization-report.json");
  writeFileSync(matrixOut, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");

  const beforeAfter = {
    schemaVersion: "filter-loss-characterization-v1",
    caseId: matrix.caseId,
    gates: matrix.gates,
    metrics: matrix.metrics,
    rows: matrix.rows.map((r) => ({
      filterId: r.filterId,
      status: r.status,
      materialFalseNegatives: r.materialFalseNegatives,
      reasonCode: r.reasonCode,
      oldBehavior: r.oldBehavior,
      newBehavior: r.newBehavior,
    })),
    artifacts: { matrix: matrixOut, report: reportOut },
  };
  writeFileSync(reportOut, `${JSON.stringify(beforeAfter, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        ok: true,
        gates: matrix.gates,
        rowCount: matrix.rows.length,
        reportOut,
      },
      null,
      2
    )
  );
}

main();
