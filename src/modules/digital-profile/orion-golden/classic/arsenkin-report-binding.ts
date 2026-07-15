/**
 * Case-scoped Arsenkin → ORION report binding.
 * Single source of truth for effectiveReportRunId after "Передать результаты в ORION".
 *
 * Also hydrates from legacy arsenkin-ui-sync.json + run-mapping so transfers
 * performed before arsenkin-report-binding.json still drive regenerate/PDF.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  caseScopedArtifactRoot,
  ORION_GOLDEN_QA_STORAGE_ROOT,
  sanitizeCaseIdForPath,
} from "../evidence/admin-review-decision-store";
import { writeJsonAtomic } from "../../providers/arsenkin/arsenkin-db-readiness";
import type { ArsenkinWorkflow } from "./arsenkin-stage-ledger";

export type ArsenkinTransferStatus =
  | "READY_TO_TRANSFER"
  | "TRANSFERRING"
  | "TRANSFERRED"
  | "TRANSFER_FAILED"
  | "REPORT_BOUND";

export type ArsenkinReportBinding = {
  caseId: string;
  sourceReportRunId: string;
  effectiveReportRunId: string;
  provider: "arsenkin";
  workflow: ArsenkinWorkflow;
  stage: string;
  status: ArsenkinTransferStatus;
  transferredAt: string;
  providerTaskCount: number;
  observationCount: number;
  coverageCount: number;
  lastError?: string | null;
  /** Set when post-review content still points at source after transfer. */
  contentPromotionError?: string | null;
  /** Optional v2 fields — may be absent on legacy bindings. */
  version?: "arsenkin-report-binding-v1" | "arsenkin-report-binding-v2";
  enrichmentRuns?: ArsenkinEnrichmentRun[];
  compositeDigest?: string;
};

export type CoveredSurfaceCell = {
  region: string;
  engine: string;
  surface: string;
  status?: "COLLECTED" | "COLLECTED_NO_RESULTS" | "NOT_COLLECTED";
};

export type ArsenkinEnrichmentRun = {
  reportRunId: string;
  provider: "arsenkin";
  workflow: string;
  stage: string;
  coveredSurfaces: CoveredSurfaceCell[];
};

/** Runtime composite model — always produced from v1 or v2 binding. */
export type ArsenkinReportBindingV2 = ArsenkinReportBinding & {
  version: "arsenkin-report-binding-v2";
  enrichmentRuns: ArsenkinEnrichmentRun[];
  compositeDigest: string;
};

export function defaultCoveredSurfacesForStage(stage: string): CoveredSurfaceCell[] {
  if (stage === "SUGGEST_RU_CANARY") {
    return [
      { region: "RU", engine: "YANDEX", surface: "autocomplete", status: "COLLECTED" },
      { region: "RU", engine: "GOOGLE", surface: "autocomplete", status: "COLLECTED" },
    ];
  }
  return [];
}

export function computeCompositeDigest(input: {
  sourceReportRunId: string;
  enrichmentRunIds: string[];
  coveredSurfaces: CoveredSurfaceCell[];
}): string {
  const payload = JSON.stringify({
    source: input.sourceReportRunId,
    enrichment: [...input.enrichmentRunIds].sort(),
    surfaces: input.coveredSurfaces
      .map((c) => `${c.region}|${c.engine}|${c.surface}`)
      .sort(),
  });
  let h = 0;
  for (let i = 0; i < payload.length; i++) h = (h * 31 + payload.charCodeAt(i)) >>> 0;
  return `cmp-${h.toString(16)}`;
}

/** Normalize v1/v2 binding into composite runtime model. */
export function toCompositeBindingModel(
  binding: ArsenkinReportBinding | ArsenkinReportBindingV2
): ArsenkinReportBindingV2 {
  if (binding.version === "arsenkin-report-binding-v2" && binding.enrichmentRuns?.length) {
    return {
      ...binding,
      version: "arsenkin-report-binding-v2",
      enrichmentRuns: binding.enrichmentRuns,
      compositeDigest:
        binding.compositeDigest ??
        computeCompositeDigest({
          sourceReportRunId: binding.sourceReportRunId,
          enrichmentRunIds: binding.enrichmentRuns.map((r) => r.reportRunId),
          coveredSurfaces: binding.enrichmentRuns.flatMap((r) => r.coveredSurfaces),
        }),
    };
  }
  const covered = defaultCoveredSurfacesForStage(binding.stage);
  const enrichmentRuns: ArsenkinEnrichmentRun[] = [
    {
      reportRunId: binding.effectiveReportRunId,
      provider: "arsenkin",
      workflow: binding.workflow,
      stage: binding.stage,
      coveredSurfaces: covered,
    },
  ];
  return {
    ...binding,
    version: "arsenkin-report-binding-v2",
    enrichmentRuns,
    compositeDigest: computeCompositeDigest({
      sourceReportRunId: binding.sourceReportRunId,
      enrichmentRunIds: [binding.effectiveReportRunId],
      coveredSurfaces: covered,
    }),
  };
}

