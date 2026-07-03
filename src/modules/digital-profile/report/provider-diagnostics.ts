import { resolveRuntimeStrategy } from "../agents/runtime-strategy";
import {
  listComplianceProviderStatus,
  type ComplianceProviderStatus,
} from "../compliance-providers";
import {
  getProviderStatus,
  providerConfig,
  type ProviderStatus,
} from "../providers/config";
import { externalGoogleSerpProvider } from "../providers/external-google-serp-provider";
import type {
  ProviderRuntimeKind,
  ProviderSupportMatrix,
  ReportProviderDiagnosticItem,
  ReportProviderDiagnostics,
  ReportSourceProvenanceRow,
} from "../types";

const NO_SUPPORT: ProviderSupportMatrix = {
  organicSearch: false,
  suggestions: false,
  relatedQueries: false,
  images: false,
  videos: false,
  knowledge: false,
  wikipedia: false,
  compliance: false,
  screenshots: false,
  manualImport: false,
};

/** Static capability support per provider id (display-level; no secrets). */
const PROVIDER_SUPPORTS: Record<string, Partial<ProviderSupportMatrix>> = {
  yandex: { organicSearch: true, suggestions: true, relatedQueries: true, images: true, videos: true },
  google: {
    organicSearch: true,
    suggestions: true,
    relatedQueries: true,
    images: true,
    videos: true,
    knowledge: true,
  },
  serper: { organicSearch: true, images: true, videos: true, knowledge: true },
  wikipedia: { wikipedia: true, knowledge: true },
  compliance: { compliance: true, manualImport: true },
  screenshots: { screenshots: true, manualImport: true },
  synthetic_serp: { screenshots: true },
};

function supportMatrix(id: string): ProviderSupportMatrix {
  return { ...NO_SUPPORT, ...(PROVIDER_SUPPORTS[id] ?? {}) };
}

/**
 * Fill the R4.1 normalized capability fields on a diagnostics item. Never reads
 * or exposes secret values — `hasCredentials` is a boolean only.
 */
function enrichCapability(
  item: ReportProviderDiagnosticItem,
  input: { runtimeKind: ProviderRuntimeKind; requiresSecrets: boolean; hasCredentials: boolean }
): ReportProviderDiagnosticItem {
  // A provider is "available" when it can contribute to the report — only
  // unconfigured or failed providers are unavailable. Manual/stub/synthetic
  // paths still reach the report.
  const available = item.status !== "not_configured" && item.status !== "failed";
  const productionReady = item.status === "ready" && item.risk === "low";
  return {
    ...item,
    runtimeKind: input.runtimeKind,
    requiresSecrets: input.requiresSecrets,
    hasCredentials: input.hasCredentials,
    available,
    productionReady,
    supports: supportMatrix(item.id),
  };
}

function normalizeProviderStatus(
  status: ProviderStatus,
  runtime: ReturnType<typeof resolveRuntimeStrategy>
): ReportProviderDiagnosticItem {
  const missingCount = status.missingConfigKeys.length;
  const activeReal = status.status === "ENABLED" && status.supportsRealCalls;
  const providerId = status.name.toLowerCase();
  const fallback = runtime.fallbackEvents.find((e) => e.providerId === providerId);
  const selectedByStrategy = runtime.steps.some((s) => s.providerId === providerId);
  const skippedReason =
    !selectedByStrategy && runtime.mode !== "legacy_mock_first"
      ? `Skipped by strategy mode ${runtime.mode}.`
      : undefined;
  const item: ReportProviderDiagnosticItem = {
    id: providerId,
    label: status.label,
    category: status.name === "WIKIPEDIA" ? "knowledge" : "search",
    status: activeReal ? "ready" : status.status === "ENABLED" ? "configured" : "not_configured",
    runtimeMode: status.kind === "MOCK" ? "mock" : "real",
    reachesReport: true,
    clientVisible: true,
    risk: activeReal ? "low" : "medium",
    message: activeReal
      ? "Configured and available for collection."
      : status.status === "NOT_CONFIGURED"
        ? "Configuration is incomplete."
        : "Provider is disabled.",
    safeDetail:
      missingCount > 0
        ? `${missingCount} required configuration item(s) missing.`
        : undefined,
    internalDetail:
      missingCount > 0
        ? `Missing configuration class: ${status.name} credentials/settings incomplete.`
        : undefined,
    selectedByStrategy,
    skippedReason,
    fallbackReason: fallback?.reason,
    configured: status.configured,
    capabilityLevel:
      status.kind === "MOCK" ? "mock" : activeReal ? "full" : status.configured ? "partial" : "none",
  };
  const requiresSecrets = status.name !== "WIKIPEDIA";
  return enrichCapability(item, {
    runtimeKind: status.kind === "MOCK" ? "mock" : "real",
    requiresSecrets,
    hasCredentials: requiresSecrets ? status.missingConfigKeys.length === 0 : true,
  });
}

