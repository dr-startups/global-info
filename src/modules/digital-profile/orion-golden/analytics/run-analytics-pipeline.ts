/**
 * Prompt 2 — ORION analytics pipeline runner.
 * composite dataset → subject resolution → surface analyzers → finding
 * synthesis → executive summary input → benchmark trace.
 * Offline: consumes already-persisted inventory/binding/coverage artifacts,
 * никогда не вызывает live providers.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RawInventoryItem } from "../types";
import type { ArsenkinReportBindingV2 } from "../classic/arsenkin-report-binding";
import { mapRegionBucket } from "../classic/composite-serp-overlay-merge";
import type { SubjectResolution } from "../contracts/subject-resolution";
import type { SurfaceAnalysis } from "../contracts/surface-analysis";
import type { SurfaceKind } from "../contracts/common";
import {
  buildAnalyticsCompositeDataset,
  isArsenkinItem,
  domainOf,
  type CompositeBuildResult,
  type CoverageCellStatusRow,
  type ReportDataBinding,
} from "./composite-dataset-builder";
import {
  reconcileEnrichmentRuns,
  checkAcceptanceEnrichmentCoverage,
  type CaseAgentRunRecord,
  type EnrichmentRunReconciliation,
} from "./enrichment-run-reconciler";
import {
  subjectIdentityFromProfile,
  type SubjectIdentity,
} from "./subject-resolution-classifier";
import { resolveSubjectWithDerivedContext } from "./subject-context-miner";
import { runSurfaceAnalyzers, ADVERSE_PATTERNS } from "./surface-analyzers";
import { synthesizeFindings, type FindingSynthesisResult } from "./finding-synthesizer";
import { buildBenchmarkTrace, type BenchmarkTrace } from "./benchmark-trace";
import {
  EXECUTIVE_SUMMARY_STAGE_INPUT_SCHEMA_VERSION,
  ExecutiveSummaryStageInputSchema,
  type ExecutiveSummaryStageInput,
  type SourceQualityEntry,
} from "../executive-summary/stage-contracts";
import {
  runExecutiveSummaryStage,
  type ExecutiveSummaryStageResult,
} from "../executive-summary/run-stage";
import {
  applyAnalystOverrides,
  loadAnalystOverrides,
  mergeGuaranteedFindings,
  type AnalystOverridesBundle,
  type AnalystOverridesPrisma,
} from "../../services/analyst-overrides-loader";
import { resolveFindingThemesConfig } from "../../config/finding-themes";

export type AnalyticsPipelineInput = {
  caseId: string;
  /** The run whose inventory is being analyzed (canonical lineage anchor). */
  inventoryReportRunId: string;
  items: RawInventoryItem[];
  binding: ArsenkinReportBindingV2 | null;
  coverageRows: CoverageCellStatusRow[];
  subjectProfile: Parameters<typeof subjectIdentityFromProfile>[0];
  artifactsDir: string;
  missingSources?: string[];
  /** reportRunIds referenced by persisted provider tasks (diagnostics). */
  providerTaskRunIds?: string[];
  /** reportRunIds referenced by persisted coverage rows (diagnostics). */
  coverageRunIds?: string[];
  /** Durable CaseAgent run records (strictly verified before binding). */
  caseAgentRecords?: CaseAgentRunRecord[];
  /** Offline fixture overrides (§1.3); when set, skips prisma load. */
  analystOverrides?: AnalystOverridesBundle | null;
  /** Live load of SearchResult / RiskFinding overrides. */
  analystOverridesPrisma?: AnalystOverridesPrisma | null;
};