export function isKnownCompositeRunId(
  binding: ArsenkinReportBinding | null,
  runId: string
): boolean {
  if (!binding || !runId) return false;
  if (runId === binding.sourceReportRunId || runId === binding.effectiveReportRunId) return true;
  const composite = toCompositeBindingModel(binding);
  return composite.enrichmentRuns.some((r) => r.reportRunId === runId);
}

export const ARSENKIN_REPORT_BINDING_FILENAME = "arsenkin-report-binding.json";
export const ARSENKIN_UI_SYNC_FILENAME = "arsenkin-ui-sync.json";

export function arsenkinCaseArtifactRoot(caseId: string): string {
  return caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
}

export function arsenkinReportBindingPath(caseId: string): string {
  return join(arsenkinCaseArtifactRoot(caseId), ARSENKIN_REPORT_BINDING_FILENAME);
}

export function arsenkinUiSyncPath(caseId: string): string {
  return join(arsenkinCaseArtifactRoot(caseId), ARSENKIN_UI_SYNC_FILENAME);
}

export function arsenkinPostReviewContentPath(caseId: string): string {
  return join(arsenkinCaseArtifactRoot(caseId), "orion-client-content.post-review.json");
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function isArsenkinRunId(id: string): boolean {
  return id.startsWith("orion-arsenkin-");
}

function workflowFromRunId(runId: string): ArsenkinWorkflow {
  return runId.includes("first36") ? "first36-full" : "suggest-canary";
}

function loadMappingCandidate(caseId: string): {
  sourceReportRunId: string;
  arsenkinReportRunId: string;
  workflow: ArsenkinWorkflow;
  stage: string;
} | null {
  const caseRoot = arsenkinCaseArtifactRoot(caseId);
  for (const workflow of ["suggest-canary", "first36-full"] as ArsenkinWorkflow[]) {
    const mapping = readJson<{
      caseId?: string;
      sourceReportRunId?: string;
      arsenkinReportRunId?: string;
      workflow?: ArsenkinWorkflow;
      stage?: string;
    }>(join(caseRoot, `arsenkin-ui-run-mapping-${workflow}.json`));
    if (
      mapping &&
      mapping.caseId === caseId &&
      mapping.arsenkinReportRunId &&
      isArsenkinRunId(mapping.arsenkinReportRunId) &&
      mapping.sourceReportRunId
    ) {
      return {
        sourceReportRunId: mapping.sourceReportRunId,
        arsenkinReportRunId: mapping.arsenkinReportRunId,
        workflow: mapping.workflow ?? workflow,
        stage: mapping.stage ?? (workflow === "suggest-canary" ? "SUGGEST_RU_CANARY" : "FIRST36_STAGE1"),
      };
    }
  }
  return null;
}

function hydrateBindingFromLegacySync(caseId: string): ArsenkinReportBinding | null {
  const sync = readJson<{
    synced?: boolean;
    reportRunId?: string;
    sourceReportRunId?: string;
    effectiveReportRunId?: string;
    stage?: string;
    workflow?: ArsenkinWorkflow;
    status?: string;
    at?: string;
    observationCount?: number;
    providerTaskCount?: number;
    coverageCount?: number;
  }>(arsenkinUiSyncPath(caseId));
  if (!sync?.synced) return null;
  const effective =
    String(sync.effectiveReportRunId ?? sync.reportRunId ?? "").trim();
  if (!effective || !isArsenkinRunId(effective)) return null;

  const mapping = loadMappingCandidate(caseId);
  const source =
    String(sync.sourceReportRunId ?? mapping?.sourceReportRunId ?? "").trim() || effective;
  const workflow = sync.workflow ?? mapping?.workflow ?? workflowFromRunId(effective);
  const stage = sync.stage ?? mapping?.stage ?? "SUGGEST_RU_CANARY";

  const hydrated: ArsenkinReportBinding = {
    caseId,
    sourceReportRunId: source,
    effectiveReportRunId: effective,
    provider: "arsenkin",
    workflow,
    stage,
    status: sync.status === "REPORT_BOUND" ? "REPORT_BOUND" : "TRANSFERRED",
    transferredAt: sync.at ?? new Date().toISOString(),
    providerTaskCount: typeof sync.providerTaskCount === "number" ? sync.providerTaskCount : 0,
    observationCount: typeof sync.observationCount === "number" ? sync.observationCount : 0,
    coverageCount: typeof sync.coverageCount === "number" ? sync.coverageCount : 0,
    lastError: null,
  };
  // Persist so regenerate/PDF and UI share one file going forward.
  saveArsenkinReportBinding(hydrated);
  return hydrated;
}

export function loadArsenkinReportBinding(caseId: string): ArsenkinReportBinding | null {
  const raw = readJson<ArsenkinReportBinding>(arsenkinReportBindingPath(caseId));
  if (raw && raw.caseId === caseId && raw.provider === "arsenkin") {
    if (raw.effectiveReportRunId && raw.sourceReportRunId) return raw;
  }
  return hydrateBindingFromLegacySync(caseId);
}

export function saveArsenkinReportBinding(binding: ArsenkinReportBinding): void {
  const composite = toCompositeBindingModel(binding);
  writeJsonAtomic(arsenkinReportBindingPath(binding.caseId), composite);
}

export function isArsenkinTransferActive(
  binding: ArsenkinReportBinding | null
): binding is ArsenkinReportBinding {
  return Boolean(
    binding &&
      (binding.status === "TRANSFERRED" ||
        binding.status === "REPORT_BOUND" ||
        binding.status === "TRANSFERRING")
  );
}

export function isArsenkinTransferRenderReady(
  binding: ArsenkinReportBinding | null
): binding is ArsenkinReportBinding & { status: "TRANSFERRED" | "REPORT_BOUND" } {
  return Boolean(
    binding && (binding.status === "TRANSFERRED" || binding.status === "REPORT_BOUND")
  );
}

/** Storage diagnostics for operators — relative paths only, no secrets. */
export function arsenkinBindingStorageDiagnostics(caseId: string): {
  caseRootRelative: string;
  bindingRelative: string;
  bindingExists: boolean;
  syncMarkerExists: boolean;
  postReviewExists: boolean;
  postReviewReportRunId: string | null;
} {
  const safe = sanitizeCaseIdForPath(caseId);
  const caseRoot = arsenkinCaseArtifactRoot(caseId);
  const cwd = process.cwd();
  const toRel = (p: string) => {
    try {
      return relative(cwd, p).replace(/\\/g, "/");
    } catch {
      return `storage/digital-profile/qa-r10-orion-golden-parallel/cases/${safe}`;
    }
  };
  const postPath = arsenkinPostReviewContentPath(caseId);
  const post = readJson<{ reportRunId?: string }>(postPath);
  return {
    caseRootRelative: toRel(caseRoot),
    bindingRelative: toRel(arsenkinReportBindingPath(caseId)),
    bindingExists: existsSync(arsenkinReportBindingPath(caseId)),
    syncMarkerExists: existsSync(arsenkinUiSyncPath(caseId)),
    postReviewExists: existsSync(postPath),
    postReviewReportRunId: post?.reportRunId ? String(post.reportRunId) : null,
  };
}

/**
 * Load canonical case-scoped post-review content only (never shared QA roots).
 */
export function loadCanonicalPostReviewClientContent(caseId: string): {
  reportRunId: string;
  caseId: string;
  path: string;
} | null {
  const path = arsenkinPostReviewContentPath(caseId);
  const data = readJson<{ reportRunId?: string; caseId?: string }>(path);
  if (!data || data.caseId !== caseId || !data.reportRunId) return null;
  return { reportRunId: String(data.reportRunId), caseId, path };
}

/**
 * Prefer transferred Arsenkin effective run; otherwise inventory/fallback.
 * Never returns sourceReportRunId when an Arsenkin transfer binding is active
 * (including CLIENT_CONTENT_NOT_PROMOTED — rebuild must still target Arsenkin).
 */
export function resolveEffectiveReportRunIdForCase(
  caseId: string,
  fallbackReportRunId: string
): {
  reportRunId: string;
  fromArsenkinBinding: boolean;
  binding: ArsenkinReportBinding | null;
  diagnostics: ReturnType<typeof arsenkinBindingStorageDiagnostics>;
} {
  const diagnostics = arsenkinBindingStorageDiagnostics(caseId);
  const binding = loadArsenkinReportBinding(caseId);
  if (
    binding &&
    binding.effectiveReportRunId &&
    isArsenkinRunId(binding.effectiveReportRunId) &&
    (binding.status === "TRANSFERRED" ||
      binding.status === "REPORT_BOUND" ||
      (binding.status === "TRANSFER_FAILED" &&
        binding.contentPromotionError === "CLIENT_CONTENT_NOT_PROMOTED"))
  ) {
    return {
      reportRunId: binding.effectiveReportRunId,
      fromArsenkinBinding: true,
      binding,
      diagnostics,
    };
  }
  return {
    reportRunId: fallbackReportRunId,
    fromArsenkinBinding: false,
    binding,
    diagnostics,
  };
}

/**
 * Verify transfer is honest: binding + post-review both on Arsenkin run.
 * Marks TRANSFER_FAILED / CLIENT_CONTENT_NOT_PROMOTED when content lags.
 */
export function inspectArsenkinTransferContentGate(caseId: string): {
  ok: boolean;
  status: ArsenkinTransferStatus | null;
  reason: string | null;
  binding: ArsenkinReportBinding | null;
  postReviewReportRunId: string | null;
} {
  const binding = loadArsenkinReportBinding(caseId);
  if (!binding) {
    return { ok: true, status: null, reason: null, binding: null, postReviewReportRunId: null };
  }
  if (binding.status === "TRANSFER_FAILED") {
    return {
      ok: false,
      status: "TRANSFER_FAILED",
      reason: binding.lastError ?? binding.contentPromotionError ?? "TRANSFER_FAILED",
      binding,
      postReviewReportRunId: loadCanonicalPostReviewClientContent(caseId)?.reportRunId ?? null,
    };
  }
  if (!isArsenkinTransferRenderReady(binding)) {
    return {
      ok: true,
      status: binding.status,
      reason: null,
      binding,
      postReviewReportRunId: loadCanonicalPostReviewClientContent(caseId)?.reportRunId ?? null,
    };
  }
  const post = loadCanonicalPostReviewClientContent(caseId);
  if (!post || post.reportRunId !== binding.effectiveReportRunId) {
    const reason = "CLIENT_CONTENT_NOT_PROMOTED";
    saveArsenkinReportBinding({
      ...binding,
      status: "TRANSFER_FAILED",
      lastError: reason,
      contentPromotionError: reason,
    });
    return {
      ok: false,
      status: "TRANSFER_FAILED",
      reason,
      binding: { ...binding, status: "TRANSFER_FAILED", contentPromotionError: reason },
      postReviewReportRunId: post?.reportRunId ?? null,
    };
  }
  return {
    ok: true,
    status: binding.status,
    reason: null,
    binding,
    postReviewReportRunId: post.reportRunId,
  };
}

export type ArsenkinRenderBindingIssue = {
  code:
    | "ARSENKIN_REPORT_BINDING_MISMATCH"
    | "ARSENKIN_CLIENT_CONTENT_RUN_MISMATCH"
    | "ARSENKIN_OBSERVATIONS_MISSING"
    | "ARSENKIN_PROVIDER_TASK_PROVENANCE_MISSING"
    | "ARSENKIN_COVERAGE_MISSING"
    | "ARSENKIN_SUGGESTION_ASSETS_MISSING"
    | "ARSENKIN_OUTPUT_BINDING_MISMATCH"
    | "CLIENT_CONTENT_NOT_PROMOTED";
  detail: string;
};

export class ArsenkinReportBindingError extends Error {
  readonly code: ArsenkinRenderBindingIssue["code"];
  readonly issues: ArsenkinRenderBindingIssue[];

  constructor(issues: ArsenkinRenderBindingIssue[]) {
    const primary = issues[0];
    super(primary ? `${primary.code}: ${primary.detail}` : "ARSENKIN_REPORT_BINDING_MISMATCH");
    this.name = "ArsenkinReportBindingError";
    this.code = primary?.code ?? "ARSENKIN_REPORT_BINDING_MISMATCH";
    this.issues = issues;
  }
}

/**
 * Fail-closed checks when case has TRANSFERRED/REPORT_BOUND Arsenkin binding.
 * Returns skipped=true when no active transfer (legacy ORION path).
 */
export function assertArsenkinTransferredClientContent(input: {
  caseId: string;
  clientContentReportRunId: string;
  binding?: ArsenkinReportBinding | null;
  observationCount?: number;
  providerTaskCount?: number;
  coverageCount?: number;
  requireCanarySuggestions?: boolean;
  hasYandexRuAutocomplete?: boolean;
  hasGoogleRuAutocomplete?: boolean;
}):
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; binding: ArsenkinReportBinding }
  | { ok: false; issues: ArsenkinRenderBindingIssue[] } {
  const binding = input.binding ?? loadArsenkinReportBinding(input.caseId);
  if (!isArsenkinTransferRenderReady(binding)) {
    return { ok: true, skipped: true };
  }

  const issues: ArsenkinRenderBindingIssue[] = [];
  const expected = binding.effectiveReportRunId;
  if (input.clientContentReportRunId !== expected) {
    issues.push({
      code: "ARSENKIN_CLIENT_CONTENT_RUN_MISMATCH",
      detail: `clientContent.reportRunId=${input.clientContentReportRunId} expected=${expected}`,
    });
  }
  if (typeof input.observationCount === "number" && input.observationCount <= 0) {
    issues.push({
      code: "ARSENKIN_OBSERVATIONS_MISSING",
      detail: "SerpObservation provider=arsenkin count is 0 for effective run",
    });
  }
  if (typeof input.providerTaskCount === "number" && input.providerTaskCount <= 0) {
    issues.push({
      code: "ARSENKIN_PROVIDER_TASK_PROVENANCE_MISSING",
      detail: "ProviderTask count is 0 for effective run",
    });
  }
  if (typeof input.coverageCount === "number" && input.coverageCount <= 0) {
    issues.push({
      code: "ARSENKIN_COVERAGE_MISSING",
      detail: "SurfaceCollectionCoverage count is 0 for effective run",
    });
  }
  if (input.requireCanarySuggestions) {
    if (!input.hasYandexRuAutocomplete || !input.hasGoogleRuAutocomplete) {
      issues.push({
        code: "ARSENKIN_SUGGESTION_ASSETS_MISSING",
        detail: "Canary requires Yandex RU + Google RU autocomplete observations",
      });
    }
  }
  if (issues.length) {
    return { ok: false, issues };
  }
  return { ok: true, skipped: false, binding };
}

