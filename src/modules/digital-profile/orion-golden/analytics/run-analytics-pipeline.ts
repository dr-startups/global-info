/**
 * Prompt 2 — ORION analytics pipeline runner.
 * composite dataset → subject resolution → surface analyzers → finding
 * synthesis → executive summary input → benchmark trace.
 * Offline: consumes already-persisted inventory/binding/coverage artifacts,
 * никогда не вызывает live providers.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { runFactExtraction, type GptJsonCaller as FactGptCaller } from "../gpt/run-fact-extraction";
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
import { resolveAnalysisScope, type AnalysisScopeSummary } from "./analysis-scope";
import { runLinkVerdicts } from "./run-link-verdicts";
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
import type { GptJsonCaller } from "../gpt/gpt-case-analysis";
import {
  isGptIdentityEnabled,
  runGptIdentityResolution,
} from "../gpt/gpt-identity-resolver";
import {
  isGptThemesEnabled,
  runGptThemeSuggestion,
} from "../gpt/gpt-theme-suggester";
import {
  assertDispositionGatesPass,
  buildDispositionSummary,
  buildObservationDispositionLedger,
} from "./observation-disposition-ledger";
import type { ObservationDispositionLedger } from "../contracts/observation-disposition";
import type { DispositionSummary } from "../contracts/observation-disposition";
import {
  assertCanonicalClaimGatesPass,
  buildCanonicalClaimsBundle,
  buildCanonicalClaimsSummary,
} from "./canonical-claim-builder";
import type { CanonicalClaimsBundle } from "../contracts/canonical-claim";
import type { CanonicalClaimsSummary } from "../contracts/canonical-claim";
import {
  assertRepresentativeGatesPass,
  selectRepresentativeEvidence,
} from "./representative-evidence-selector";
import type { RepresentativeEvidenceSelection } from "../contracts/representative-evidence";
import type { RepresentativeCoverageReport } from "../contracts/representative-evidence";
import type { ExcludedMaterialityReport } from "../contracts/representative-evidence";
import {
  assertClientSummaryPackGatesPass,
  buildClientSummaryPack,
} from "./client-summary-pack-builder";
import type { ClientSummaryPack } from "../contracts/client-summary-pack";
import {
  assertComposedSummaryGatesPass,
  composeClientSummary,
} from "./client-summary-composer";
import type { ComposedClientSummary } from "../contracts/composed-client-summary";
import {
  assertFilterLossGatesPass,
  buildFilterLossMatrix,
} from "./filter-loss-audit";
import type { FilterLossMatrix } from "../contracts/filter-loss-matrix";

export type AnalyticsPipelineInput = {
  caseId: string;
  /** The run whose inventory is being analyzed (canonical lineage anchor). */
  inventoryReportRunId: string;
  items: RawInventoryItem[];
  binding: ArsenkinReportBindingV2 | null;
  coverageRows: CoverageCellStatusRow[];
  subjectProfile: Parameters<typeof subjectIdentityFromProfile>[0];
  artifactsDir: string;
  /** Injected in tests/offline smokes; production resolves its own caller. */
  factExtractionCaller?: FactGptCaller;
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
  /** Injectable GPT callers for offline tests (§2.4 / §3.3). */
  gptIdentityCaller?: GptJsonCaller;
  gptThemesCaller?: GptJsonCaller;
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
  dispositionLedger: ObservationDispositionLedger;
  dispositionSummary: DispositionSummary;
  canonicalClaims: CanonicalClaimsBundle;
  canonicalClaimsSummary: CanonicalClaimsSummary;
  representativeEvidence: RepresentativeEvidenceSelection;
  representativeCoverage: RepresentativeCoverageReport;
  excludedMateriality: ExcludedMaterialityReport;
  clientSummaryPack: ClientSummaryPack;
  composedClientSummary: ComposedClientSummary;
  filterLossMatrix: FilterLossMatrix;
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

  // 2c. Optional GPT identity disambiguation of AMBIGUOUS (§2.4).
  // Fail-safe: errors leave materials AMBIGUOUS. Never raises to SUBJECT_MATCH.
  if (isGptIdentityEnabled() || input.gptIdentityCaller) {
    const identityArtifact = await runGptIdentityResolution({
      caseId: input.caseId,
      datasetId,
      subject,
      items: input.items,
      resolutionByRef,
      subjectResolution,
      sourceHashes,
      enabled: isGptIdentityEnabled() || Boolean(input.gptIdentityCaller),
      caller: input.gptIdentityCaller,
    });
    emit("gpt-identity-resolution.json", identityArtifact);
  }

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

  // 2d. Область анализа: предмет аудита — ТОП-20 выдачи и международные базы.
  //
  // Разбор личности (кто на материале) идёт по всему собранному: страницы
  // подсказок, изображений и похожих запросов остаются в отчёте и обязаны
  // честно говорить, о субъекте ли материал. А темы риска и итоговая оценка
  // строятся только по предмету аудита — иначе вывод опирается на то, чего
  // проверяющий в выдаче не увидит.
  const scope = resolveAnalysisScope(input.items);
  emit("analysis-scope.json", {
    ...scope.summary,
    caseId: input.caseId,
    datasetId,
    excluded: scope.outOfScope.slice(0, 500).map((d) => ({
      evidenceRef: d.evidenceRef,
      reason: d.reason,
      lane: d.lane,
      rank: d.rank,
      title: d.item.title,
      url: d.item.sourceUrl ?? null,
    })),
  });

  // 2e. Чтение ссылок предмета аудита.
  //
  // Тема материала до сих пор выбиралась по заголовку и сниппету — по двум
  // строкам, которые показал поисковик. Здесь страницы читаются целиком, и
  // решение по каждой выносится с цитатами. Шаг выключен по умолчанию: он
  // ходит на чужие сайты и в модель, а это деньги за каждый отчёт.
  const linkVerdicts = await runLinkVerdicts({
    caseId: input.caseId,
    subject: { fullName: subject.displayName, aliases: subject.aliases ?? [] },
    items: scope.inScope,
  });
  emit("link-verdicts.json", {
    ...linkVerdicts,
    datasetId,
  });
  /*
   * Ноль прочитанных страниц при непустом запросе — это поломка у нас, и она
   * обязана быть слышна.
   *
   * Три прогона подряд отчёт сообщал, что все сто двадцать ссылок «не
   * открылись», а на самом деле падал сам запрос: в заголовке была кириллица.
   * Отличить одно от другого по тихому артефакту было нельзя, поэтому теперь
   * такой прогон кричит в лог — там же, где видно всё остальное.
   */
  if (linkVerdicts.readingBroken) {
    const detail = linkVerdicts.verdicts.find((v) => v.failureDetail)?.failureDetail;
    console.error(
      `[digital-profile][ссылки] ЧТЕНИЕ НЕ РАБОТАЕТ: запрошено ${linkVerdicts.requested} страниц, прочитано 0` +
        (detail ? `. Первая причина: ${detail}` : "")
    );
  } else if (linkVerdicts.requested > 0) {
    console.log(
      `[digital-profile][ссылки] прочитано ${linkVerdicts.readOk} из ${linkVerdicts.requested} страниц`
    );
  }

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
    items: scope.inScope,
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

  // 4b. Optional GPT theme suggestions for uncategorized materials (§3.3).
  // Accepted themes → LIKELY_SUBJECT findings with origin llm-suggested (not KPI).
  if (isGptThemesEnabled() || input.gptThemesCaller) {
    const themeResult = await runGptThemeSuggestion({
      caseId: input.caseId,
      datasetId,
      items: input.items,
      uncategorized: synthesis.uncategorized,
      sourceHashes,
      enabled: isGptThemesEnabled() || Boolean(input.gptThemesCaller),
      caller: input.gptThemesCaller,
    });
    emit("gpt-theme-suggestion.json", themeResult.artifact);
    if (themeResult.findings.length > 0) {
      const usedRefs = new Set(themeResult.findings.flatMap((f) => f.evidenceRefs));
      const allEvidenceRefs = synthesis.uncategorized.allEvidenceRefs.filter(
        (r) => !usedRefs.has(r)
      );
      const topExamples = synthesis.uncategorized.topExamples.filter(
        (e) => !usedRefs.has(e.evidenceRef)
      );
      const byRegion: typeof synthesis.uncategorized.byRegion = {};
      for (const [region, bucket] of Object.entries(synthesis.uncategorized.byRegion)) {
        const examples = bucket.examples.filter((e) => !usedRefs.has(e.evidenceRef));
        const count = Math.max(0, bucket.count - (bucket.examples.length - examples.length));
        if (count > 0 || examples.length > 0) {
          byRegion[region] = { count: examples.length || count, examples };
        }
      }
      const remainingUncat = {
        ...synthesis.uncategorized,
        allEvidenceRefs,
        topExamples,
        byRegion,
        count: allEvidenceRefs.length,
        subjectMatchCount: topExamples.filter((e) => e.subjectMatch === "SUBJECT_MATCH")
          .length,
        likelySubjectCount: topExamples.filter((e) => e.subjectMatch === "LIKELY_SUBJECT")
          .length,
      };
      synthesis = {
        ...synthesis,
        uncategorized: remainingUncat,
        stats: {
          ...synthesis.stats,
          uncategorizedCount: remainingUncat.count,
        },
        bundle: {
          ...synthesis.bundle,
          findings: [...synthesis.bundle.findings, ...themeResult.findings],
        },
      };
    }
  }

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

  // Stage 1 — ObservationDisposition ledger (100% raw accounting).
  const dispositionLedger = buildObservationDispositionLedger({
    caseId: input.caseId,
    datasetId,
    inventoryReportRunId: input.inventoryReportRunId,
    sourceHashes,
    items: input.items,
    resolutionByRef,
    synthesis,
    provenance: composite.provenance,
    kpiFindingIds: promotedFindingIds,
    outOfScopeByRef: new Map(
      scope.outOfScope.map((d) => [d.evidenceRef, String(d.reason)])
    ),
  });
  assertDispositionGatesPass(dispositionLedger);
  const dispositionSummary = buildDispositionSummary(dispositionLedger);

  // Stage 2 — CanonicalClaim bundle (themes + materiality + qualifications).
  const canonicalClaims = buildCanonicalClaimsBundle({
    caseId: input.caseId,
    datasetId,
    subjectId: subject.displayName || input.caseId,
    sourceHashes,
    items: input.items,
    synthesis,
    dispositionLedger,
  });
  assertCanonicalClaimGatesPass(canonicalClaims);
  const canonicalClaimsSummary = buildCanonicalClaimsSummary(canonicalClaims);

  // Stage 3 — coverage-aware representative evidence selection.
  const representative = selectRepresentativeEvidence({
    caseId: input.caseId,
    datasetId,
    subjectId: subject.displayName || input.caseId,
    sourceHashes,
    claimsBundle: canonicalClaims,
  });
  assertRepresentativeGatesPass(representative.selection);

  // Stage 3b — verified facts per theme (05.2c2). Fail-open: a theme whose
  // extraction fails keeps its deterministic text.
  const factExtraction = await runFactExtraction({
    caseId: input.caseId,
    datasetId,
    subjectName: subject.displayName || input.caseId,
    claimsBundle: canonicalClaims,
    representative: representative.selection,
    itemsByRef: new Map(input.items.map((i) => [`inventory:${i.inventoryId}`, i])),
    ...(input.factExtractionCaller ? { caller: input.factExtractionCaller, enabled: true } : {}),
  });
  emit("extracted-facts.json", factExtraction);

  // Stage 4 — ClientSummaryPack (typed summary input; not wired to renderer).
  const regions = [
    ...new Set(input.items.map((i) => String(i.region || "").toUpperCase()).filter(Boolean)),
  ];
  const clientSummaryPack = buildClientSummaryPack({
    caseId: input.caseId,
    datasetId,
    subjectId: subject.displayName || input.caseId,
    sourceHashes,
    claimsBundle: canonicalClaims,
    representative: representative.selection,
    factsByTheme: factExtraction.factsByTheme,
    factsProcessedThemes: factExtraction.diagnostics.processedThemeIds,
    // Single source of truth for the verdict — the badge and the summary
    // sentence must not answer differently (step 07.9).
    ...(executiveSummary.output?.verdict
      ? { overallVerdict: executiveSummary.output.verdict }
      : {}),
    scope: {
      regions: regions.length > 0 ? regions : ["RU", "UAE"],
      coverageLimitations: executiveSummaryInput.dataGaps?.map((g) => g.detail) ?? [],
      // Резюме обязано назвать глубину, на которой работал аудит: это то же
      // число, по которому отсекалась область анализа.
      searchDepthTopN: scope.summary.topN,
    },
  });
  assertClientSummaryPackGatesPass(clientSummaryPack);

  // Stage 5 — deterministic client summary composer (not wired to renderer).
  const composedClientSummary = composeClientSummary({ pack: clientSummaryPack });
  assertComposedSummaryGatesPass(composedClientSummary);

  // Stage 7 — filter-loss matrix + stop-gates.
  const surfaceMetricRows = Object.values(surfaceAnalyses).flatMap((sa) =>
    (sa.units ?? []).map((u) => {
      const adverse = u.metrics.find((m) => /adverse/i.test(m.key));
      const total = u.metrics.find((m) => /^(total|count|subjectMatch)/i.test(m.key));
      return {
        region: String(u.region ?? ""),
        status: adverse?.sampleStatus,
        adverseSharePercent: typeof adverse?.value === "number" ? adverse.value : null,
        totalCount:
          typeof total?.value === "number"
            ? total.value
            : typeof adverse?.denominator === "number"
              ? adverse.denominator
              : 0,
      };
    })
  );
  const filterLossMatrix = buildFilterLossMatrix({
    caseId: input.caseId,
    datasetId,
    sourceHashes,
    dispositionLedger,
    analyticsProvenance: composite.provenance,
    findings: synthesis.bundle.findings,
    kpiFindingIds: promotedFindingIds,
    coverageLimitations: executiveSummaryInput.dataGaps?.map((g) => g.detail) ?? [],
    surfaceMetricRows,
  });
  assertFilterLossGatesPass(filterLossMatrix);

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
  emit("observation-disposition-ledger.json", dispositionLedger);
  emit("disposition-summary.json", dispositionSummary);
  emit("canonical-claims.json", canonicalClaims);
  emit("canonical-claims-summary.json", canonicalClaimsSummary);
  emit("representative-evidence-selection.json", representative.selection);
  emit("representative-evidence-coverage.json", representative.coverage);
  emit("excluded-materiality-report.json", representative.excluded);
  emit("client-summary-pack.json", clientSummaryPack);
  emit("composed-client-summary.json", composedClientSummary);
  emit("filter-loss-matrix.json", filterLossMatrix);

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
    dispositionLedger,
    dispositionSummary,
    canonicalClaims,
    canonicalClaimsSummary,
    representativeEvidence: representative.selection,
    representativeCoverage: representative.coverage,
    excludedMateriality: representative.excluded,
    clientSummaryPack,
    composedClientSummary,
    filterLossMatrix,
    reportDataBinding,
    artifactPaths,
  };
}

export { domainOf };
