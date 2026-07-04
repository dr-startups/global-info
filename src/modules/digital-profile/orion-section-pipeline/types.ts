export type OrionPipelineMode = "orion_section_pipeline_v1";

export type OrionLifecycleStatus =
  | "planned"
  | "collecting"
  | "collected"
  | "normalizing"
  | "normalized"
  | "selecting"
  | "selected"
  | "building_evidence_pack"
  | "evidence_pack_ready"
  | "analyzing"
  | "analyzed"
  | "building_slide_manifest"
  | "slide_manifest_ready"
  | "rendering_section"
  | "section_rendered"
  | "composed"
  | "failed";

export type OrionAnalysisItemStatus =
  | "confirmed"
  | "undesirable"
  | "potential"
  | "requires_review"
  | "excluded_noise"
  | "absent"
  | "wrong_subject";

export interface OrionOutputContract {
  requiredFields: string[];
  clientSafe: boolean;
  internalNotesAllowed: boolean;
}

export interface OrionQaCheckDefinition {
  id: string;
  description: string;
  severity: "P0" | "P1" | "P2";
}

export interface OrionDataNeeds {
  include: string[];
  exclude: string[];
  constraints: string[];
}

export interface OrionMicroStage {
  microStageKey: string;
  macroSectionKey: string;
  sectionNumber: string | null;
  titleRu: string;
  order: number;
  expectedSlideCountMin: number;
  expectedSlideCountMax: number;
  dataNeeds: OrionDataNeeds;
  requiredAgents: string[];
  requiresGpt55Analysis: boolean;
  requiresEvidence: boolean;
  requiresVisualEvidence: boolean;
  slideTemplateKey: string;
  outputContract: OrionOutputContract;
  qaChecks: OrionQaCheckDefinition[];
}

export interface OrionMacroSection {
  macroSectionKey: string;
  sectionNumber: string | null;
  titleRu: string;
  order: number;
  slideType: string;
  hasSectionToc: boolean;
  computedAfterComposition?: boolean;
  microStages: OrionMicroStage[];
}

export interface OrionBlueprint {
  mode: OrionPipelineMode;
  version: string;
  generatedAt: string;
  macroSections: OrionMacroSection[];
}

export interface OrionPipelineRun {
  runId: string;
  caseId: string;
  mode: OrionPipelineMode;
  status: OrionLifecycleStatus;
  startedAt: string;
  finishedAt?: string;
  warnings: string[];
  errors: string[];
}

export interface OrionMicroStageRun {
  runId: string;
  macroSectionKey: string;
  microStageKey: string;
  status: OrionLifecycleStatus;
  startedAt: string;
  finishedAt?: string;
  agentRuns: OrionAgentRunPlan[];
  warnings: string[];
  errors: string[];
}

export interface OrionAgentRunPlan {
  providerId: string;
  agentName: string;
  required: boolean;
  status: "planned" | "ran" | "skipped" | "failed";
  reason?: string;
}

export interface OrionRawEvidence {
  evidenceId: string;
  type: string;
  source: string;
  title?: string;
  snippet?: string;
  domain?: string;
  url?: string;
  query?: string;
  locale?: string;
  region?: string;
  classification?: string;
  themeLabel?: string;
  confidence?: string;
  screenshotRef?: string;
  visualRef?: string;
  metadata?: Record<string, unknown>;
}

export interface OrionNormalizedEvidence extends OrionRawEvidence {
  safeEvidenceId: string;
  subjectMatched: boolean;
  normalizedDomain?: string;
  status: OrionAnalysisItemStatus;
  reasonLabel?: string;
}

export interface OrionSelectedEvidence {
  items: OrionNormalizedEvidence[];
  summary: {
    total: number;
    confirmed: number;
    undesirable: number;
    potential: number;
    requiresReview: number;
    excludedNoise: number;
  };
}

export interface OrionExcludedEvidence {
  items: OrionNormalizedEvidence[];
  reasons: Array<{ reason: string; count: number }>;
}