function buildSerperDiagnostics(
  runtime: ReturnType<typeof resolveRuntimeStrategy>
): ReportProviderDiagnosticItem {
  const s = externalGoogleSerpProvider.status();
  const strategy = providerConfig.google.provider;
  const selectedExternal = strategy === "external_serp";
  const ready = selectedExternal && s.state === "READY";
  const fallback = selectedExternal && s.state !== "READY";
  const status: ReportProviderDiagnosticItem["status"] = ready
    ? "ready"
    : fallback
      ? "fallback"
      : "configured";
  const risk: ReportProviderDiagnosticItem["risk"] = ready
    ? "low"
    : selectedExternal
      ? "medium"
      : "low";
  const item: ReportProviderDiagnosticItem = {
    id: "serper",
    label: "Serper external strategy",
    category: "surface",
    status,
    runtimeMode: ready ? "real" : selectedExternal ? "mixed" : "unknown",
    reachesReport: true,
    clientVisible: true,
    risk,
    message: ready
      ? "External SERP adapter is ready."
      : selectedExternal
        ? "External SERP strategy selected but not fully ready."
        : "External SERP strategy is not active.",
    safeDetail:
      selectedExternal && !ready ? "External adapter requires complete configuration." : undefined,
    internalDetail:
      selectedExternal && !ready
        ? `External adapter state: ${s.state.toLowerCase().replaceAll("_", " ")}.`
        : undefined,
    selectedByStrategy: runtime.steps.some((step) => step.providerId === "google"),
    configured: selectedExternal ? Boolean(providerConfig.google.external.apiKey) : false,
    capabilityLevel: ready ? "full" : selectedExternal ? "partial" : "none",
  };
  return enrichCapability(item, {
    runtimeKind: ready ? "real" : "stub",
    requiresSecrets: true,
    hasCredentials: Boolean(providerConfig.google.external.apiKey),
  });
}

function buildComplianceDiagnostics(
  statuses: ComplianceProviderStatus[],
  runtime: ReturnType<typeof resolveRuntimeStrategy>
): ReportProviderDiagnosticItem {
  const realStatuses = statuses.filter((s) => s.kind === "REAL");
  const configuredReal = realStatuses.filter((s) => s.status === "ENABLED").length;
  const missingBuckets = realStatuses.filter((s) => s.missingConfigKeys.length > 0).length;
  const item: ReportProviderDiagnosticItem = {
    id: "compliance",
    label: "Compliance providers",
    category: "compliance",
    status: "stub",
    runtimeMode: "manual",
    reachesReport: true,
    clientVisible: true,
    risk: "high",
    message:
      "Manual import path is active; official paid adapters in this build are stubs.",
    safeDetail:
      configuredReal > 0
        ? `${configuredReal} provider(s) configured, but runtime remains manual/stub in current build.`
        : "Official providers are not fully configured; manual import remains the active path.",
    internalDetail:
      missingBuckets > 0
        ? `${missingBuckets} compliance provider(s) have missing configuration groups.`
        : "Compliance real adapters resolve to not-implemented stubs in this build.",
    selectedByStrategy: runtime.steps.some((step) => step.providerId === "compliance"),
    configured: configuredReal > 0,
    capabilityLevel: "stub",
  };
  return enrichCapability(item, {
    runtimeKind: "manual",
    requiresSecrets: true,
    hasCredentials: configuredReal > 0,
  });
}

