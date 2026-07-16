/**
 * Prompt 2 — run the ORION analytics pipeline on persisted production
 * artifacts of a real case run (default: Glinka canary run).
 * NETWORK_CALLS=0: reads full-evidence-inventory.json, surface-coverage.json,
 * subject-identity-profile.json and arsenkin-report-binding.json from disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import type { ArsenkinReportBindingV2 } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-report-binding";
import { runOrionAnalyticsPipeline } from "../src/modules/digital-profile/orion-golden/analytics/run-analytics-pipeline";

const ROOT = join(__dirname, "..");

const RUN_DIR =
  process.env.ORION_ANALYTICS_RUN_DIR ??
  join(
    ROOT,
    "storage",
    "digital-profile",
    "qa-first36-canary",
    "cmreamy2t0002o30f29urzcog",
    "orion-canary-1783980828528"
  );

const BINDING_PATH =
  process.env.ORION_ANALYTICS_BINDING ??
  join(
    ROOT,
    "storage",
    "digital-profile",
    "qa-r10-orion-golden-parallel",
    "cases",
    "cmreamy2t0002o30f29urzcog-xfer-test",
    "arsenkin-report-binding.json"
  );

const OUT_DIR =
  process.env.ORION_ANALYTICS_OUT_DIR ?? join(ROOT, "baselines", "report-72", "artifacts", "analytics");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function main() {
  process.env.NETWORK_CALLS = "0";

  const inventory = readJson<{
    caseId: string;
    reportRunId: string;
    missingSources?: string[];
    items: RawInventoryItem[];
  }>(join(RUN_DIR, "full-evidence-inventory.json"));

  const coverage = readJson<{ rows: Array<Record<string, unknown>> }>(
    join(RUN_DIR, "surface-coverage.json")
  );
  const subjectProfile = readJson<Record<string, unknown>>(
    join(RUN_DIR, "subject-identity-profile.json")
  );
  const binding = existsSync(BINDING_PATH)
    ? readJson<ArsenkinReportBindingV2>(BINDING_PATH)
    : null;

  const providerTasks = existsSync(join(RUN_DIR, "provider-tasks.json"))
    ? readJson<Array<{ reportRunId?: string }>>(join(RUN_DIR, "provider-tasks.json"))
    : [];

  const result = await runOrionAnalyticsPipeline({
    caseId: inventory.caseId,
    inventoryReportRunId: inventory.reportRunId,
    items: inventory.items,
    binding,
    providerTaskRunIds: [
      ...new Set(providerTasks.map((t) => String(t.reportRunId ?? "")).filter(Boolean)),
    ],
    coverageRunIds: [
      ...new Set(
        coverage.rows.map((r) => String((r as { reportRunId?: string }).reportRunId ?? "")).filter(Boolean)
      ),
    ],
    coverageRows: coverage.rows.map((r) => ({
      region: String(r.region ?? ""),
      engine: String(r.engine ?? ""),
      surface: String(r.surface ?? ""),
      status: String(r.status ?? ""),
      provider: r.provider ? String(r.provider) : undefined,
      errorCode: r.errorCode == null ? null : String(r.errorCode),
    })),
    subjectProfile: subjectProfile as never,
    artifactsDir: OUT_DIR,
    missingSources: inventory.missingSources ?? [],
  });

  const { composite, synthesis, executiveSummary, benchmarkTrace, reconciliation } = result;
  console.log("=== RECONCILIATION ===");
  console.log(
    JSON.stringify(
      {
        baseReportRunId: reconciliation.baseReportRunId,
        enrichmentRunIds: reconciliation.enrichmentRunIds,
        includedRuns: reconciliation.includedRuns.map((r) => ({
          reportRunId: r.reportRunId,
          source: r.source,
          proof: r.proof,
          inRunEnrichment: r.inRunEnrichment,
        })),
        rejectedRuns: reconciliation.rejectedRuns,
        gaps: reconciliation.gaps,
      },
      null,
      2
    )
  );
  console.log("=== COMPOSITE ===");
  console.log(
    JSON.stringify(
      {
        datasetId: composite.dataset.datasetId,
        baseReportRunId: composite.dataset.baseReportRunId,
        enrichmentRunIds: composite.dataset.enrichmentRunIds,
        baseCount: composite.dataset.baseCount,
        enrichmentCount: composite.dataset.enrichmentCount,
        compositeCount: composite.dataset.compositeCount,
        duplicateCount: composite.dataset.duplicateCount,
        providerDelta: composite.providerDelta,
      },
      null,
      2
    )
  );

  console.log("=== SUBJECT RESOLUTION ===");
  const byDecision: Record<string, number> = {};
  for (const item of result.subjectResolution.items) {
    byDecision[item.decision] = (byDecision[item.decision] ?? 0) + 1;
  }
  console.log(JSON.stringify(byDecision, null, 2));

  console.log("=== FINDINGS ===");
  for (const f of synthesis.bundle.findings) {
    console.log(
      `${f.promotionPriority} [${f.riskLevel}] ${f.subjectMatch} ${f.findingId} :: ${f.theme} (evidence=${f.evidenceRefs.length}, contradictions=${f.contradictions.length}, limitations=${f.limitations.length})`
    );
  }
  console.log("ambiguous (appendix):", synthesis.ambiguousFindings.map((f) => f.findingId));

  console.log("=== EXECUTIVE SUMMARY ===");
  console.log("status:", executiveSummary.status, "verdict:", executiveSummary.output?.verdict);
  console.log(
    "keyFindings:",
    executiveSummary.output?.keyFindings.map((k) => `${k.findingId} (${k.basisKind})`)
  );
  if (executiveSummary.guardViolations.length > 0) {
    console.log("guard violations:", executiveSummary.guardViolations);
  }
  if (executiveSummary.schemaIssues.length > 0) {
    console.log("schema issues:", executiveSummary.schemaIssues);
  }

  console.log("=== BENCHMARK TRACE ===");
  for (const row of benchmarkTrace.rows) {
    console.log(
      `${row.status.padEnd(26)} ${row.label} (raw=${row.rawMatchCount}, subj=${row.subjectMatchCount}, amb=${row.ambiguousCount}, other=${row.otherSubjectCount})${row.notes.length ? ` NOTES: ${row.notes.join("; ")}` : ""}`
    );
  }

  console.log("=== ARTIFACTS ===");
  for (const [name, path] of Object.entries(result.artifactPaths)) {
    console.log(`${name} -> ${path}`);
  }
}

main().catch((err: unknown) => {
  const e = err as { message?: string; stack?: string; issues?: unknown };
  console.error("PIPELINE ERROR:", e?.message ?? String(err));
  if (e?.issues) console.error("issues:", JSON.stringify(e.issues, null, 2).slice(0, 3000));
  if (e?.stack) console.error(String(e.stack).split("\n").slice(0, 12).join("\n"));
  process.exit(1);
});