export interface OrionEvidencePack {
  microStageKey: string;
  macroSectionKey: string;
  subject: {
    fullName: string;
    aliases: string[];
  };
  locale: "ru" | "en";
  region: string;
  sourceProvidersUsed?: string[];
  sourceAvailability?: {
    used: string[];
    unavailable: string[];
  };
  queryVariants: string[];
  resultCounts?: Record<string, number>;
  topResults: Array<{
    safeEvidenceId: string;
    source: string;
    provider?: string;
    domain?: string;
    title?: string;
    snippet?: string;
    classification?: string;
    themeLabel?: string;
    screenshotRef?: string;
    visualRef?: string;
  }>;
  counts: OrionSelectedEvidence["summary"];
  themeGroups: Array<{ label: string; count: number }>;
  keyDomains: string[];
  reviewRequiredEvidence?: Array<{
    safeEvidenceId: string;
    source: string;
    title?: string;
    snippet?: string;
    themeLabel?: string;
  }>;
  lexisParsedSafeSignals?: Array<{
    title: string;
    reason: string;
    reviewRequired: boolean;
  }>;
  lexisVisualPageRefs?: string[];
  exclusionSummary: OrionExcludedEvidence["reasons"];
}

export interface OrionGpt55SectionAnalysis {
  microStageKey: string;
  macroSectionKey: string;
  sectionNumber: string | null;
  titleRu: string;
  status: "ready" | "fallback" | "unavailable";
  generatedBy: "gpt-5.5" | "deterministic";
  clientNarrative: {
    plainConclusion: string;
    whatWasFound: string[];
    whatWasNotConfirmed: string[];
    whatRequiresReview: string[];
    whyItMatters: string;
    recommendedActions: string[];
  };
  evidenceSummary: {
    total: number;
    confirmed: number;
    undesirable: number;
    potential: number;
    requiresReview: number;
    excludedNoise: number;
    keyDomains: string[];
    keyThemes: string[];
  };
  slideContent: {
    headline: string;
    subheadline: string;
    metricCards: Array<Record<string, unknown>>;
    tables: Array<Record<string, unknown>>;
    narrativeBlocks: Array<Record<string, unknown>>;
    screenshotRefs: string[];
    visualRefs: string[];
    evidenceRefs: string[];
  };
  warnings: string[];
}

export interface OrionManifestSlide {
  slideId: string;
  slideType: string;
  title: string;
  subtitle?: string;
  metrics: Array<Record<string, unknown>>;
  tables: Array<Record<string, unknown>>;
  cards: Array<Record<string, unknown>>;
  narrativeBlocks: Array<Record<string, unknown>>;
  screenshots: string[];
  visuals: string[];
  evidenceRefs: string[];
  clientSafe: boolean;
  internalOnly: boolean;
}

export interface OrionSlideManifest {
  microStageKey: string;
  macroSectionKey: string;
  order: number;
  slides: OrionManifestSlide[];
}

export interface OrionSectionDeckManifest {
  macroSectionKey: string;
  sectionNumber: string | null;
  titleRu: string;
  order: number;
  sectionStartPage?: number;
  slides: OrionManifestSlide[];
}

export interface OrionFinalDeckManifest {
  runId: string;
  mode: OrionPipelineMode;
  version: string;
  generatedAt: string;
  tocEntries: Array<{ title: string; page: number }>;
  sections: OrionSectionDeckManifest[];
  totalSlidesInternal: number;
  totalSlidesClient: number;
  lexisNexisVisualPageCount: number;
}

export interface OrionCompositionInspection {
  runId: string;
  coverPage?: number;
  globalTocPage?: number;
  macroSections: string[];
  microStages: string[];
  missingMicroStages: string[];
  slideCountByMicroStage: Record<string, number>;
  macroSectionStartPages: Record<string, number>;
  microStageStartPages: Record<string, number>;
  internalOnlySlides?: string[];
  clientRemovedSlides?: string[];
  internalPageCount?: number;
  clientPageCount?: number;
  finalInternalPageCount: number;
  finalClientPageCount: number;
  lexisNexisVisualPageCount: number;
  tocEntries: Array<{ title: string; page: number }>;
  warnings: string[];
  errors: string[];
}

export interface OrionConsistencyViolation {
  section: string;
  microStage: string;
  slide: string;
  field: string;
  expected: string;
  actual: string;
}

export interface OrionConsistencyInspection {
  status: "PASS" | "BLOCKED";
  violations: OrionConsistencyViolation[];
  warnings: string[];
}
