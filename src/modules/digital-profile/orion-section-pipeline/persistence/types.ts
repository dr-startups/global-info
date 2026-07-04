import type {
  OrionConsistencyInspection,
  OrionFinalDeckManifest,
  OrionGpt55SectionAnalysis,
  OrionPipelineRun,
  OrionSlideManifest,
} from "../types";

export type OrionStoreMode = "file" | "db";

export interface OrionStoreScope {
  caseId: string;
  reportRunId: string;
  outputRoot: string;
}

export interface OrionStoreWriteInput extends OrionStoreScope {
  macroSectionKey?: string;
  microStageKey?: string;
  status?: string;
  orderIndex?: number;
  internalOnly?: boolean;
  payloadJson: unknown;
  metadataJson?: Record<string, unknown>;
}

export interface OrionStoreReadInput extends OrionStoreScope {
  microStageKey?: string;
}

export interface OrionPipelineStore {
  mode: OrionStoreMode;
  createRun(input: OrionStoreScope & { run: OrionPipelineRun; metadataJson?: Record<string, unknown> }): Promise<void>;
  saveBlueprint(input: OrionStoreWriteInput): Promise<void>;
  saveMacroSection(input: OrionStoreWriteInput): Promise<void>;
  saveMicroStage(input: OrionStoreWriteInput): Promise<void>;
  saveAgentRun(input: OrionStoreWriteInput): Promise<void>;
  saveRawEvidence(input: OrionStoreWriteInput): Promise<void>;
  saveNormalizedEvidence(input: OrionStoreWriteInput): Promise<void>;
  saveSelectedEvidence(input: OrionStoreWriteInput): Promise<void>;
  saveExcludedEvidence(input: OrionStoreWriteInput): Promise<void>;
  saveEvidenceFile(input: OrionStoreWriteInput): Promise<void>;
  saveEvidencePack(input: OrionStoreWriteInput): Promise<void>;
  saveSectionAnalysis(input: OrionStoreWriteInput): Promise<void>;
  saveSlideManifest(input: OrionStoreWriteInput): Promise<void>;
  saveSectionDeckArtifact(input: OrionStoreWriteInput): Promise<void>;
  saveFinalDeckManifest(input: OrionStoreWriteInput): Promise<void>;
  saveReportJsonVersion(input: OrionStoreWriteInput & { audience: "internal" | "client" }): Promise<void>;
  saveConsistencyCheck(input: OrionStoreWriteInput): Promise<void>;
  loadRun(input: OrionStoreReadInput): Promise<OrionPipelineRun | null>;
  loadMicroStages(input: OrionStoreReadInput): Promise<Array<Record<string, unknown>>>;
  loadEvidencePack(input: OrionStoreReadInput): Promise<Record<string, unknown> | null>;
  loadSectionAnalysis(input: OrionStoreReadInput): Promise<OrionGpt55SectionAnalysis | null>;
  loadSlideManifest(input: OrionStoreReadInput): Promise<OrionSlideManifest | null>;
  writeArtifact(path: string, payload: unknown): Promise<void>;
  readArtifact<T>(path: string): Promise<T | null>;
}

export interface OrionDbRoundtripSnapshot {
  run: OrionPipelineRun | null;
  finalDeckManifest: OrionFinalDeckManifest | null;
  consistencyInspection: OrionConsistencyInspection | null;
}