/** Post-render output must target Arsenkin effective run. */
export function assertArsenkinRenderOutputArtifacts(input: {
  binding: ArsenkinReportBinding;
  clientContentBinding?: { effectiveReportRunId?: string; sourceReportRunId?: string } | null;
  runScopedMerge?: { auditRunId?: string; observationCount?: number } | null;
  provenanceLength?: number;
}): { ok: true } | { ok: false; issues: ArsenkinRenderBindingIssue[] } {
  const expected = input.binding.effectiveReportRunId;
  const issues: ArsenkinRenderBindingIssue[] = [];
  if (input.clientContentBinding?.effectiveReportRunId !== expected) {
    issues.push({
      code: "ARSENKIN_OUTPUT_BINDING_MISMATCH",
      detail: `output client-content-binding.effectiveReportRunId=${input.clientContentBinding?.effectiveReportRunId ?? "missing"} expected=${expected}`,
    });
  }
  if (input.runScopedMerge?.auditRunId !== expected) {
    issues.push({
      code: "ARSENKIN_OUTPUT_BINDING_MISMATCH",
      detail: `output run-scoped-serp-merge.auditRunId=${input.runScopedMerge?.auditRunId ?? "missing"} expected=${expected}`,
    });
  }
  if (typeof input.provenanceLength === "number" && input.provenanceLength <= 0) {
    issues.push({
      code: "ARSENKIN_OBSERVATIONS_MISSING",
      detail: "output serp-observations-provenance is empty",
    });
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true };
}
