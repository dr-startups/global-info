/**
 * Stage 1 — Persisted ORION Classic architecture manifest.
 * Characterization artifact only; not wired into production render/KPI paths.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export const ORION_ARCHITECTURE_MANIFEST_SCHEMA_VERSION = "orion-architecture-manifest-v1" as const;

export type ArtifactFingerprint = {
  path: string;
  sha256: string | null;
  present: boolean;
  bytes?: number;
};

export type LlmUsagePoint = {
  id: string;
  file: string;
  symbol: string;
  whenCalled: string;
  liveNetwork: boolean;
};

export type DestructiveReplacementPoint = {
  id: string;
  file: string;
  symbol: string;
  risk: string;
};

export type StaleForeignArtifactRisk = {
  id: string;
  description: string;
  detectionHint: string;
};

export type OrionArchitectureManifest = {
  schemaVersion: typeof ORION_ARCHITECTURE_MANIFEST_SCHEMA_VERSION;
  caseId: string;
  datasetId: string;
  generatedAt: string;
  canonicalBaseReportRunId: string | null;
  enrichmentRunIds: string[];
  effectiveCompositeDatasetId: string | null;
  currentArtifacts: ArtifactFingerprint[];
  bindings: {
    arsenkinReportBindingPath: string | null;
    clientContentBindingPath: string | null;
    reportDataBindingPath: string | null;
    sourceHashes: string[];
    evidenceRefs: string[];
  };
  llmUsagePoints: LlmUsagePoint[];
  destructiveReplacementPoints: DestructiveReplacementPoint[];
  staleForeignArtifactRisks: StaleForeignArtifactRisk[];
  notes: string[];
};

export const ArtifactFingerprintSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().nullable(),
  present: z.boolean(),
  bytes: z.number().int().nonnegative().optional(),
});

export const OrionArchitectureManifestSchema = z.object({
  schemaVersion: z.literal(ORION_ARCHITECTURE_MANIFEST_SCHEMA_VERSION),
  caseId: z.string().min(1),
  datasetId: z.string().min(1),
  generatedAt: z.string().min(1),
  canonicalBaseReportRunId: z.string().nullable(),
  enrichmentRunIds: z.array(z.string()),
  effectiveCompositeDatasetId: z.string().nullable(),
  currentArtifacts: z.array(ArtifactFingerprintSchema),
  bindings: z.object({
    arsenkinReportBindingPath: z.string().nullable(),
    clientContentBindingPath: z.string().nullable(),
    reportDataBindingPath: z.string().nullable(),
    sourceHashes: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
  }),
  llmUsagePoints: z.array(
    z.object({
      id: z.string().min(1),
      file: z.string().min(1),
      symbol: z.string().min(1),
      whenCalled: z.string().min(1),
      liveNetwork: z.boolean(),
    })
  ),
  destructiveReplacementPoints: z.array(
    z.object({
      id: z.string().min(1),
      file: z.string().min(1),
      symbol: z.string().min(1),
      risk: z.string().min(1),
    })
  ),
  staleForeignArtifactRisks: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      detectionHint: z.string().min(1),
    })
  ),
  notes: z.array(z.string()),
});

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function fingerprintBuffer(path: string, buf: Buffer | null): ArtifactFingerprint {
  if (!buf) return { path, sha256: null, present: false };
  return { path, sha256: sha256Hex(buf), present: true, bytes: buf.length };
}

/** Canonical catalog of known LLM call sites on Golden/Classic path (static). */
export function catalogLlmUsagePoints(): LlmUsagePoint[] {
  return [
    {
      id: "openai-json-client",
      file: "orion-golden/gpt/openai-json-client.ts",
      symbol: "callOpenAiStrictJson",
      whenCalled: "Golden prepare / section+executive GPT",
      liveNetwork: true,
    },
    {
      id: "section-analysis-orchestrator",
      file: "orion-golden/gpt/orion-section-analysis-orchestrator.ts",
      symbol: "analyzeOrionSections",
      whenCalled: "runR10OrionGoldenE2e / prepare",
      liveNetwork: true,
    },
    {
      id: "section-analyzer",
      file: "orion-golden/gpt/orion-section-analyzer.ts",
      symbol: "runOrionGoldenSectionAnalyses",
      whenCalled: "section GPT batch",
      liveNetwork: true,
    },
    {
      id: "executive-synthesis-from-sections",
      file: "orion-golden/gpt/orion-executive-synthesis-from-sections.ts",
      symbol: "buildExecutiveSynthesisFromSections",
      whenCalled: "prepare / e2e",
      liveNetwork: true,
    },
    {
      id: "executive-synthesizer",
      file: "orion-golden/gpt/orion-executive-synthesizer.ts",
      symbol: "runOrionGoldenExecutiveSynthesis",
      whenCalled: "prepare / e2e",
      liveNetwork: true,
    },
    {
      id: "gpt-auto-analyst",
      file: "orion-golden/evidence/gpt-auto-analyst.ts",
      symbol: "runGptAutoAnalystDecisions",
      whenCalled: "ORION_GPT_AUTO_ANALYST=1",
      liveNetwork: true,
    },
    {
      id: "gpt55-microstage",
      file: "orion-section-pipeline/gpt55-microstage-analyzer.ts",
      symbol: "analyzeSectionWithGpt55",
      whenCalled: "section pipeline (legacy/vertical)",
      liveNetwork: true,
    },
    {
      id: "classic-render-reads-synthesis",
      file: "orion-golden/classic/run-orion-classic-audit-render.ts",
      symbol: "runOrionClassicAuditRender",
      whenCalled: "reads executive-synthesis.output.json only — no OpenAI call",
      liveNetwork: false,
    },
  ];
}

