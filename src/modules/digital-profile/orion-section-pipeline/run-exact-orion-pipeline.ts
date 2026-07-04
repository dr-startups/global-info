import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadOrionBlueprint } from "./orion-blueprint";
import { buildMicroStageEvidencePack } from "./evidence-pack-builder";
import { analyzeMicroStageWithGpt55 } from "./gpt55-microstage-analyzer";
import { buildDeterministicMicrostageAnalysis } from "./deterministic-microstage-analysis";
import { buildMicroStageSlideManifest } from "./slide-manifest-builder";
import { composeFinalDeckManifest } from "./deck-composer";
import { runOrionConsistencyChecks } from "./consistency-checker";
import { createOrionPipelineStore, type OrionStoreMode } from "./persistence";
import {
  loadRealCaseContext,
  mapCaseDataToMicroStageInputs,
  type OrionMicroStageInput,
} from "./real-case-data-adapter";
import type {
  OrionGpt55SectionAnalysis,
  OrionMicroStage,
  OrionMicroStageRun,
  OrionPipelineRun,
  OrionRawEvidence,
  OrionSlideManifest,
} from "./types";

export interface RunExactOrionPipelineOptions {
  outputRoot?: string;
  locale?: "ru" | "en";
  reportJsonSeed?: Record<string, unknown>;
  renderMode?: "manifest_renderer_v1";
  renderSeedArtifactsFrom?: string;
  useRealCaseData?: boolean;
  r93Gpt55Validate?: boolean;
  storeMode?: OrionStoreMode;
}

const R93_GPT55_STAGE_KEYS = new Set([
  "executive_narrative_summary",
  "ru_audit_summary",
  "ru_search_links_overview",
  "uae_audit_summary",
  "compliance_risk_matrix",
  "lexisnexis_profile_overview",
  "compliance_database_summary_for_risk_matrix",
]);

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function safeArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function syntheticEvidenceFromSeed(stage: OrionMicroStage, seed?: Record<string, unknown>): OrionRawEvidence[] {
  const searchRows = safeArray(seed?.searchSurfaces ? (seed.searchSurfaces as Record<string, unknown>).rows : []);
  const fallbackRows = searchRows.length > 0 ? searchRows : [];
  if (fallbackRows.length > 0) {
    return fallbackRows.slice(0, 24).map((row, idx) => ({
      evidenceId: `${stage.microStageKey}-seed-${idx + 1}`,
      type: "search_result",
      source: String(row.provider ?? row.source ?? "seed"),
      title: String(row.title ?? ""),
      snippet: String(row.snippet ?? ""),
      domain: String(row.domain ?? ""),
      url: String(row.url ?? ""),
      query: String(row.query ?? ""),
      locale: String(row.language ?? "ru"),
      region: String(row.region ?? "RU"),
      classification: String(row.classification ?? "potential"),
      themeLabel: String(row.themeLabel ?? row.theme ?? ""),
      screenshotRef: typeof row.screenshotRef === "string" ? row.screenshotRef : undefined,
      visualRef: typeof row.visualRef === "string" ? row.visualRef : undefined,
    }));
  }

  return [
    {
      evidenceId: `${stage.microStageKey}-e1`,
      type: "search_result",
      source: "synthetic",
      title: `${stage.titleRu} — evidence item 1`,
      snippet: "Материал требует проверки по контексту совпадения.",
      domain: "example.com",
      url: "https://example.com/a",
      query: stage.microStageKey,
      locale: "ru",
      region: stage.macroSectionKey.includes("uae") ? "UAE" : "RU",
      classification: "requires_review",
      themeLabel: "Негативные публикации",
      screenshotRef: stage.microStageKey === "lexisnexis_visual_pages" ? undefined : `${stage.microStageKey}-shot-1`,
      visualRef: stage.microStageKey === "lexisnexis_visual_pages" ? undefined : `${stage.microStageKey}-visual-1`,
    },
    {
      evidenceId: `${stage.microStageKey}-e2`,
      type: "search_result",
      source: "synthetic",
      title: `${stage.titleRu} — evidence item 2`,
      snippet: "Потенциальный сигнал без подтверждения факта.",
      domain: "news.example.org",
      url: "https://news.example.org/b",
      query: stage.microStageKey,
      locale: "ru",
      region: stage.macroSectionKey.includes("uae") ? "UAE" : "RU",
      classification: "potential",
      themeLabel: "Требует ручной проверки",
      screenshotRef: stage.microStageKey === "lexisnexis_visual_pages" ? undefined : `${stage.microStageKey}-shot-2`,
      visualRef: stage.microStageKey === "lexisnexis_visual_pages" ? undefined : `${stage.microStageKey}-visual-2`,
    },
  ];
}

