/**
 * Stage 2 characterization — rebuild CanonicalClaims from saved analytics dir.
 * NETWORK_CALLS=0. Offline only.
 *
 * Usage:
 *   npx tsx scripts/characterize-canonical-claims.ts <analyticsDir> [outDir]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import type { SubjectResolution } from "../src/modules/digital-profile/orion-golden/contracts/subject-resolution";
import type { VerifiedFindingBundle } from "../src/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";
import type { Finding } from "../src/modules/digital-profile/orion-golden/contracts/finding";
import type { UncategorizedMaterialsBlock } from "../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import type { ObservationDispositionLedger } from "../src/modules/digital-profile/orion-golden/contracts/observation-disposition";
import {
  assertCanonicalClaimGatesPass,
  buildCanonicalClaimsBundle,
  buildCanonicalClaimsSummary,
} from "../src/modules/digital-profile/orion-golden/analytics/canonical-claim-builder";
import {
  assertDispositionGatesPass,
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
      "Usage: npx tsx scripts/characterize-canonical-claims.ts <analyticsDir> [outDir]"
    );
    process.exit(2);
  }
  const outDir = process.argv[3] ?? analyticsDir;

  const resolutionPath = join(analyticsDir, "subject-resolution.json");
  const bundlePath = join(analyticsDir, "verified-finding-bundle.json");
  const uncatPath = join(analyticsDir, "uncategorized-materials.json");
  const ambPath = join(analyticsDir, "ambiguous-findings.json");
  const compositePath = join(analyticsDir, "composite-serp-observations.json");
  const ledgerPath = join(analyticsDir, "observation-disposition-ledger.json");

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
    }
  >();
  if (existsSync(compositePath)) {
    const composite = readJson<{ observations?: Array<Record<string, unknown>> }>(
      compositePath
    );
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
      });
    }
  }

  const items: RawInventoryItem[] = resolution.items.map((row) => {
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

  const resolutionByRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));

  let dispositionLedger: ObservationDispositionLedger;
  if (existsSync(ledgerPath)) {
    dispositionLedger = readJson<ObservationDispositionLedger>(ledgerPath);
  } else {
    dispositionLedger = buildObservationDispositionLedger({
      caseId: resolution.caseId,
      datasetId: resolution.datasetId,
      inventoryReportRunId: "characterization",
      sourceHashes: resolution.sourceHashes ?? [],
      items,
      resolutionByRef,
      synthesis,
    });
    assertDispositionGatesPass(dispositionLedger);
  }

  const claims = buildCanonicalClaimsBundle({
    caseId: resolution.caseId,
    datasetId: resolution.datasetId,
    subjectId: resolution.subjectDisplayName || resolution.caseId,
    sourceHashes: resolution.sourceHashes ?? [],
    items,
    synthesis,
    dispositionLedger,
  });
  assertCanonicalClaimGatesPass(claims);
  const summary = buildCanonicalClaimsSummary(claims);

  mkdirSync(outDir, { recursive: true });
  const claimsOut = join(outDir, "canonical-claims.json");
  const summaryOut = join(outDir, "canonical-claims-summary.json");
  const reportOut = join(outDir, "canonical-claims-characterization-report.json");
  writeFileSync(claimsOut, `${JSON.stringify(claims, null, 2)}\n`, "utf8");
  writeFileSync(summaryOut, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const corruption = claims.claims.filter((c) =>
    c.themeIds.includes("corruption_integrity")
  );
  const politics = claims.claims.filter((c) =>
    c.themeIds.includes("political_public_exposure")
  );
  const report = {
    schemaVersion: "canonical-claims-characterization-v1",
    caseId: claims.caseId,
    datasetId: claims.datasetId,
    subjectId: claims.subjectId,
    sourceAnalyticsDir: analyticsDir,
    claimCount: claims.claims.length,
    gates: claims.gates,
    byTheme: summary.byTheme,
    byClaimKind: summary.byClaimKind,
    byMateriality: summary.byMateriality,
    summaryOverrideCount: summary.summaryOverrideCount,
    corruptionClaims: corruption.slice(0, 5).map((c) => ({
      claimId: c.claimId,
      themes: c.themeIds,
      kind: c.claimKind,
      materiality: c.materialityLevel,
      title: c.originalTitle.slice(0, 120),
      qualification: c.clientQualification.slice(0, 160),
    })),
    politicsClaims: politics.slice(0, 5).map((c) => ({
      claimId: c.claimId,
      themes: c.themeIds,
      kind: c.claimKind,
      materiality: c.materialityLevel,
      title: c.originalTitle.slice(0, 120),
    })),
    artifacts: { claims: claimsOut, summary: summaryOut },
  };
  writeFileSync(reportOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, gates: claims.gates, reportOut }, null, 2));
}

main();
