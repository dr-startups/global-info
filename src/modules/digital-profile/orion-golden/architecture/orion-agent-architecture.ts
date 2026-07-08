/**
 * R10 — 3-layer ORION Golden agent architecture definitions.
 */

export type AgentLayerId = "collection" | "filtering" | "report_assembly";

export interface AgentDefinition {
  agentKey: string;
  layer: AgentLayerId;
  title: string;
  purpose: string;
  inputContract: string[];
  outputContract: string[];
  storageTargets: string[];
  qaChecks: string[];
}

export interface AgentLayerDefinition {
  layerId: AgentLayerId;
  title: string;
  purpose: string;
  rules: string[];
  agents: AgentDefinition[];
}

const collectionAgents: AgentDefinition[] = [
  {
    agentKey: "yandexSearchCollector",
    layer: "collection",
    title: "Yandex Search Collector",
    purpose: "Collect Yandex organic search rows without aggressive filtering.",
    inputContract: ["caseId", "reportRunId", "searchQueries"],
    outputContract: ["orion_raw_evidence", "orion_raw_assets"],
    storageTargets: ["orion_raw_evidence", "orion_raw_assets", "orion_agent_runs"],
    qaChecks: ["raw-item-has-source-metadata", "no-data-discarded-at-collection"],
  },
  {
    agentKey: "googleSearchCollector",
    layer: "collection",
    title: "Google Search Collector",
    purpose: "Collect Google organic search rows.",
    inputContract: ["caseId", "reportRunId", "searchQueries"],
    outputContract: ["orion_raw_evidence"],
    storageTargets: ["orion_raw_evidence", "orion_agent_runs"],
    qaChecks: ["raw-item-has-source-metadata"],
  },
  {
    agentKey: "serperSearchCollector",
    layer: "collection",
    title: "Serper Search Collector",
    purpose: "Collect Serper-backed search snapshots when configured.",
    inputContract: ["caseId", "reportRunId"],
    outputContract: ["orion_raw_evidence", "orion_raw_assets"],
    storageTargets: ["orion_raw_evidence", "orion_agent_runs"],
    qaChecks: ["provider-availability-recorded"],
  },
  {
    agentKey: "wikipediaCollector",
    layer: "collection",
    title: "Wikipedia Collector",
    purpose: "Collect Wikipedia existence checks and page metadata.",
    inputContract: ["caseId", "subject"],
    outputContract: ["orion_raw_evidence"],
    storageTargets: ["orion_raw_evidence"],
    qaChecks: ["wiki-row-present-or-marked-absent"],
  },
  {
    agentKey: "imageSearchCollector",
    layer: "collection",
    title: "Image Search Collector",
    purpose: "Collect image surface items (Yandex/Google).",
    inputContract: ["caseId", "searchSurfaces"],
    outputContract: ["orion_raw_evidence", "orion_raw_assets"],
    storageTargets: ["orion_raw_evidence", "orion_raw_assets"],
    qaChecks: ["image-url-or-unavailable-card"],
  },
  {
    agentKey: "videoSearchCollector",
    layer: "collection",
    title: "Video Search Collector",
    purpose: "Collect video surface items.",
    inputContract: ["caseId", "searchSurfaces"],
    outputContract: ["orion_raw_evidence"],
    storageTargets: ["orion_raw_evidence"],
    qaChecks: ["video-card-metadata"],
  },
  {
    agentKey: "knowledgePanelCollector",
    layer: "collection",
    title: "Knowledge Panel Collector",
    purpose: "Collect knowledge panel blocks.",
    inputContract: ["caseId", "searchSurfaces"],
    outputContract: ["orion_raw_evidence"],
    storageTargets: ["orion_raw_evidence"],
    qaChecks: ["knowledge-panel-or-no-data"],
  },
  {
    agentKey: "lexisNexisImportCollector",
    layer: "collection",
    title: "LexisNexis Import Collector",
    purpose: "Collect Lexis parsed signals and visual pages.",
    inputContract: ["caseId", "databaseProfiles"],
    outputContract: ["orion_raw_evidence", "orion_raw_assets"],
    storageTargets: ["orion_raw_evidence", "orion_raw_assets"],
    qaChecks: ["lexis-upload-or-unavailable"],
  },
  {
    agentKey: "dowJonesWorldCheckImportCollector",
    layer: "collection",
    title: "Dow Jones / World-Check Collector",
    purpose: "Collect compliance database profile hits.",
    inputContract: ["caseId", "databaseProfiles"],
    outputContract: ["orion_raw_evidence"],
    storageTargets: ["orion_raw_evidence"],
    qaChecks: ["compliance-hit-metadata"],
  },
  {
    agentKey: "manualUploadCollector",
    layer: "collection",
    title: "Manual Upload Collector",
    purpose: "Collect manually uploaded evidence files.",
    inputContract: ["caseId", "evidenceFiles"],
    outputContract: ["orion_raw_evidence", "orion_raw_assets"],
    storageTargets: ["orion_raw_evidence", "orion_raw_assets"],
    qaChecks: ["manual-upload-metadata"],
  },
  {
    agentKey: "screenshotCollector",
    layer: "collection",
    title: "Screenshot Collector",
    purpose: "Collect SERP screenshots and case screenshots.",
    inputContract: ["caseId", "serpSnapshots", "screenshots"],
    outputContract: ["orion_raw_assets"],
    storageTargets: ["orion_raw_assets"],
    qaChecks: ["serp-screenshot-embedded-in-render"],
  },
];