function auditMode(runtime: ReturnType<typeof resolveRuntimeStrategy>): ReportProviderDiagnostics["auditMode"] {
  const mode =
    runtime.mode === "legacy_mock_first"
      ? "mock_first"
      : runtime.mode === "real_only" || runtime.mode === "real_first_with_fallback"
        ? "real_first"
        : "mixed";
  const notes =
    runtime.mode === "legacy_mock_first"
      ? ["Full audit currently resolves to mock-first execution order."]
      : runtime.mode === "real_first_with_fallback"
        ? ["Runtime prefers real agents and allows deterministic mock fallback."]
        : runtime.mode === "real_only"
          ? ["Runtime executes only real agents; unavailable providers are skipped."]
          : ["Runtime executes mock-only strategy for deterministic test runs."];
  return {
    fullAuditOrderMode: mode,
    isMockDefault: runtime.mode === "legacy_mock_first",
    notes: [...notes, ...runtime.warnings],
  };
}

export function summarizeProviderDiagnostics(
  providers: ReportProviderDiagnosticItem[],
  runtime?: ReturnType<typeof resolveRuntimeStrategy>
): ReportProviderDiagnostics["summary"] {
  const readyCount = providers.filter((p) => p.status === "ready").length;
  const realCount = providers.filter((p) => p.runtimeMode === "real").length;
  const mockOrStubCount = providers.filter(
    (p) => p.runtimeMode === "mock" || p.status === "stub"
  ).length;
  const highRiskCount = providers.filter((p) => p.risk === "high").length;
  const productionReady = highRiskCount === 0 && readyCount >= 3;
  // R4.1 — richer additive counts.
  const totalProviders = providers.length;
  const manualCount = providers.filter(
    (p) => p.runtimeKind === "manual" || p.runtimeMode === "manual"
  ).length;
  const unavailableCount = providers.filter(
    (p) => p.available === false || p.status === "not_configured" || p.status === "failed"
  ).length;
  const productionReadyCount = providers.filter((p) => p.productionReady === true).length;
  const fallbackUsedCount = runtime ? runtime.fallbackEvents.length : undefined;
  return {
    readyCount,
    realCount,
    mockOrStubCount,
    highRiskCount,
    productionReady,
    totalProviders,
    manualCount,
    unavailableCount,
    productionReadyCount,
    fallbackUsedCount,
  };
}

/** Surface collection totals used to derive per-provider provenance counts. */
export interface ProviderSurfaceTotals {
  organicCollected?: number;
  organicIncluded?: number;
  organicReview?: number;
  organicExcluded?: number;
  mediaCollected?: number;
  mediaIncluded?: number;
  wikipediaCollected?: number;
  wikipediaIncluded?: number;
  complianceCollected?: number;
  complianceIncluded?: number;
  complianceReview?: number;
  complianceExcluded?: number;
}

/**
 * Build per-provider source provenance rows from the diagnostics providers and
 * (optionally) surface collection totals. Deterministic; no scoring changes.
 */
export function buildSourceProvenance(
  providers: ReportProviderDiagnosticItem[],
  runtime: ReturnType<typeof resolveRuntimeStrategy>,
  totals: ProviderSurfaceTotals = {}
): ReportSourceProvenanceRow[] {
  const rows: ReportSourceProvenanceRow[] = [];
  for (const p of providers) {
    const fallback = runtime.fallbackEvents.find((e) => e.providerId === p.id);
    const collectionMode: ReportSourceProvenanceRow["collectionMode"] = fallback
      ? "fallback"
      : p.available === false
        ? "unavailable"
        : (p.runtimeKind ?? "mock");
    const inclusionDecision: ReportSourceProvenanceRow["inclusionDecision"] =
      p.available === false
        ? "unavailable"
        : fallback
          ? "fallback"
          : p.status === "stub" || p.runtimeMode === "manual"
            ? "review"
            : "included";
    const row: ReportSourceProvenanceRow = {
      sourceProvider: p.id,
      sourceProviderLabel: p.label,
      sourceCategory: p.category,
      sourceRuntimeKind: p.runtimeKind ?? "mock",
      collectionMode,
      inclusionDecision,
      inclusionReason: p.message,
      fallbackReason: fallback?.reason,
      safeNote: p.safeDetail,
      internalNote: p.internalDetail,
    };
    if (p.id === "yandex" || p.id === "google" || p.id === "serper") {
      row.collected = totals.organicCollected;
      row.included = totals.organicIncluded;
      row.review = totals.organicReview;
      row.excluded = totals.organicExcluded;
    } else if (p.id === "wikipedia") {
      row.collected = totals.wikipediaCollected;
      row.included = totals.wikipediaIncluded;
    } else if (p.id === "compliance") {
      row.collected = totals.complianceCollected;
      row.included = totals.complianceIncluded;
      row.review = totals.complianceReview;
      row.excluded = totals.complianceExcluded;
    } else if (p.id === "screenshots" || p.id === "synthetic_serp") {
      row.collected = totals.mediaCollected;
      row.included = totals.mediaIncluded;
    }
    rows.push(row);
  }
  return rows;
}