export type AnalyticsPipelineResult = {
  reconciliation: EnrichmentRunReconciliation;
  composite: CompositeBuildResult;
  subjectResolution: SubjectResolution;
  surfaceAnalyses: Record<SurfaceKind, SurfaceAnalysis>;
  synthesis: FindingSynthesisResult;
  executiveSummaryInput: ExecutiveSummaryStageInput;
  executiveSummary: ExecutiveSummaryStageResult;
  benchmarkTrace: BenchmarkTrace;
  reportDataBinding: ReportDataBinding;
  artifactPaths: Record<string, string>;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function writeArtifact(dir: string, name: string, value: unknown): { path: string; sha256: string } {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return { path, sha256: sha256(body) };
}

function sourceQualityFor(domains: string[]): SourceQualityEntry[] {
  const cfg = resolveFindingThemesConfig();
  return domains.map((domain) => ({
    domain,
    reliability: cfg.authoritativeDomains.test(domain)
      ? ("AUTHORITATIVE" as const)
      : cfg.reputableDomains.test(domain)
        ? ("REPUTABLE" as const)
        : cfg.unverifiedDomains.test(domain)
          ? ("UNVERIFIED" as const)
          : ("AGGREGATOR" as const),
  }));
}

function buildExecutiveSummaryInput(input: {
  caseId: string;
  datasetId: string;
  subject: SubjectIdentity;
  composite: CompositeBuildResult;
  subjectResolution: SubjectResolution;
  surfaceAnalyses: Record<SurfaceKind, SurfaceAnalysis>;
  synthesis: FindingSynthesisResult;
  coverageRows: CoverageCellStatusRow[];
  missingSources: string[];
  sourceHashes: string[];
}): ExecutiveSummaryStageInput {
  const coverage = input.coverageRows.map((row) => {
    const status = String(row.status ?? "").toUpperCase();
    return {
      region: mapRegionBucket(row.region),
      surface: row.surface,
      sampleStatus:
        status === "OK" || status === "NO_RESULTS"
          ? ("MEASURED" as const)
          : ("NOT_COLLECTED" as const),
    };
  });

  // Regional metrics from organic surface analysis (SUBJECT_MATCH KPI only).
  const organicUnits = input.surfaceAnalyses.organic?.units ?? [];
  const byRegion = new Map<string, { adverse: number; total: number }>();
  for (const unit of organicUnits) {
    const total = Number(unit.metrics.find((m) => m.key === "subjectMatchCount")?.value ?? 0);
    const adverse = Number(unit.metrics.find((m) => m.key === "adverseSubjectCount")?.value ?? 0);
    const acc = byRegion.get(unit.region) ?? { adverse: 0, total: 0 };
    acc.adverse += adverse;
    acc.total += total;
    byRegion.set(unit.region, acc);
  }
  const regionalMetrics = [...byRegion.entries()].map(([region, { adverse, total }]) => ({
    region,
    adverseCount: adverse,
    totalCount: total,
    adverseSharePercent: total > 0 ? Math.round((adverse / total) * 100) : null,
  }));

  const decisions = input.subjectResolution.items;
  const otherSubjectCount = decisions.filter((d) => d.decision === "OTHER_SUBJECT").length;
  const ambiguousCount = decisions.filter((d) => d.decision === "AMBIGUOUS").length;
  const conflictCounts = new Map<string, number>();
  for (const d of decisions) {
    for (const c of d.conflictingIdentifiers) {
      conflictCounts.set(c, (conflictCounts.get(c) ?? 0) + 1);
    }
  }
  // Dominant namesake is derived from the subject's OWN namesake profiles —
  // no hardcoded homonym names. Pick the namesake with the most conflict hits.
  let dominantOtherSubject: string | null = null;
  if (otherSubjectCount > 0) {
    let bestHits = 0;
    for (const namesake of input.subject.namesakeProfiles) {
      const hits = namesake.noiseTerms.reduce((acc, s) => acc + (conflictCounts.get(s) ?? 0), 0);
      if (hits > bestHits) {
        bestHits = hits;
        dominantOtherSubject = namesake.label;
      }
    }
  }

  // Client-facing surface labels — internal SurfaceKind keys never leak into
  // the executive conclusion ("Не закрыты направления: …").
  const SURFACE_CLIENT_LABELS: Record<string, string> = {
    organic: "органическая выдача",
    suggestions: "поисковые подсказки",
    paa_related: "связанные запросы",
    images: "изображения в поиске",
    wikipedia: "Википедия",
    ai_answers: "ответы ИИ-поиска",
    url_audit: "проверка URL и индексации",
    compliance: "комплаенс-базы",
  };
  const dataGaps: Array<{ area: string; detail: string }> = [];
  const notCollected = coverage.filter((c) => c.sampleStatus === "NOT_COLLECTED");
  for (const c of notCollected) {
    dataGaps.push({
      area: `${SURFACE_CLIENT_LABELS[c.surface] ?? c.surface} (${c.region})`,
      detail: "поверхность не собрана в текущем прогоне",
    });
  }
  for (const s of input.missingSources) {
    dataGaps.push({ area: s, detail: "источник отсутствует в инвентаре прогона" });
  }
  const unverifiedThemes = input.synthesis.bundle.findings.filter(
    (f) => f.subjectMatch === "SUBJECT_MATCH" && f.limitations.some((l) => /неподтвержд/iu.test(l))
  );
  for (const f of unverifiedThemes) {
    dataGaps.push({
      area: f.theme,
      detail: "часть сигналов не верифицирована первоисточниками",
    });
  }

  const allDomains = [
    ...new Set(
      input.synthesis.bundle.findings.flatMap((f) => f.sourceDomains).filter(Boolean)
    ),
  ];

  const recommendedActions = [
    ...new Set(
      input.synthesis.bundle.findings
        .filter((f) => f.subjectMatch === "SUBJECT_MATCH" && f.promotionPriority !== "APPENDIX")
        .map((f) => f.recommendedAction)
    ),
  ].slice(0, 5);

  return ExecutiveSummaryStageInputSchema.parse({
    schemaVersion: EXECUTIVE_SUMMARY_STAGE_INPUT_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: input.synthesis.bundle.evidenceRefs.slice(0, 100),
    subject: {
      displayName: input.subject.displayName,
      aliases: input.subject.aliases.slice(0, 10),
      identifiers: [
        ...input.subject.strongIdentifiers,
        ...input.subject.contextIdentifiers.slice(0, 4),
      ],
    },
    coverage,
    regionalMetrics,
    verifiedFindings: input.synthesis.bundle,
    ambiguousFindings: input.synthesis.ambiguousFindings,
    identityPollution: {
      otherSubjectCount,
      ambiguousCount,
      dominantOtherSubject,
      notes:
        otherSubjectCount > 0
          ? [
              `Материалы другого лица зафиксированы в ${otherSubjectCount} наблюдениях и исключены из KPI.`,
            ]
          : [],
    },
    dataGaps,
    sourceQuality: sourceQualityFor(allDomains),
    recommendedActions:
      recommendedActions.length > 0 ? recommendedActions : ["Обновить мониторинг выдачи."],
  });
}

export async function runOrionAnalyticsPipeline(
  input: AnalyticsPipelineInput
): Promise<AnalyticsPipelineResult> {
  mkdirSync(input.artifactsDir, { recursive: true });
  const artifactPaths: Record<string, string> = {};
  const hashes: Array<{ name: string; sha256: string }> = [];
  const emit = (name: string, value: unknown) => {
    const { path, sha256: h } = writeArtifact(input.artifactsDir, name, value);
    artifactPaths[name] = path;
    hashes.push({ name, sha256: h });
  };

  // 0. Fail-closed enrichment-run reconciliation (lineage-safe).
  const baseItemsAll = input.items.filter((i) => !isArsenkinItem(i));
  const enrichmentItemsAll = input.items.filter(isArsenkinItem);
  const reconciliation = reconcileEnrichmentRuns({
    caseId: input.caseId,
    subjectDisplayName: String(input.subjectProfile.displayName ?? ""),
    inventoryReportRunId: input.inventoryReportRunId,
    binding: input.binding,
    evidence: {
      observedRunIds: [...new Set(enrichmentItemsAll.map((i) => i.reportRunId))].sort(),
      providerTaskRunIds: input.providerTaskRunIds ?? [],
      coverageRunIds: input.coverageRunIds ?? [],
    },
    caseAgentRecords: input.caseAgentRecords ?? [],
  });

  // 1. Composite dataset (base primary, additive enrichment).
  // Fail-closed loading: only observations of reconciled runs enter the merge.
  const reconciledRunSet = new Set(reconciliation.enrichmentRunIds);
  const baseItems = baseItemsAll;
  const enrichmentItems = enrichmentItemsAll.filter((i) => reconciledRunSet.has(i.reportRunId));
  const orphanEnrichmentItems = enrichmentItemsAll.length - enrichmentItems.length;
  const composite = buildAnalyticsCompositeDataset({
    caseId: input.caseId,
    baseItems,
    enrichmentItems,
    binding: input.binding,
    coverageRows: input.coverageRows,
    baseReportRunId: reconciliation.baseReportRunId,
    enrichmentRunIds: reconciliation.enrichmentRunIds,
  });
  if (orphanEnrichmentItems > 0) {
    composite.provenance.warnings.push(
      `orphan-enrichment-items-excluded:${orphanEnrichmentItems} (runs not reconciled)`
    );
  }
  const datasetId = composite.dataset.datasetId;
  const sourceHashes = composite.dataset.sourceHashes;

  // 2. Subject resolution over every composite item — two-pass with
  // automatically derived context: terms mined from conflict-free
  // SUBJECT_MATCH items enrich contextIdentifiers, no manual input required.
  const subject = subjectIdentityFromProfile(input.subjectProfile);
  const derived = resolveSubjectWithDerivedContext({
    caseId: input.caseId,
    datasetId,
    subject,
    items: input.items,
    sourceHashes,
  });
  const subjectResolution = derived.resolution;
  emit("derived-subject-context.json", {
    version: "derived-subject-context-v1",
    caseId: input.caseId,
    datasetId,
    suppliedContext: derived.suppliedContext,
    minedContext: derived.minedContext,
    effectiveContext: derived.effectiveContext,
    matchedItemCount: derived.matchedItemCount,
  });
  const resolutionByRef = new Map(subjectResolution.items.map((i) => [i.evidenceRef, i]));

  // 2b. Analyst overrides (§1.3) — after identity, before surfaces/findings.
  const overridesBundle = await loadAnalystOverrides({
    caseId: input.caseId,
    fixture: input.analystOverrides,
    prisma: input.analystOverrides == null ? input.analystOverridesPrisma ?? null : null,
  });
  const overrideResult = applyAnalystOverrides({
    items: input.items,
    resolutionByRef,
    subjectResolution,
    overrides: overridesBundle,
  });

  // Complete provider delta with relevance/adverse figures.
  const enrichmentRefs = new Set(enrichmentItems.map((i) => `inventory:${i.inventoryId}`));
  let relevantCount = 0;
  let ambiguousCount = 0;
  let otherSubjectCount = 0;
  let newAdverse = 0;
  for (const item of enrichmentItems) {
    const d = resolutionByRef.get(`inventory:${item.inventoryId}`)?.decision;
    if (d === "SUBJECT_MATCH") relevantCount += 1;
    else if (d === "AMBIGUOUS") ambiguousCount += 1;
    else if (d === "OTHER_SUBJECT") otherSubjectCount += 1;
    const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
    const adverse =
      meta.analystNeutral === true
        ? false
        : meta.analystAdverse === true ||
          ADVERSE_PATTERNS.test([item.title, item.snippet, item.classification].filter(Boolean).join(" "));
    if (d === "SUBJECT_MATCH" && adverse) {
      newAdverse += 1;
    }
  }
  composite.providerDelta.relevantCount = relevantCount;
  composite.providerDelta.ambiguousCount = ambiguousCount;
  composite.providerDelta.otherSubjectCount = otherSubjectCount;
  composite.providerDelta.newAdverseFindingCount = newAdverse;
  void enrichmentRefs;

  // 3. Typed surface analyzers.
  const surfaceAnalyses = runSurfaceAnalyzers({
    caseId: input.caseId,
    datasetId,
    items: input.items,
    resolutionLookup: resolutionByRef,
    sourceHashes,
  });

  // 4. Finding synthesis → VerifiedFindingBundle.
  const coverageLimitations = input.coverageRows
    .filter((r) => !["OK", "NO_RESULTS"].includes(String(r.status).toUpperCase()))
    .map((r) => `${r.surface} (${r.region}/${r.engine}): статус ${r.status}, данные не собраны`);
  let synthesis = synthesizeFindings({
    caseId: input.caseId,
    datasetId,
    items: input.items,
    resolutionByRef,
    sourceHashes,
    coverageLimitations: [...new Set(coverageLimitations)].slice(0, 3),
  });
  synthesis = {
    ...synthesis,
    bundle: mergeGuaranteedFindings({
      caseId: input.caseId,
      datasetId,
      sourceHashes,
      bundle: synthesis.bundle,
      guaranteed: overrideResult.guaranteedFindings,
      items: input.items,
      applied: overrideResult.applied,
    }),
  };
  emit("analyst-overrides-applied.json", {
    version: "analyst-overrides-applied-v1",
    caseId: input.caseId,
    count: overrideResult.applied.length,
    applied: overrideResult.applied,
  });

  // 5. Executive summary wired to actual pipeline output.
  const executiveSummaryInput = buildExecutiveSummaryInput({
    caseId: input.caseId,
    datasetId,
    subject,
    composite,
    subjectResolution,
    surfaceAnalyses,
    synthesis,
    coverageRows: input.coverageRows,
    missingSources: input.missingSources ?? [],
    sourceHashes,
  });
  const executiveSummary = await runExecutiveSummaryStage({
    input: executiveSummaryInput,
    artifactsDir: input.artifactsDir,
  });

  // 6. Benchmark trace with promoted set = key findings of the summary.
  const promotedFindingIds = new Set(
    executiveSummary.output?.keyFindings.map((kf) => kf.findingId) ?? []
  );
  const verifiedOnly = synthesis.bundle.findings.filter(
    (f) => f.subjectMatch === "SUBJECT_MATCH"
  );
  const benchmarkTrace = buildBenchmarkTrace({
    caseId: input.caseId,
    datasetId,
    items: input.items,
    resolutionByRef,
    verifiedFindings: verifiedOnly,
    ambiguousFindings: synthesis.ambiguousFindings,
    promotedFindingIds,
    themeAssignments: synthesis.themeAssignments,
  });

  // Applicable acceptance-binding check: reconciled runs must be fully known
  // to the acceptance composite binding (guards the "under-list" defect).
  const acceptanceCheck = checkAcceptanceEnrichmentCoverage({
    acceptanceEnrichmentRunIds:
      input.binding && input.binding.caseId === input.caseId
        ? (input.binding.enrichmentRuns ?? []).map((r) => r.reportRunId)
        : [],
    reconciledEnrichmentRunIds: reconciliation.enrichmentRunIds,
    baseReportRunId: reconciliation.baseReportRunId,
  });

  // Emit artifacts.
  emit("enrichment-run-reconciliation.json", {
    ...reconciliation,
    acceptanceBindingCheck: acceptanceCheck,
  });
  emit("composite-serp-observations.json", composite.dataset);
  emit("composite-serp-provenance.json", composite.provenance);
  emit("provider-delta.json", composite.providerDelta);
  emit("subject-resolution.json", subjectResolution);
  emit("surface-analysis.json", surfaceAnalyses);
  emit("verified-finding-bundle.json", synthesis.bundle);
  emit("ambiguous-findings.json", synthesis.ambiguousFindings);
  emit("uncategorized-materials.json", synthesis.uncategorized);
  emit("executive-summary-input.json", executiveSummaryInput);
  emit("benchmark-trace.json", benchmarkTrace);

  const reportDataBinding: ReportDataBinding = {
    schemaVersion: "report-data-binding-v1",
    caseId: input.caseId,
    datasetId,
    baseReportRunId: reconciliation.baseReportRunId,
    enrichmentRunIds: reconciliation.enrichmentRunIds,
    sourceBindingDigest:
      input.binding && input.binding.caseId === input.caseId
        ? input.binding.compositeDigest
        : null,
    artifacts: hashes,
    generatedAt: new Date().toISOString(),
  };
  emit("report-data-binding.json", reportDataBinding);

  return {
    reconciliation,
    composite,
    subjectResolution,
    surfaceAnalyses,
    synthesis,
    executiveSummaryInput,
    executiveSummary,
    benchmarkTrace,
    reportDataBinding,
    artifactPaths,
  };
}

export { domainOf };