const filteringAgents: AgentDefinition[] = [
  {
    agentKey: "normalizerAgent",
    layer: "filtering",
    title: "Normalizer Agent",
    purpose: "Normalize titles, snippets, domains, URLs, languages.",
    inputContract: ["orion_raw_evidence"],
    outputContract: ["orion_normalized_evidence"],
    storageTargets: ["orion_normalized_evidence"],
    qaChecks: ["no-raw-ids-in-client-fields"],
  },
  {
    agentKey: "deduplicationAgent",
    layer: "filtering",
    title: "Deduplication Agent",
    purpose: "Detect duplicates by URL/domain/title; never delete, mark duplicate.",
    inputContract: ["orion_normalized_evidence"],
    outputContract: ["orion_evidence_decisions"],
    storageTargets: ["orion_evidence_decisions"],
    qaChecks: ["duplicate-count-recorded"],
  },
  {
    agentKey: "entityMatchAgent",
    layer: "filtering",
    title: "Entity Match Agent",
    purpose: "Score subject/alias/organization match.",
    inputContract: ["subject", "orion_normalized_evidence"],
    outputContract: ["orion_evidence_decisions"],
    storageTargets: ["orion_evidence_decisions"],
    qaChecks: ["entity-match-score-present"],
  },
  {
    agentKey: "relevanceClassifierAgent",
    layer: "filtering",
    title: "Relevance Classifier",
    purpose: "Classify relevance and noise; store decisions with reasons.",
    inputContract: ["orion_normalized_evidence", "subject"],
    outputContract: ["orion_evidence_decisions", "orion_excluded_evidence"],
    storageTargets: ["orion_evidence_decisions", "orion_excluded_evidence"],
    qaChecks: ["excluded-items-counted", "marketplace-noise-excluded"],
  },
  {
    agentKey: "noiseFilterAgent",
    layer: "filtering",
    title: "Noise Filter Agent",
    purpose: "Apply marketplace/product/login noise rules.",
    inputContract: ["orion_evidence_decisions"],
    outputContract: ["orion_excluded_evidence"],
    storageTargets: ["orion_excluded_evidence"],
    qaChecks: ["noise-not-in-key-findings"],
  },
  {
    agentKey: "riskClassifierAgent",
    layer: "filtering",
    title: "Risk Classifier Agent",
    purpose: "Assign risk theme/level without legal conclusions.",
    inputContract: ["orion_normalized_evidence", "riskFindings"],
    outputContract: ["orion_evidence_decisions"],
    storageTargets: ["orion_evidence_decisions"],
    qaChecks: ["preliminary-framing-only"],
  },
  {
    agentKey: "sourceQualityAgent",
    layer: "filtering",
    title: "Source Quality Agent",
    purpose: "Score source reliability and coverage gaps.",
    inputContract: ["orion_normalized_evidence", "providerAvailability"],
    outputContract: ["orion_section_evidence_packs.metrics"],
    storageTargets: ["orion_section_evidence_packs"],
    qaChecks: ["missing-sources-listed"],
  },
  {
    agentKey: "sectionRouterAgent",
    layer: "filtering",
    title: "Section Router Agent",
    purpose: "Route evidence into ORION sections with per-section budgets.",
    inputContract: ["fullEvidenceInventory", "orion_golden_blueprint"],
    outputContract: ["orion_section_evidence_packs"],
    storageTargets: ["orion_section_evidence_packs", "orion_selected_evidence"],
    qaChecks: ["all-search-results-accounted", "no-global-slice-20"],
  },
  {
    agentKey: "evidencePackBuilderAgent",
    layer: "filtering",
    title: "Evidence Pack Builder",
    purpose: "Build section packs: display subset + full analysis metrics.",
    inputContract: ["routedEvidence", "sectionBudgets"],
    outputContract: ["orion_section_evidence_packs"],
    storageTargets: ["orion_section_evidence_packs", "orion_selected_evidence"],
    qaChecks: ["display-vs-analysis-counts"],
  },
];