function initRunManifest(caseId: string): OrionPipelineRun {
  const now = new Date().toISOString();
  return {
    runId: `orion-r9-${Date.now()}`,
    caseId,
    mode: "orion_section_pipeline_v1",
    status: "planned",
    startedAt: now,
    warnings: [],
    errors: [],
  };
}

function initStageRun(runId: string, stage: OrionMicroStage): OrionMicroStageRun {
  return {
    runId,
    macroSectionKey: stage.macroSectionKey,
    microStageKey: stage.microStageKey,
    status: "planned",
    startedAt: new Date().toISOString(),
    agentRuns: stage.requiredAgents.map((agentName) => ({
      providerId: agentName.toLowerCase(),
      agentName,
      required: true,
      status: "planned",
    })),
    warnings: [],
    errors: [],
  };
}

function createStorageSkeleton(root: string, macroSectionKeys: string[], microStageKeys: string[]): void {
  ensureDir(root);
  ensureDir(join(root, "macro-sections"));
  ensureDir(join(root, "micro-stages"));
  ensureDir(join(root, "composed"));
  for (const key of macroSectionKeys) {
    ensureDir(join(root, "macro-sections", key));
  }
  for (const stage of microStageKeys) {
    ensureDir(join(root, "micro-stages", stage));
  }
}

function runR9Renderer(reportJsonPath: string, pptxOut: string, pdfOut: string, pagesOut: string): string | null {
  const result = spawnSync(
    "python",
    [
      "scripts/render-r9-manifest-artifacts.py",
      reportJsonPath,
      pptxOut,
      pdfOut,
      pagesOut,
    ],
    { cwd: process.cwd(), encoding: "utf-8" }
  );
  if (result.status !== 0) {
    return `r9-render-failed: ${result.stderr || result.stdout || "unknown"}`;
  }
  return null;
}