export function catalogDestructiveReplacementPoints(): DestructiveReplacementPoint[] {
  return [
    {
      id: "coverage-cell-overlay",
      file: "orion-golden/classic/composite-serp-overlay-merge.ts",
      symbol: "overlayInventoryByCoverageCells",
      risk: "Base SERP rows in covered cells replaced by enrichment",
    },
    {
      id: "surface-panel-overlay",
      file: "orion-golden/classic/build-arsenkin-surface-panels.ts",
      symbol: "overlaySurfacePanelAssets",
      risk: "Same assetRef replaced by Arsenkin panel (wiki knowledge protected)",
    },
    {
      id: "gpt-findings-suppress-serp-tables",
      file: "orion-golden/classic/orion-classic-client-content-to-report-spec.ts",
      symbol: "buildOrionClassicReportSpecFromClientContent",
      risk: "SERP position tables omitted when gptFindings present",
    },
    {
      id: "acceptance-enrichment-underlist",
      file: "orion-golden/classic/run-orion-classic-audit-render.ts",
      symbol: "inspectFirst36Acceptance input enrichmentRunIds",
      risk: "Acceptance may under-list enrichment runs vs merge",
    },
    {
      id: "empty-run-strip-env",
      file: "orion-golden/classic/merge-run-scoped-serp-observations.ts",
      symbol: "ORION_FIRST36_STRIP_EMPTY_RUN",
      risk: "Env-forced strip of base organic on empty Arsenkin run",
    },
  ];
}

export function catalogStaleForeignArtifactRisks(): StaleForeignArtifactRisk[] {
  return [
    {
      id: "stale-post-review-content",
      description: "Post-review client content older than fresh Arsenkin observations",
      detectionHint: "Compare client-content-binding timestamps vs observation capturedAt",
    },
    {
      id: "orphan-case-agent-obs",
      description: "CaseAgent auditRunId not listed in enrichmentRuns",
      detectionHint: "report-evidence-provenance ORPHAN_CASE_AGENT_OBS",
    },
    {
      id: "missing-binding-base-only",
      description: "No arsenkin-report-binding → render uses base without overlay",
      detectionHint: "Missing arsenkin-report-binding.json under case root",
    },
    {
      id: "foreign-effective-report-run",
      description: "effectiveReportRunId points at foreign/stale run",
      detectionHint: "Binding effectiveReportRunId not in case runs",
    },
    {
      id: "dual-merge-divergence",
      description: "Unified composite merge not feeding Classic inventory merge",
      detectionHint: "Presence of unified report-data-binding without classic merge provenance",
    },
  ];
}

export function buildArchitectureManifest(input: {
  caseId: string;
  datasetId: string;
  canonicalBaseReportRunId: string | null;
  enrichmentRunIds: string[];
  effectiveCompositeDatasetId: string | null;
  currentArtifacts?: ArtifactFingerprint[];
  bindings?: Partial<OrionArchitectureManifest["bindings"]>;
  notes?: string[];
  generatedAt?: string;
}): OrionArchitectureManifest {
  const bindings = {
    arsenkinReportBindingPath: input.bindings?.arsenkinReportBindingPath ?? null,
    clientContentBindingPath: input.bindings?.clientContentBindingPath ?? null,
    reportDataBindingPath: input.bindings?.reportDataBindingPath ?? null,
    sourceHashes: input.bindings?.sourceHashes ?? [],
    evidenceRefs: input.bindings?.evidenceRefs ?? [],
  };
  return {
    schemaVersion: ORION_ARCHITECTURE_MANIFEST_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    canonicalBaseReportRunId: input.canonicalBaseReportRunId,
    enrichmentRunIds: [...input.enrichmentRunIds],
    effectiveCompositeDatasetId: input.effectiveCompositeDatasetId,
    currentArtifacts: input.currentArtifacts ?? [],
    bindings,
    llmUsagePoints: catalogLlmUsagePoints(),
    destructiveReplacementPoints: catalogDestructiveReplacementPoints(),
    staleForeignArtifactRisks: catalogStaleForeignArtifactRisks(),
    notes: input.notes ?? [],
  };
}

export function parseArchitectureManifest(raw: unknown): OrionArchitectureManifest {
  return OrionArchitectureManifestSchema.parse(raw);
}

export function safeParseArchitectureManifest(raw: unknown) {
  return OrionArchitectureManifestSchema.safeParse(raw);
}