export function buildProviderDiagnosticsFixture(input: {
  auditMode: ReportProviderDiagnostics["auditMode"];
  runtimeStrategy: ReportProviderDiagnostics["runtimeStrategy"];
  providers: ReportProviderDiagnosticItem[];
}): ReportProviderDiagnostics {
  return {
    auditMode: input.auditMode,
    runtimeStrategy: input.runtimeStrategy,
    providers: input.providers,
    summary: summarizeProviderDiagnostics(input.providers),
  };
}

export interface BuildProviderDiagnosticsOptions {
  /** Optional runtime mode; defaults to the resolver default (legacy_mock_first). */
  mode?: import("../types").ProviderRuntimeMode;
  requestedBy?: "default" | "request" | "config" | "test";
  /** Optional surface totals for source provenance counts. */
  surfaceTotals?: ProviderSurfaceTotals;
}

export function buildProviderDiagnostics(
  options: BuildProviderDiagnosticsOptions = {}
): ReportProviderDiagnostics {
  const runtime = resolveRuntimeStrategy({
    mode: options.mode,
    requestedBy: options.requestedBy ?? (options.mode ? "config" : "default"),
  });
  const providers: ReportProviderDiagnosticItem[] = [];
  const yandex = normalizeProviderStatus(getProviderStatus("YANDEX"), runtime);
  const google = normalizeProviderStatus(getProviderStatus("GOOGLE"), runtime);
  const wikipedia = normalizeProviderStatus(getProviderStatus("WIKIPEDIA"), runtime);
  const serper = buildSerperDiagnostics(runtime);
  const compliance = buildComplianceDiagnostics(listComplianceProviderStatus(), runtime);
  providers.push(yandex, google, serper, wikipedia, compliance);
  providers.push(
    enrichCapability(
      {
        id: "screenshots",
        label: "Screenshots",
        category: "screenshot",
        status: "ready",
        runtimeMode: "manual",
        reachesReport: true,
        clientVisible: true,
        risk: "low",
        message: "Manual screenshot uploads are available.",
        safeDetail: "Captured files are stored and linked as evidence.",
        selectedByStrategy: runtime.steps.some((step) => step.providerId === "surfaces"),
        configured: true,
        capabilityLevel: "partial",
      },
      { runtimeKind: "manual", requiresSecrets: false, hasCredentials: true }
    )
  );
  providers.push(
    enrichCapability(
      {
        id: "synthetic_serp",
        label: "Synthetic SERP snapshot",
        category: "pipeline",
        status: "fallback",
        runtimeMode: "synthetic",
        reachesReport: true,
        clientVisible: true,
        risk: "medium",
        message: "Synthetic SERP visual is used when available from stored evidence.",
        safeDetail: "Snapshot page uses generated visual from collected rows.",
        selectedByStrategy: runtime.steps.some((step) => step.providerId === "surfaces"),
        configured: true,
        capabilityLevel: "stub",
      },
      { runtimeKind: "synthetic", requiresSecrets: false, hasCredentials: false }
    )
  );
  return {
    auditMode: auditMode(runtime),
    runtimeStrategy: {
      mode: runtime.mode,
      selectedOrder: runtime.selectedOrder,
      fallbackPolicy: runtime.fallbackPolicy,
      requestedBy: runtime.requestedBy,
      realProvidersAvailable: runtime.realProvidersAvailable,
      mockProvidersAvailable: runtime.mockProvidersAvailable,
      fallbackEvents: runtime.fallbackEvents,
      warnings: runtime.warnings,
    },
    providers,
    summary: summarizeProviderDiagnostics(providers, runtime),
    sourceProvenance: buildSourceProvenance(providers, runtime, options.surfaceTotals),
  };
}