const assemblyAgents: AgentDefinition[] = [
  {
    agentKey: "gptSectionAnalysisAgent",
    layer: "report_assembly",
    title: "GPT Section Analysis Agent",
    purpose: "GPT-5.5 section narratives from evidence packs (strict JSON).",
    inputContract: ["sectionEvidencePack", "sectionBlueprint"],
    outputContract: ["orion_section_analyses"],
    storageTargets: ["orion_section_analyses"],
    qaChecks: ["gpt-5.5-required", "no-raw-ids", "plain-russian"],
  },
  {
    agentKey: "gptExecutiveSynthesisAgent",
    layer: "report_assembly",
    title: "GPT Executive Synthesis Agent",
    purpose: "Executive summary + risk matrix AFTER all section analyses.",
    inputContract: ["allSectionAnalyses", "metrics"],
    outputContract: ["executiveSynthesis"],
    storageTargets: ["orion_section_analyses"],
    qaChecks: ["executive-after-body-sections"],
  },
  {
    agentKey: "gptRecommendationAgent",
    layer: "report_assembly",
    title: "GPT Recommendation Agent",
    purpose: "Final recommendations and next steps.",
    inputContract: ["executiveSynthesis", "sectionAnalyses"],
    outputContract: ["orion_report_specs.recommendations"],
    storageTargets: ["orion_report_specs"],
    qaChecks: ["actionable-recommendations"],
  },
  {
    agentKey: "reportSpecBuilderAgent",
    layer: "report_assembly",
    title: "ReportSpec Builder",
    purpose: "Build single ORION ReportSpec JSON for renderer.",
    inputContract: ["sectionAnalyses", "assets", "executiveSynthesis"],
    outputContract: ["orion_report_specs"],
    storageTargets: ["orion_report_specs"],
    qaChecks: ["report-spec-schema-valid"],
  },
  {
    agentKey: "orionTemplateRendererAgent",
    layer: "report_assembly",
    title: "ORION Template Renderer",
    purpose: "Deterministic PPTX/PDF from ReportSpec (no GPT layout).",
    inputContract: ["orion_report_specs"],
    outputContract: ["orion_render_artifacts"],
    storageTargets: ["orion_render_artifacts"],
    qaChecks: ["page-count-target", "serp-visible", "no-overlap"],
  },
  {
    agentKey: "pdfPptxExportAgent",
    layer: "report_assembly",
    title: "PDF/PPTX Export Agent",
    purpose: "Export client PDF/PPTX and page PNGs.",
    inputContract: ["renderArtifacts"],
    outputContract: ["rendered-client.pdf", "rendered-client.pptx"],
    storageTargets: ["orion_render_artifacts"],
    qaChecks: ["pdf-not-tiny", "libreoffice-mode"],
  },
  {
    agentKey: "clientQualityQaAgent",
    layer: "report_assembly",
    title: "Client Quality QA Agent",
    purpose: "Policy, structure, visual, routing QA gates.",
    inputContract: ["allArtifacts"],
    outputContract: ["orion_quality_checks"],
    storageTargets: ["orion_quality_checks"],
    qaChecks: ["qa-summary-verdict"],
  },
];

export const COLLECTION_LAYER: AgentLayerDefinition = {
  layerId: "collection",
  title: "Information Collection Agents",
  purpose: "Collect maximum raw data from all available sources without aggressive filtering.",
  rules: [
    "Do not filter aggressively during collection.",
    "Do not discard data.",
    "Store raw payloads safely with source metadata.",
    "Every raw item must include caseId, reportRunId, source, provider, region, collectedAt.",
  ],
  agents: collectionAgents,
};

export const FILTERING_LAYER: AgentLayerDefinition = {
  layerId: "filtering",
  title: "Information Filtering / Intelligence Agents",
  purpose: "Normalize, classify, filter, rank, and route evidence into report sections.",
  rules: [
    "Filtering must not delete data.",
    "Create selected/excluded decisions with reasons.",
    "Per-section evidence budgets — no global slice(0,20).",
    "Analysis agents see full section counts; slides show top N.",
  ],
  agents: filteringAgents,
};

export const REPORT_ASSEMBLY_LAYER: AgentLayerDefinition = {
  layerId: "report_assembly",
  title: "Presentation / Report Assembly Agents",
  purpose: "GPT analysis + deterministic ORION template rendering.",
  rules: [
    "GPT writes section analysis JSON only — not slides/PPTX directly.",
    "Renderer owns visual layout.",
    "Executive summary generated last, inserted first.",
    "Real-case generation BLOCKED_GPT if OpenAI unavailable.",
  ],
  agents: assemblyAgents,
};

export const ORION_GOLDEN_ARCHITECTURE = {
  version: "r10-orion-3-agent-architecture-v1",
  layers: [COLLECTION_LAYER, FILTERING_LAYER, REPORT_ASSEMBLY_LAYER],
  storageTables: [
    "orion_report_runs",
    "orion_agent_runs",
    "orion_raw_evidence",
    "orion_raw_assets",
    "orion_normalized_evidence",
    "orion_evidence_decisions",
    "orion_selected_evidence",
    "orion_excluded_evidence",
    "orion_section_evidence_packs",
    "orion_section_analyses",
    "orion_report_specs",
    "orion_render_artifacts",
    "orion_quality_checks",
  ],
} as const;

export function listAllGoldenAgents(): AgentDefinition[] {
  return [
    ...COLLECTION_LAYER.agents,
    ...FILTERING_LAYER.agents,
    ...REPORT_ASSEMBLY_LAYER.agents,
  ];
}