export async function runExactOrionPipeline(caseId: string, options: RunExactOrionPipelineOptions = {}) {
  const blueprint = loadOrionBlueprint();
  const run = initRunManifest(caseId);
  const root =
    options.outputRoot ??
    join(process.cwd(), "storage", "digital-profile", "qa-r9-0-exact-orion-section-pipeline");
  const macroSectionKeys = blueprint.macroSections
    .filter((s) => s.macroSectionKey !== "cover" && s.macroSectionKey !== "toc_global")
    .map((s, idx) => `${String(idx + 1).padStart(2, "0")}-${s.macroSectionKey.replace(/_/g, "-")}`);
  const microStages = blueprint.macroSections.flatMap((s) => s.microStages);
  const store = createOrionPipelineStore({ mode: options.storeMode });

  createStorageSkeleton(
    root,
    macroSectionKeys,
    microStages.map((s) => s.microStageKey)
  );
  await store.createRun({ caseId, reportRunId: run.runId, outputRoot: root, run });
  await store.saveBlueprint({
    caseId,
    reportRunId: run.runId,
    outputRoot: root,
    status: "ready",
    payloadJson: blueprint,
    metadataJson: { mode: blueprint.mode, version: blueprint.version },
    internalOnly: true,
  });
  for (const macro of blueprint.macroSections) {
    if (macro.macroSectionKey === "cover" || macro.macroSectionKey === "toc_global") continue;
    await store.saveMacroSection({
      caseId,
      reportRunId: run.runId,
      outputRoot: root,
      macroSectionKey: macro.macroSectionKey,
      orderIndex: macro.order,
      status: "planned",
      payloadJson: macro,
      metadataJson: { sectionNumber: macro.sectionNumber, titleRu: macro.titleRu },
    });
  }

  let microStageInputs: Record<string, OrionMicroStageInput> = {};
  let realSubject: { fullName: string; aliases: string[] } | null = null;
  if (options.useRealCaseData !== false) {
    try {
      const realContext = await loadRealCaseContext(caseId, {
        locale: options.locale ?? "ru",
      });
      realSubject = realContext.subject;
      microStageInputs = mapCaseDataToMicroStageInputs(realContext, blueprint);
      await store.writeArtifact(join(root, "real-case-context-inspection.json"), {
        caseId: realContext.caseId,
        locale: realContext.locale,
        subject: realContext.subject,
        targetRegions: realContext.targetRegions,
        searchResults: realContext.searchResults.length,
        searchSurfaces: realContext.searchSurfaces.length,
        databaseProfiles: realContext.databaseProfiles.length,
        riskFindings: realContext.riskFindings.length,
        wikiChecks: realContext.wikiChecks.length,
        providerAvailability: realContext.providerAvailability,
        lexis: realContext.lexis,
      });
      await store.writeArtifact(join(root, "micro-stage-mapping-inspection.json"), {
        stageCount: Object.keys(microStageInputs).length,
        mappedStages: Object.values(microStageInputs).map((x) => ({
          microStageKey: x.microStageKey,
          macroSectionKey: x.macroSectionKey,
          rawEvidenceCount: x.rawEvidence.length,
          visualEvidenceCount: x.visualEvidence.length,
          complianceEvidenceCount: x.complianceEvidence.length,
          lexisEvidenceCount: x.lexisEvidence.length,
          resultCounts: x.resultCounts,
        })),
      });
    } catch (error) {
      run.warnings.push(`real-case-adapter-unavailable:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const stageRuns: OrionMicroStageRun[] = [];
  const analyses: OrionGpt55SectionAnalysis[] = [];
  const slideManifests: OrionSlideManifest[] = [];
  const gptInspectionRows: Array<{
    microStageKey: string;
    selectedForGpt55: boolean;
    generatedBy: string;
    status: string;
    provider: string;
    model: string;
    reason?: string;
    evidenceItemsUsed: number;
    truncatedInput: boolean;
    retries: number;
  }> = [];

  const r93GptEnabled = options.r93Gpt55Validate ?? process.env.R9_3_GPT55_VALIDATE === "true";

  run.status = "collecting";
  for (const stage of microStages.sort((a, b) => a.order - b.order)) {
    const stageRun = initStageRun(run.runId, stage);
    stageRuns.push(stageRun);
    const stageDir = join(root, "micro-stages", stage.microStageKey);

    try {
      stageRun.status = "collecting";
      const stageInput = microStageInputs[stage.microStageKey];
      const raw = (stageInput?.rawEvidence?.length ?? 0) > 0
        ? stageInput.rawEvidence
        : syntheticEvidenceFromSeed(stage, options.reportJsonSeed);
      await store.saveRawEvidence({
        caseId,
        reportRunId: run.runId,
        outputRoot: root,
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        orderIndex: stage.order,
        status: stageRun.status,
        payloadJson: raw,
      });

      stageRun.status = "normalizing";
      const lexisVisualPageCount = raw.filter((x) => x.type === "lexis_visual_page").length;
      const packed = buildMicroStageEvidencePack({
        microStage: stage,
        subject: {
          fullName: String(
            (options.reportJsonSeed?.subject as { fullName?: string } | undefined)?.fullName ??
              realSubject?.fullName ??
              "Unknown subject"
          ),
          aliases: realSubject?.aliases ?? [],
        },
        locale: options.locale ?? "ru",
        region: stage.macroSectionKey.includes("uae") ? "UAE" : "RU",
        rawEvidence: raw,
        sourceAvailability: stageInput?.providerAvailability,
        sourceProvidersUsed: [
          ...new Set(
            raw
              .map((x) => String(x.source ?? "").trim())
              .filter(Boolean)
          ),
        ],
        queryVariants: stageInput?.queryVariants,
        resultCounts: stageInput?.resultCounts,
        maxItems:
          stage.microStageKey === "lexisnexis_visual_pages" && lexisVisualPageCount > 0
            ? Math.max(lexisVisualPageCount, 200)
            : undefined,
      });
      await store.saveNormalizedEvidence({
        caseId,
        reportRunId: run.runId,
        outputRoot: root,
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        orderIndex: stage.order,
        status: "normalized",
        payloadJson: packed.normalized,
      });

      stageRun.status = "selected";
      await store.saveSelectedEvidence({
        caseId,
        reportRunId: run.runId,
        outputRoot: root,
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        orderIndex: stage.order,
        status: "selected",
        payloadJson: packed.selected,
      });
      await store.saveExcludedEvidence({
        caseId,
        reportRunId: run.runId,
        outputRoot: root,
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        orderIndex: stage.order,
        status: "selected",
        payloadJson: packed.excluded,
      });

      stageRun.status = "building_evidence_pack";
      await store.saveEvidencePack({
        caseId,
        reportRunId: run.runId,
        outputRoot: root,
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        orderIndex: stage.order,
        status: "evidence_pack_ready",
        payloadJson: packed.evidencePack,
      });
      await store.saveEvidenceFile({
        caseId,
        reportRunId: run.runId,
        outputRoot: root,
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        orderIndex: stage.order,
        status: "ready",
        payloadJson: packed.evidencePack.topResults
          .filter((x) => x.visualRef || x.screenshotRef)
          .map((x) => ({
            safeEvidenceId: x.safeEvidenceId,
            visualRef: x.visualRef,
            screenshotRef: x.screenshotRef,
          })),
      });

      stageRun.status = "analyzing";
      const deterministic = buildDeterministicMicrostageAnalysis({ microStage: stage, evidencePack: packed.evidencePack });
      await store.writeArtifact(join(stageDir, "deterministic-analysis.json"), deterministic);
      const selectedForGpt55 = r93GptEnabled && R93_GPT55_STAGE_KEYS.has(stage.microStageKey);
      let retries = 0;
      let finalAnalysis = deterministic;
      let diagnostics: { provider: "openai" | "none"; model: string; status: "ready" | "fallback" | "unavailable"; reason?: string } = {
        provider: "none",
        model: "gpt-5.5",
        status: "fallback",
        reason: selectedForGpt55 ? "gpt-runtime-skipped" : "stage-not-selected",
      };
      if (selectedForGpt55) {
        const first = await analyzeMicroStageWithGpt55({ microStage: stage, evidencePack: packed.evidencePack });
        finalAnalysis = first.analysis;
        diagnostics = first.diagnostics;
        if (first.diagnostics.status !== "ready") {
          retries = 1;
          const second = await analyzeMicroStageWithGpt55({ microStage: stage, evidencePack: packed.evidencePack });
          finalAnalysis = second.analysis;
          diagnostics = second.diagnostics;
        }
      }
      await store.writeArtifact(join(stageDir, "gpt55-analysis.json"), selectedForGpt55 ? finalAnalysis : deterministic);
      await store.saveSectionAnalysis({
        caseId,
        reportRunId: run.runId,
        outputRoot: root,
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        orderIndex: stage.order,
        status: finalAnalysis.status,
        payloadJson: finalAnalysis,
      });
      analyses.push(finalAnalysis);
      gptInspectionRows.push({
        microStageKey: stage.microStageKey,
        selectedForGpt55,
        generatedBy: finalAnalysis.generatedBy,
        status: finalAnalysis.status,
        provider: diagnostics.provider,
        model: diagnostics.model,
        reason: diagnostics.reason,
        evidenceItemsUsed: packed.evidencePack.topResults.length,
        truncatedInput: packed.evidencePack.topResults.length > 40,
        retries,
      });

      stageRun.status = "building_slide_manifest";
      const manifest = buildMicroStageSlideManifest({ microStage: stage, analysis: finalAnalysis });
      await store.saveSlideManifest({
        caseId,
        reportRunId: run.runId,
        outputRoot: root,
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        orderIndex: stage.order,
        status: "slide_manifest_ready",
        payloadJson: manifest,
      });
      slideManifests.push(manifest);
      stageRun.status = "slide_manifest_ready";

      await store.saveMicroStage({
        caseId,
        reportRunId: run.runId,
        outputRoot: root,
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        orderIndex: stage.order,
        status: stageRun.status,
        payloadJson: {
        microStageKey: stage.microStageKey,
        status: stageRun.status,
        gpt55: {
          selectedForGpt55,
          generatedBy: finalAnalysis.generatedBy,
          status: finalAnalysis.status,
          diagnostics,
          retries,
        },
        warnings: [...stageRun.warnings, ...finalAnalysis.warnings],
        },
      });
      for (const agent of stageRun.agentRuns) {
        await store.saveAgentRun({
          caseId,
          reportRunId: run.runId,
          outputRoot: root,
          microStageKey: stage.microStageKey,
          macroSectionKey: stage.macroSectionKey,
          orderIndex: stage.order,
          status: agent.status,
          payloadJson: agent,
          metadataJson: { providerId: agent.providerId, agentName: agent.agentName, reason: agent.reason },
        });
      }
    } catch (error) {
      stageRun.status = "failed";
      stageRun.errors.push(error instanceof Error ? error.message : "unknown-stage-error");
      await store.saveMicroStage({
        caseId,
        reportRunId: run.runId,
        outputRoot: root,
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        orderIndex: stage.order,
        status: "failed",
        payloadJson: {
        microStageKey: stage.microStageKey,
        status: "failed",
        errors: stageRun.errors,
        },
      });
      run.errors.push(`stage-failed:${stage.microStageKey}`);
    } finally {
      stageRun.finishedAt = new Date().toISOString();
    }
  }

  run.status = "composed";
  const composed = composeFinalDeckManifest({
    runId: run.runId,
    blueprint,
    slideManifests,
  });

  const finalReportJsonInternal = {
    reportMode: "orion_section_pipeline_v1",
    orionBlueprintVersion: "r9.3",
    meta: {
      mode: blueprint.mode,
      runId: run.runId,
      generatedAt: new Date().toISOString(),
      language: options.locale ?? "ru",
    },
    subject: {
      fullName: String((options.reportJsonSeed?.subject as { fullName?: string } | undefined)?.fullName ?? realSubject?.fullName ?? "Unknown subject"),
      aliases: realSubject?.aliases ?? [],
    },
    toc: {
      entries: composed.finalManifest.tocEntries,
      coverPage: composed.compositionInspection.coverPage,
      globalTocPage: composed.compositionInspection.globalTocPage,
    },
    macroSections: composed.finalManifest.sections.map((s) => ({
      macroSectionKey: s.macroSectionKey,
      sectionNumber: s.sectionNumber,
      titleRu: s.titleRu,
      sectionStartPage: s.sectionStartPage,
    })),
    microStages: slideManifests.map((m) => ({
      microStageKey: m.microStageKey,
      macroSectionKey: m.macroSectionKey,
      order: m.order,
      slideCount: m.slides.length,
    })),
    microStageManifests: slideManifests,
    finalDeckManifest: composed.finalManifest,
    compositionInspection: composed.compositionInspection,
    clientPolicy: {
      status: "PENDING",
      violations: [],
    },
    sections: {
      executive: analyses.filter((a) => a.macroSectionKey === "executive"),
      ruProfile: analyses.filter((a) => a.macroSectionKey === "ru_profile"),
      uaeProfile: analyses.filter((a) => a.macroSectionKey === "uae_profile"),
      complianceDatabases: analyses.filter((a) => a.macroSectionKey === "compliance_databases"),
      offer: analyses.filter((a) => a.macroSectionKey === "offer"),
      about: analyses.filter((a) => a.macroSectionKey === "about"),
    },
    orionFinalDeckManifest: composed.finalManifest,
    sectionAnalyses: analyses,
  };
  const finalReportJsonClient = JSON.parse(JSON.stringify(finalReportJsonInternal)) as Record<string, unknown>;
  delete (finalReportJsonClient.meta as Record<string, unknown>)?.runId;
  const clientAnalyses = ((finalReportJsonClient.sectionAnalyses as unknown[]) ?? []).map((row) => {
    const copy = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
    delete copy.generatedBy;
    delete copy.status;
    delete copy.warnings;
    return copy;
  });
  finalReportJsonClient.sectionAnalyses = clientAnalyses;
  finalReportJsonClient.sections = {
    executive: clientAnalyses.filter((a) => String((a as Record<string, unknown>).macroSectionKey ?? "") === "executive"),
    ruProfile: clientAnalyses.filter((a) => String((a as Record<string, unknown>).macroSectionKey ?? "") === "ru_profile"),
    uaeProfile: clientAnalyses.filter((a) => String((a as Record<string, unknown>).macroSectionKey ?? "") === "uae_profile"),
    complianceDatabases: clientAnalyses.filter(
      (a) => String((a as Record<string, unknown>).macroSectionKey ?? "") === "compliance_databases"
    ),
    offer: clientAnalyses.filter((a) => String((a as Record<string, unknown>).macroSectionKey ?? "") === "offer"),
    about: clientAnalyses.filter((a) => String((a as Record<string, unknown>).macroSectionKey ?? "") === "about"),
  };
  finalReportJsonClient.clientPolicy = {
    status: "PASS",
    note: "Internal diagnostics and model/provider details are removed in client payload.",
  };

  const consistencyInspection = runOrionConsistencyChecks({
    finalDeckManifest: composed.finalManifest,
    slideManifests,
    analyses,
    clientReportJson: finalReportJsonClient,
    reportLanguage: options.locale ?? "ru",
  });
  (finalReportJsonInternal.clientPolicy as Record<string, unknown>).status =
    consistencyInspection.violations.filter((x) => x.section === "client-policy").length === 0
      ? "PASS"
      : "BLOCKED";
  (finalReportJsonInternal.clientPolicy as Record<string, unknown>).violations =
    consistencyInspection.violations.filter((x) => x.section === "client-policy");

  const composedDir = join(root, "composed");
  ensureDir(composedDir);
  await store.saveFinalDeckManifest({
    caseId,
    reportRunId: run.runId,
    outputRoot: root,
    status: "ready",
    payloadJson: composed.finalManifest,
  });
  const internalJsonPath = join(composedDir, "final-report-json-internal.json");
  const clientJsonPath = join(composedDir, "final-report-json-client.json");
  await store.saveReportJsonVersion({
    caseId,
    reportRunId: run.runId,
    outputRoot: root,
    status: "ready",
    audience: "internal",
    internalOnly: true,
    payloadJson: finalReportJsonInternal,
  });
  await store.saveReportJsonVersion({
    caseId,
    reportRunId: run.runId,
    outputRoot: root,
    status: "ready",
    audience: "client",
    internalOnly: false,
    payloadJson: finalReportJsonClient,
  });
  await store.writeArtifact(join(composedDir, "composition-inspection.json"), composed.compositionInspection);
  await store.saveConsistencyCheck({
    caseId,
    reportRunId: run.runId,
    outputRoot: root,
    status: consistencyInspection.status,
    payloadJson: consistencyInspection,
  });
  await store.writeArtifact(join(composedDir, "client-policy-inspection.json"), {
    status:
      consistencyInspection.violations.filter((x) => x.section === "client-policy").length === 0
        ? "PASS"
        : "BLOCKED",
    violations: consistencyInspection.violations.filter((x) => x.section === "client-policy"),
  });
  await store.writeArtifact(join(root, "gpt55-narrative-inspection.json"), {
    enabled: r93GptEnabled,
    selectedStages: [...R93_GPT55_STAGE_KEYS],
    rows: gptInspectionRows,
    summary: {
      totalStages: gptInspectionRows.length,
      selected: gptInspectionRows.filter((x) => x.selectedForGpt55).length,
      ready: gptInspectionRows.filter((x) => x.selectedForGpt55 && x.generatedBy === "gpt-5.5").length,
      fallback: gptInspectionRows.filter((x) => x.generatedBy !== "gpt-5.5").length,
      skipped: gptInspectionRows.filter((x) => !x.selectedForGpt55).length,
    },
  });

  const legacyReportPath = join(process.cwd(), "storage", "digital-profile", "qa-r8-3-gpt55-analyst-narrative", "report-json-ru-internal.json");
  let legacySummary: Record<string, unknown> = {};
  try {
    const legacy = JSON.parse(readFileSync(legacyReportPath, "utf-8")) as Record<string, unknown>;
    legacySummary = {
      pageCount: Number((legacy as { dynamicPages?: unknown[] }).dynamicPages?.length ?? 0),
      hasCompliance: Boolean((legacy as Record<string, unknown>).complianceSummary),
      hasLexis: Boolean((legacy as Record<string, unknown>).lexisNexisHybrid),
    };
  } catch {
    legacySummary = { status: "legacy-report-json-unavailable" };
  }
  await store.writeArtifact(join(composedDir, "r7-r9-comparison-inspection.json"), {
    legacy: legacySummary,
    r9: {
      pageCountInternal: composed.compositionInspection.finalInternalPageCount,
      pageCountClient: composed.compositionInspection.finalClientPageCount,
      sections: composed.finalManifest.sections.map((s) => s.macroSectionKey),
      lexisVisualPages: composed.compositionInspection.lexisNexisVisualPageCount,
      missingMicroStages: composed.compositionInspection.missingMicroStages,
      clientPolicyViolations: consistencyInspection.violations.filter((x) => x.section === "client-policy").length,
      contradictions: consistencyInspection.violations.filter((x) => x.section === "consistency").length,
    },
    blockingReasons: [
      ...(consistencyInspection.violations.filter((x) => x.section === "client-policy").length > 0 ? ["client-policy"] : []),
      ...(composed.compositionInspection.missingMicroStages.length > 0 ? ["missing-orion-sections"] : []),
      ...(consistencyInspection.violations.filter((x) => x.section === "consistency").length > 0 ? ["consistency-contradictions"] : []),
    ],
    status:
      consistencyInspection.violations.filter((x) => x.section === "client-policy").length > 0 ||
      composed.compositionInspection.missingMicroStages.length > 0 ||
      consistencyInspection.violations.filter((x) => x.section === "consistency").length > 0
        ? "BLOCKED"
        : "PASS",
  });

  const internalPptx = join(composedDir, "final-report-v17-ru-internal-draft.pptx");
  const internalPdf = join(composedDir, "final-report-v17-ru-internal-draft.pdf");
  const internalPages = join(composedDir, "pages-pdf");
  const clientPptx = join(composedDir, "final-report-v17-ru-client.pptx");
  const clientPdf = join(composedDir, "final-report-v17-ru-client.pdf");
  const clientPages = join(composedDir, "client-pages-pdf");
  ensureDir(internalPages);
  ensureDir(clientPages);

  const internalRenderError = runR9Renderer(internalJsonPath, internalPptx, internalPdf, internalPages);
  if (internalRenderError) run.warnings.push(internalRenderError);
  const clientRenderError = runR9Renderer(clientJsonPath, clientPptx, clientPdf, clientPages);
  if (clientRenderError) run.warnings.push(clientRenderError);

  await store.writeArtifact(join(root, "run-manifest.json"), {
    ...run,
    status: consistencyInspection.status === "PASS" ? "composed" : "failed",
    finishedAt: new Date().toISOString(),
  });

  // keep filesystem mapping documentation for future DB migration.
  await store.writeArtifact(join(root, "supabase-schema-plan.json"), {
    mode: blueprint.mode,
    generatedAt: new Date().toISOString(),
    mapping: {
      report_runs: "run-manifest.json",
      report_macro_sections: "blueprint.json + composed/final-deck-manifest.json",
      report_micro_stages: "micro-stages/*/stage-inspection.json",
      section_agent_runs: "micro-stages/*/stage-inspection.json.agentRuns",
      raw_evidence: "micro-stages/*/raw-evidence.json",
      normalized_evidence: "micro-stages/*/normalized-evidence.json",
      selected_evidence: "micro-stages/*/selected-evidence.json",
      excluded_evidence: "micro-stages/*/excluded-evidence.json",
      evidence_files: "composed/pages-pdf/*.png + composed/client-pages-pdf/*.png",
      section_evidence_packs: "micro-stages/*/evidence-pack.json",
      section_analysis: "micro-stages/*/final-analysis.json",
      section_slide_manifests: "micro-stages/*/slide-manifest.json",
      final_deck_manifests: "composed/final-deck-manifest.json",
      report_json_versions: "composed/final-report-json-internal.json + composed/final-report-json-client.json",
      report_consistency_checks: "composed/consistency-inspection.json",
    },
  });

  return {
    run,
    blueprint,
    stageRuns,
    slideManifests,
    analyses,
    finalManifest: composed.finalManifest,
    compositionInspection: composed.compositionInspection,
    consistencyInspection,
    outputRoot: root,
  };
}

