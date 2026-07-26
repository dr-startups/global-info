/**
 * R10.6 — ORION canonical section analysis output model.
 */

export type OrionSectionAnalysisStatus =
  | "HAS_FINDINGS"
  | "NO_FINDINGS"
  | "DATA_POOR"
  | "NOT_APPLICABLE"
  | "MANUAL_REVIEW_PENDING";

export type OrionSectionAnalysis = {
  version: "r10-6-orion-section-analysis-v1";
  sectionId: string;
  order: number;
  title: string;
  status: OrionSectionAnalysisStatus;
  clientNarrative: string;
  keyFindings: Array<{
    title: string;
    summary: string;
    evidenceRefs: string[];
    confidence: "Высокая" | "Средняя" | "Низкая";
    caveat?: string;
  }>;
  risks: Array<{
    theme: string;
    level: "Низкий" | "Средний" | "Высокий" | "Критический" | "Требует проверки";
    summary: string;
    evidenceRefs: string[];
    requiresManualReview: boolean;
  }>;
  limitations: string[];
  recommendations: string[];
  sourceSectionBundleHash?: string;
  generatedBy: "gpt-5.5" | "deterministic";
  gptCallMade?: boolean;
};

export type OrionSectionAnalysisIndex = {
  version: "r10-6-section-analyses-index-v1";
  caseId: string;
  reportRunId: string;
  generatedAt: string;
  gptSectionCallCount: number;
  skippedSections: Array<{ sectionId: string; reason: string }>;
  analyses: Array<{
    sectionId: string;
    order: number;
    status: OrionSectionAnalysisStatus;
    gptCallMade: boolean;
  }>;
};

export type SectionGptOrchestrationMeta = {
  gptSectionCallCount: number;
  gptSectionCallIds: string[];
  skippedSections: Array<{ sectionId: string; reason: string }>;
  executiveSynthesisCallCount: number;
  riskMatrixSynthesisCount: number;
  megaPromptUsed: false;
};
