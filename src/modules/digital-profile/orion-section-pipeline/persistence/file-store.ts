import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  OrionGpt55SectionAnalysis,
  OrionPipelineRun,
  OrionSlideManifest,
} from "../types";
import type {
  OrionPipelineStore,
  OrionStoreReadInput,
  OrionStoreWriteInput,
} from "./types";

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeJson(path: string, payload: unknown): void {
  ensureParent(path);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function microStagePath(root: string, microStageKey: string, fileName: string): string {
  return join(root, "micro-stages", microStageKey, fileName);
}

export class OrionFilePipelineStore implements OrionPipelineStore {
  readonly mode = "file" as const;

  async createRun(input: {
    caseId: string;
    reportRunId: string;
    outputRoot: string;
    run: OrionPipelineRun;
    metadataJson?: Record<string, unknown>;
  }): Promise<void> {
    writeJson(join(input.outputRoot, "run-manifest.json"), input.run);
  }

  async saveBlueprint(input: OrionStoreWriteInput): Promise<void> {
    writeJson(join(input.outputRoot, "blueprint.json"), input.payloadJson);
  }

  async saveMacroSection(input: OrionStoreWriteInput): Promise<void> {
    const key = input.macroSectionKey ?? "unknown-macro";
    writeJson(join(input.outputRoot, "macro-sections", key, "macro-section.json"), input.payloadJson);
  }

  async saveMicroStage(input: OrionStoreWriteInput): Promise<void> {
    const key = input.microStageKey ?? "unknown-stage";
    writeJson(microStagePath(input.outputRoot, key, "stage-inspection.json"), input.payloadJson);
  }

  async saveAgentRun(input: OrionStoreWriteInput): Promise<void> {
    const key = input.microStageKey ?? "unknown-stage";
    writeJson(microStagePath(input.outputRoot, key, "agent-runs.json"), input.payloadJson);
  }

  async saveRawEvidence(input: OrionStoreWriteInput): Promise<void> {
    const key = input.microStageKey ?? "unknown-stage";
    writeJson(microStagePath(input.outputRoot, key, "raw-evidence.json"), input.payloadJson);
  }

  async saveNormalizedEvidence(input: OrionStoreWriteInput): Promise<void> {
    const key = input.microStageKey ?? "unknown-stage";
    writeJson(microStagePath(input.outputRoot, key, "normalized-evidence.json"), input.payloadJson);
  }

  async saveSelectedEvidence(input: OrionStoreWriteInput): Promise<void> {
    const key = input.microStageKey ?? "unknown-stage";
    writeJson(microStagePath(input.outputRoot, key, "selected-evidence.json"), input.payloadJson);
  }

  async saveExcludedEvidence(input: OrionStoreWriteInput): Promise<void> {
    const key = input.microStageKey ?? "unknown-stage";
    writeJson(microStagePath(input.outputRoot, key, "excluded-evidence.json"), input.payloadJson);
  }

  async saveEvidenceFile(input: OrionStoreWriteInput): Promise<void> {
    const key = input.microStageKey ?? "unknown-stage";
    writeJson(microStagePath(input.outputRoot, key, "evidence-files.json"), input.payloadJson);
  }

  async saveEvidencePack(input: OrionStoreWriteInput): Promise<void> {
    const key = input.microStageKey ?? "unknown-stage";
    writeJson(microStagePath(input.outputRoot, key, "evidence-pack.json"), input.payloadJson);
  }

  async saveSectionAnalysis(input: OrionStoreWriteInput): Promise<void> {
    const key = input.microStageKey ?? "unknown-stage";
    writeJson(microStagePath(input.outputRoot, key, "final-analysis.json"), input.payloadJson);
  }

  async saveSlideManifest(input: OrionStoreWriteInput): Promise<void> {
    const key = input.microStageKey ?? "unknown-stage";
    writeJson(microStagePath(input.outputRoot, key, "slide-manifest.json"), input.payloadJson);
  }

  async saveSectionDeckArtifact(input: OrionStoreWriteInput): Promise<void> {
    const fileName = String((input.metadataJson?.fileName as string | undefined) ?? "section-deck-artifact.json");
    writeJson(join(input.outputRoot, "composed", fileName), input.payloadJson);
  }

  async saveFinalDeckManifest(input: OrionStoreWriteInput): Promise<void> {
    writeJson(join(input.outputRoot, "composed", "final-deck-manifest.json"), input.payloadJson);
  }

  async saveReportJsonVersion(input: OrionStoreWriteInput & { audience: "internal" | "client" }): Promise<void> {
    const file = input.audience === "internal" ? "final-report-json-internal.json" : "final-report-json-client.json";
    writeJson(join(input.outputRoot, "composed", file), input.payloadJson);
  }

  async saveConsistencyCheck(input: OrionStoreWriteInput): Promise<void> {
    writeJson(join(input.outputRoot, "composed", "consistency-inspection.json"), input.payloadJson);
  }

  async loadRun(input: OrionStoreReadInput): Promise<OrionPipelineRun | null> {
    return readJson<OrionPipelineRun>(join(input.outputRoot, "run-manifest.json"));
  }

  async loadMicroStages(input: OrionStoreReadInput): Promise<Array<Record<string, unknown>>> {
    const mapping = readJson<{ mappedStages?: Array<Record<string, unknown>> }>(
      join(input.outputRoot, "micro-stage-mapping-inspection.json")
    );
    return mapping?.mappedStages ?? [];
  }

  async loadEvidencePack(input: OrionStoreReadInput): Promise<Record<string, unknown> | null> {
    if (!input.microStageKey) return null;
    return readJson<Record<string, unknown>>(microStagePath(input.outputRoot, input.microStageKey, "evidence-pack.json"));
  }

  async loadSectionAnalysis(input: OrionStoreReadInput): Promise<OrionGpt55SectionAnalysis | null> {
    if (!input.microStageKey) return null;
    return readJson<OrionGpt55SectionAnalysis>(microStagePath(input.outputRoot, input.microStageKey, "final-analysis.json"));
  }

  async loadSlideManifest(input: OrionStoreReadInput): Promise<OrionSlideManifest | null> {
    if (!input.microStageKey) return null;
    return readJson<OrionSlideManifest>(microStagePath(input.outputRoot, input.microStageKey, "slide-manifest.json"));
  }

  async writeArtifact(path: string, payload: unknown): Promise<void> {
    writeJson(path, payload);
  }

  async readArtifact<T>(path: string): Promise<T | null> {
    return readJson<T>(path);
  }
}
