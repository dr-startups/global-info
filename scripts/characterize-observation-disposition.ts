/**
 * Stage 1 characterization — build disposition ledger from a saved analytics dir.
 * NETWORK_CALLS=0. Offline only.
 *
 * Universe = subject-resolution.items (every observation that entered analytics).
 *
 * Usage:
 *   npx tsx scripts/characterize-observation-disposition.ts <analyticsDir> [outDir]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import type { SubjectResolution } from "../src/modules/digital-profile/orion-golden/contracts/subject-resolution";
import type { VerifiedFindingBundle } from "../src/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";
import type { Finding } from "../src/modules/digital-profile/orion-golden/contracts/finding";
import type { UncategorizedMaterialsBlock } from "../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import type { CompositeSerpProvenance } from "../src/modules/digital-profile/orion-golden/analytics/composite-dataset-builder";
import {
  assertDispositionGatesPass,
  buildDispositionSummary,
  buildObservationDispositionLedger,
} from "../src/modules/digital-profile/orion-golden/analytics/observation-disposition-ledger";

process.env.NETWORK_CALLS = "0";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main(): void {
  const analyticsDir = process.argv[2];
  if (!analyticsDir) {
    console.error(
      "Usage: npx tsx scripts/characterize-observation-disposition.ts <analyticsDir> [outDir]"
    );
    process.exit(2);
  }
  const outDir = process.argv[3] ?? analyticsDir;

  const compositePath = join(analyticsDir, "composite-serp-observations.json");
  const resolutionPath = join(analyticsDir, "subject-resolution.json");
  const bundlePath = join(analyticsDir, "verified-finding-bundle.json");
  const uncatPath = join(analyticsDir, "uncategorized-materials.json");
  const ambPath = join(analyticsDir, "ambiguous-findings.json");
  const provPath = join(analyticsDir, "composite-serp-provenance.json");

  for (const p of [resolutionPath, bundlePath, uncatPath]) {
    if (!existsSync(p)) {
      console.error(`missing ${p}`);
      process.exit(1);
    }
  }

  const resolution = readJson<SubjectResolution>(resolutionPath);
  const bundle = readJson<VerifiedFindingBundle>(bundlePath);
  const uncategorized = readJson<UncategorizedMaterialsBlock>(uncatPath);
  const ambiguousFindings = existsSync(ambPath) ? readJson<Finding[]>(ambPath) : [];
  const provenance = existsSync(provPath)
    ? readJson<CompositeSerpProvenance>(provPath)
    : null;

  const byInvRef = new Map<
    string,
    {
      title: string;
      snippet: string;
      url: string;
      provider: string;
      region: string;
      engine: string;
      surface: string;
      query: string;
      sourceEvidenceRefs: string[];
    }
  >();
  if (existsSync(compositePath)) {
    const composite = readJson<{
      observations?: Array<Record<string, unknown>>;
    }>(compositePath);
    for (const obs of composite.observations ?? []) {
      const refs = Array.isArray(obs.evidenceRefs) ? (obs.evidenceRefs as string[]) : [];
      const invRef = refs.find((r) => String(r).startsWith("inventory:"));
      if (!invRef) continue;
      byInvRef.set(invRef, {
        title: String(obs.title ?? ""),
        snippet: String(obs.snippet ?? ""),
        url: String(obs.url ?? ""),
        provider: String(obs.provider ?? "unknown"),
        region: String(obs.region ?? "RU"),
        engine: String(obs.engine ?? ""),
        surface: String(obs.surface ?? "organic"),
        query: String(obs.query ?? ""),
        sourceEvidenceRefs: refs.filter((r) => !String(r).startsWith("inventory:")),
      });
    }
  }

  const items: RawInventoryItem[] = resolution.items.map((row, idx) => {
    const inv = byInvRef.get(row.evidenceRef);
    const inventoryId = row.evidenceRef.replace(/^inventory:/, "");
    return {
      inventoryId,
      caseId: resolution.caseId,
      reportRunId: resolution.datasetId,
      source: "analytics_inventory",
      provider: inv?.provider ?? "unknown",
      region: inv?.region ?? "RU",
      query: inv?.query ?? "",
      collectedAt: "1970-01-01T00:00:00.000Z",
      evidenceType: inv?.surface ?? "organic",
      title: inv?.title || `observation ${inventoryId}`,
      snippet: inv?.snippet ?? "",
      sourceUrl: inv?.url || undefined,
      rawMetadata: {
        engine: inv?.engine,
        surface: inv?.surface,
        queryText: inv?.query,
        sourceEvidenceRefs: inv?.sourceEvidenceRefs ?? [],
        characterizationIndex: idx,
      },
    };
  });

  const themeAssignments = new Map<string, string[]>();
  for (const f of [...bundle.findings, ...ambiguousFindings]) {
    const themeId = String(f.theme ?? "");
    for (const r of f.evidenceRefs ?? []) {
      const cur = themeAssignments.get(r) ?? [];
      if (themeId && !cur.includes(themeId)) cur.push(themeId);
      themeAssignments.set(r, cur);
    }
  }

  const resolutionByRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
  const synthesis = {
    bundle,
    ambiguousFindings,
    themeAssignments,
    uncategorized,
    stats: {
      subjectMatchEvidence: 0,
      likelySubjectEvidence: 0,
      ambiguousEvidence: 0,
      otherSubjectEvidence: 0,
      adverseFindingCount: 0,
      uncategorizedCount: uncategorized.count,
    },
  };

  const ledger = buildObservationDispositionLedger({
    caseId: resolution.caseId,
    datasetId: resolution.datasetId,
    inventoryReportRunId: String(
      existsSync(compositePath)
        ? (readJson<{ baseReportRunId?: string }>(compositePath).baseReportRunId ??
            "unknown")
        : "unknown"
    ),
    sourceHashes: resolution.sourceHashes ?? [],
    items,
    resolutionByRef,
    synthesis,
    provenance,
  });
  assertDispositionGatesPass(ledger);
  const summary = buildDispositionSummary(ledger);

  mkdirSync(outDir, { recursive: true });
  const ledgerPath = join(outDir, "observation-disposition-ledger.json");
  const summaryPath = join(outDir, "disposition-summary.json");
  const reportPath = join(outDir, "disposition-characterization-report.json");
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const materialKept = ledger.entries.filter(
    (e) =>
      e.materialitySignals.length > 0 &&
      (e.disposition === "KEEP_PRIMARY" || e.disposition === "KEEP_SUPPORTING")
  ).length;
  const report = {
    schemaVersion: "disposition-characterization-v1",
    caseId: ledger.caseId,
    datasetId: ledger.datasetId,
    sourceAnalyticsDir: analyticsDir,
    rawObservationCount: ledger.rawObservationCount,
    gates: ledger.gates,
    byDisposition: summary.byDisposition,
    bySubjectDecision: summary.bySubjectDecision,
    topReasonCodes: Object.entries(summary.byReasonCode)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15),
    materialKeptCount: materialKept,
    appendixAmbiguousCount: summary.byDisposition.APPENDIX_AMBIGUOUS ?? 0,
    otherSubjectCount: summary.byDisposition.EXCLUDE_OTHER_SUBJECT ?? 0,
    duplicateGroupCount: summary.duplicateGroupCount,
    sampleMaterialEntries: ledger.entries
      .filter((e) => e.materialitySignals.includes("adverse_text"))
      .slice(0, 8)
      .map((e) => ({
        rawObservationId: e.rawObservationId,
        disposition: e.disposition,
        reasonCode: e.reasonCode,
        title: e.originalTitle.slice(0, 120),
        themes: e.themeCandidates,
      })),
    artifacts: { ledger: ledgerPath, summary: summaryPath },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, gates: ledger.gates, reportPath }, null, 2));
}

main();
