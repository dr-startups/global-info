import { prisma } from "@/server/prisma/client";
import type {
  OrionGpt55SectionAnalysis,
  OrionPipelineRun,
  OrionSlideManifest,
} from "../types";
import {
  assertClientVisibleStorageSafe,
  sanitizeForStorage,
  scanForbiddenTokens,
} from "./sanitize-for-storage";
import type {
  OrionPipelineStore,
  OrionStoreReadInput,
  OrionStoreWriteInput,
} from "./types";

type PrismaAny = Record<string, unknown> & {
  [delegate: string]: {
    create: (input: { data: Record<string, unknown> }) => Promise<unknown>;
    findFirst: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    findMany: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  };
};

const db = prisma as unknown as PrismaAny;

export class OrionPrismaPipelineStore implements OrionPipelineStore {
  readonly mode = "db" as const;
  private readonly macroSectionIds = new Map<string, string>();
  private readonly microStageIds = new Map<string, string>();
  private readonly fileStore: OrionPipelineStore;

  constructor(fileStore: OrionPipelineStore) {
    this.fileStore = fileStore;
  }

  private async create(delegate: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await db[delegate].create({ data })) as Record<string, unknown>;
  }

  private async savePayload(
    delegate: string,
    input: OrionStoreWriteInput,
    extra: Record<string, unknown> = {},
    clientVisible = false
  ): Promise<void> {
    const sanitized = sanitizeForStorage(input.payloadJson, { clientVisible });
    const metadata = sanitizeForStorage(input.metadataJson ?? {}, { clientVisible: false }) as Record<string, unknown>;
    if (clientVisible) {
      assertClientVisibleStorageSafe(sanitized);
    }
    const forbidden = scanForbiddenTokens(sanitized);
    if (clientVisible && forbidden.length > 0) {
      throw new Error(`orion-db-client-payload-forbidden:${forbidden.join(",")}`);
    }
    await this.create(delegate, {
      caseId: input.caseId,
      reportRunId: input.reportRunId,
      status: input.status ?? "ready",
      orderIndex: input.orderIndex ?? null,
      internalOnly: input.internalOnly ?? !clientVisible,
      payloadJson: sanitized,
      metadataJson: metadata,
      ...extra,
    });
  }

  async createRun(input: {
    caseId: string;
    reportRunId: string;
    outputRoot: string;
    run: OrionPipelineRun;
    metadataJson?: Record<string, unknown>;
  }): Promise<void> {
    await this.fileStore.createRun(input);
    await this.create("orionReportRun", {
      id: input.reportRunId,
      caseId: input.caseId,
      mode: input.run.mode,
      storeMode: "db",
      status: input.run.status,
      internalOnly: true,
      metadataJson: input.metadataJson ?? {},
      warningsJson: input.run.warnings,
      errorsJson: input.run.errors,
      startedAt: input.run.startedAt ? new Date(input.run.startedAt) : null,
      finishedAt: input.run.finishedAt ? new Date(input.run.finishedAt) : null,
    });
  }

  async saveBlueprint(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveBlueprint(input);
    await this.saveSectionDeckArtifact({
      ...input,
      metadataJson: { ...(input.metadataJson ?? {}), fileName: "blueprint.json", artifactType: "blueprint" },
      payloadJson: input.payloadJson,
    });
  }

  async saveMacroSection(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveMacroSection(input);
    const created = await this.create("orionReportMacroSection", {
      caseId: input.caseId,
      reportRunId: input.reportRunId,
      macroSectionKey: input.macroSectionKey ?? "unknown",
      sectionNumber: input.metadataJson?.sectionNumber ?? null,
      orderIndex: input.orderIndex ?? 0,
      status: input.status ?? "ready",
      titleRu: input.metadataJson?.titleRu ?? String(input.macroSectionKey ?? ""),
      internalOnly: input.internalOnly ?? true,
      payloadJson: sanitizeForStorage(input.payloadJson, { clientVisible: false }),
      metadataJson: sanitizeForStorage(input.metadataJson ?? {}, { clientVisible: false }),
    });
    const id = String(created.id ?? "");
    if (id && input.macroSectionKey) {
      this.macroSectionIds.set(input.macroSectionKey, id);
    }
  }

  async saveMicroStage(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveMicroStage(input);
    const macroSectionId = input.macroSectionKey ? this.macroSectionIds.get(input.macroSectionKey) : null;
    const created = await this.create("orionReportMicroStage", {
      caseId: input.caseId,
      reportRunId: input.reportRunId,
      macroSectionId: macroSectionId ?? null,
      macroSectionKey: input.macroSectionKey ?? "unknown",
      microStageKey: input.microStageKey ?? "unknown",
      sectionNumber: input.metadataJson?.sectionNumber ?? null,
      orderIndex: input.orderIndex ?? 0,
      status: input.status ?? "ready",
      internalOnly: input.internalOnly ?? true,
      payloadJson: sanitizeForStorage(input.payloadJson, { clientVisible: false }),
      metadataJson: sanitizeForStorage(input.metadataJson ?? {}, { clientVisible: false }),
    });
    const id = String(created.id ?? "");
    if (id && input.microStageKey) {
      this.microStageIds.set(input.microStageKey, id);
    }
  }

  async saveAgentRun(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveAgentRun(input);
    await this.savePayload(
      "orionSectionAgentRun",
      input,
      {
        microStageId: this.microStageIds.get(String(input.microStageKey ?? "")) ?? "",
        providerId: String(input.metadataJson?.providerId ?? "unknown"),
        agentName: String(input.metadataJson?.agentName ?? "unknown"),
        reason: input.metadataJson?.reason ?? null,
      },
      false
    );
  }

  async saveRawEvidence(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveRawEvidence(input);
    await this.savePayload("orionRawEvidence", input, { microStageId: this.microStageIds.get(String(input.microStageKey ?? "")) ?? "" }, false);
  }

  async saveNormalizedEvidence(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveNormalizedEvidence(input);
    await this.savePayload("orionNormalizedEvidence", input, { microStageId: this.microStageIds.get(String(input.microStageKey ?? "")) ?? "" }, false);
  }

  async saveSelectedEvidence(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveSelectedEvidence(input);
    await this.savePayload("orionSelectedEvidence", input, { microStageId: this.microStageIds.get(String(input.microStageKey ?? "")) ?? "" }, false);
  }

  async saveExcludedEvidence(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveExcludedEvidence(input);
    await this.savePayload("orionExcludedEvidence", input, { microStageId: this.microStageIds.get(String(input.microStageKey ?? "")) ?? "" }, false);
  }

  async saveEvidenceFile(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveEvidenceFile(input);
    await this.savePayload("orionEvidenceFile", input, { microStageId: this.microStageIds.get(String(input.microStageKey ?? "")) ?? "" }, false);
  }

  async saveEvidencePack(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveEvidencePack(input);
    await this.savePayload("orionSectionEvidencePack", input, { microStageId: this.microStageIds.get(String(input.microStageKey ?? "")) ?? "" }, false);
  }

  async saveSectionAnalysis(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveSectionAnalysis(input);
    await this.savePayload("orionSectionAnalysis", input, { microStageId: this.microStageIds.get(String(input.microStageKey ?? "")) ?? "" }, false);
  }

  async saveSlideManifest(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveSlideManifest(input);
    await this.savePayload("orionSectionSlideManifest", input, { microStageId: this.microStageIds.get(String(input.microStageKey ?? "")) ?? "" }, false);
  }

  async saveSectionDeckArtifact(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveSectionDeckArtifact(input);
    await this.savePayload(
      "orionSectionDeckArtifact",
      input,
      {
        macroSectionId: this.macroSectionIds.get(String(input.macroSectionKey ?? "")) ?? "",
        audience: String(input.metadataJson?.audience ?? "internal"),
      },
      false
    );
  }

  async saveFinalDeckManifest(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveFinalDeckManifest(input);
    await this.savePayload("orionFinalDeckManifest", input, {}, false);
  }

  async saveReportJsonVersion(input: OrionStoreWriteInput & { audience: "internal" | "client" }): Promise<void> {
    await this.fileStore.saveReportJsonVersion(input);
    await this.savePayload("orionReportJsonVersion", input, { audience: input.audience }, input.audience === "client");
  }

  async saveConsistencyCheck(input: OrionStoreWriteInput): Promise<void> {
    await this.fileStore.saveConsistencyCheck(input);
    await this.savePayload("orionReportConsistencyCheck", input, {}, false);
  }

  async loadRun(input: OrionStoreReadInput): Promise<OrionPipelineRun | null> {
    const row = await db.orionReportRun.findFirst({
      where: { id: input.reportRunId, caseId: input.caseId },
    });
    if (!row) return this.fileStore.loadRun(input);
    return {
      runId: String(row.id),
      caseId: String(row.caseId),
      mode: String(row.mode) as OrionPipelineRun["mode"],
      status: String(row.status) as OrionPipelineRun["status"],
      startedAt: String(row.startedAt ?? new Date().toISOString()),
      finishedAt: row.finishedAt ? String(row.finishedAt) : undefined,
      warnings: Array.isArray(row.warningsJson) ? (row.warningsJson as string[]) : [],
      errors: Array.isArray(row.errorsJson) ? (row.errorsJson as string[]) : [],
    };
  }

  async loadMicroStages(input: OrionStoreReadInput): Promise<Array<Record<string, unknown>>> {
    return db.orionReportMicroStage.findMany({
      where: { reportRunId: input.reportRunId, caseId: input.caseId },
      orderBy: { orderIndex: "asc" },
    });
  }

  async loadEvidencePack(input: OrionStoreReadInput): Promise<Record<string, unknown> | null> {
    if (!input.microStageKey) return null;
    const micro = await db.orionReportMicroStage.findFirst({
      where: { reportRunId: input.reportRunId, caseId: input.caseId, microStageKey: input.microStageKey },
    });
    if (!micro?.id) return null;
    const row = await db.orionSectionEvidencePack.findFirst({
      where: { reportRunId: input.reportRunId, caseId: input.caseId, microStageId: String(micro.id) },
      orderBy: { createdAt: "desc" },
    });
    return (row?.payloadJson as Record<string, unknown> | undefined) ?? null;
  }

  async loadSectionAnalysis(input: OrionStoreReadInput): Promise<OrionGpt55SectionAnalysis | null> {
    if (!input.microStageKey) return null;
    const micro = await db.orionReportMicroStage.findFirst({
      where: { reportRunId: input.reportRunId, caseId: input.caseId, microStageKey: input.microStageKey },
    });
    if (!micro?.id) return null;
    const row = await db.orionSectionAnalysis.findFirst({
      where: { reportRunId: input.reportRunId, caseId: input.caseId, microStageId: String(micro.id) },
      orderBy: { createdAt: "desc" },
    });
    return (row?.payloadJson as OrionGpt55SectionAnalysis | undefined) ?? null;
  }

  async loadSlideManifest(input: OrionStoreReadInput): Promise<OrionSlideManifest | null> {
    if (!input.microStageKey) return null;
    const micro = await db.orionReportMicroStage.findFirst({
      where: { reportRunId: input.reportRunId, caseId: input.caseId, microStageKey: input.microStageKey },
    });
    if (!micro?.id) return null;
    const row = await db.orionSectionSlideManifest.findFirst({
      where: { reportRunId: input.reportRunId, caseId: input.caseId, microStageId: String(micro.id) },
      orderBy: { createdAt: "desc" },
    });
    return (row?.payloadJson as OrionSlideManifest | undefined) ?? null;
  }

  async writeArtifact(path: string, payload: unknown): Promise<void> {
    await this.fileStore.writeArtifact(path, payload);
  }

  async readArtifact<T>(path: string): Promise<T | null> {
    return this.fileStore.readArtifact<T>(path);
  }
}
