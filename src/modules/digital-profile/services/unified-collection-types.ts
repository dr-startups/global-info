/**
 * Unified ORION collection job types: base (Yandex/Serper) + Arsenkin enrichment → composite → Golden.
 */

export type UnifiedCollectionStage =
  | "BASE_COLLECTION"
  | "ARSENKIN_ENRICHMENT"
  | "COMPOSITE_MERGE"
  | "ORION_PREPARE"
  | "CLIENT_CONTENT"
  | "REPORT_READY"
  | "COMPLETED_PARTIAL"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "CANCELLED";

export type ActualProviderRuntime = "real" | "mock" | "none";

export type ActualProviderRecord = {
  providerId: string;
  agentName?: string;
  runtime: ActualProviderRuntime;
  status: "completed" | "failed" | "skipped" | "unavailable";
  reason?: string;
};

export type SurfaceTerminalStatus =
  | "MEASURED"
  | "NO_RESULTS"
  | "NOT_SUPPORTED"
  | "FAILED_RETRYABLE"
  | "FAILED_FINAL"
  | "IN_FLIGHT"
  | "PLANNED";

export type SurfaceCoverageBreakdown = {
  plannedSupportedSurfaces: number;
  measured: number;
  noResults: number;
  notSupported: number;
  failedFinal: number;
  failedRetryable: number;
  inFlight: number;
  /** Terminal count / plannedSupportedSurfaces */
  progressRatio: number;
};

export type BaseCollectionManifest = {
  version: "base-collection-manifest-v1";
  unifiedJobId: string;
  caseId: string;
  capturedAt: string;
  baseReportRunId: string | null;
  searchResultIds: string[];
  searchSurfaceItemIds: string[];
  baseCount: number;
  actualProviders: ActualProviderRecord[];
  /** True when every required collection provider completed as real (not mock fallback). */
  realCollectionSufficient: boolean;
};

export type ReportDataBinding = {
  version: "report-data-binding-v1";
  caseId: string;
  unifiedJobId: string;
  baseReportRunId: string | null;
  enrichmentRunIds: string[];
  compositeDatasetId: string;
  providerCounts: {
    yandex: number;
    serper: number;
    arsenkin: number;
    composite: number;
  };
  generatedAt: string;
};

export type UnifiedCollectionJob = {
  version: "unified-orion-collection-job-v1";
  jobId: string;
  unifiedJobId: string;
  caseId: string;
  stage: UnifiedCollectionStage;
  status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress: number;
  versionNum: number;
  leaseOwnerId: string | null;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string | null;
  requestedBy: string;
  arsenkinMode: "full-first36";
  baseReportRunId: string | null;
  arsenkinReportRunId: string | null;
  /** Five Arsenkin CaseAgent enrichment run ids when scheduled. */
  enrichmentRunIds?: string[];
  compositeDatasetId: string | null;
  actualProviders: ActualProviderRecord[];
  coverage: SurfaceCoverageBreakdown | null;
  warnings: string[];
  lastError: string | null;
  lastErrorCode: string | null;
  artifactPaths: Record<string, string>;
  reportLinks: { pdf?: string; pptx?: string };
  cancelRequested: boolean;
  /** Set by staff recover endpoint — never written by client. */
  recoveryAudit?: {
    recoveredFromStatus: string;
    recoveredFromStage: string;
    recoveryRequestedAt: string;
    recoveryRequestedBy: string;
    recoveryReason: string;
    previousLastError: string | null;
    previousLastErrorCode: string | null;
  };
  /**
   * Precise resume target after FAILED_RETRYABLE.
   * RENDER = skip base/Arsenkin/composite/analytics/assembly when payload valid.
   */
  resumeCheckpoint?: "BASE_COLLECTION" | "ARSENKIN_ENRICHMENT" | "ORION_PREPARE" | "RENDER" | null;
};

export const FIRST36_PLANNED_SUPPORTED_SURFACES = [
  "ru_yandex_organic",
  "ru_google_organic",
  "uae_google_organic",
  "ru_yandex_suggestions",
  "ru_google_suggestions",
  "uae_google_suggestions",
  "ru_google_paa",
  "uae_google_paa",
  "ru_yandex_ai",
  "ru_google_ai",
  "uae_google_ai",
  "url_audit",
] as const;

export function emptyCoverage(planned = FIRST36_PLANNED_SUPPORTED_SURFACES.length): SurfaceCoverageBreakdown {
  return {
    plannedSupportedSurfaces: planned,
    measured: 0,
    noResults: 0,
    notSupported: 0,
    failedFinal: 0,
    failedRetryable: 0,
    inFlight: 0,
    progressRatio: 0,
  };
}

export function computeCoverageProgress(c: SurfaceCoverageBreakdown): number {
  if (c.plannedSupportedSurfaces <= 0) return 0;
  const terminal = c.measured + c.noResults + c.notSupported + c.failedFinal;
  return terminal / c.plannedSupportedSurfaces;
}
