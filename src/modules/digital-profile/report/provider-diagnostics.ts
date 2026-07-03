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
  ReportProviderDiagnosticItem,
  ReportProviderDiagnostics,
} from "../types";

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
  return {
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
  return {
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
}

function buildComplianceDiagnostics(
  statuses: ComplianceProviderStatus[],
  runtime: ReturnType<typeof resolveRuntimeStrategy>
): ReportProviderDiagnosticItem {
  const realStatuses = statuses.filter((s) => s.kind === "REAL");
  const configuredReal = realStatuses.filter((s) => s.status === "ENABLED").length;
  const missingBuckets = realStatuses.filter((s) => s.missingConfigKeys.length > 0).length;
  return {
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
        : "Compliance real adapters resolve to PROVIDER_NOT_IMPLEMENTED stubs in this build.",
    selectedByStrategy: runtime.steps.some((step) => step.providerId === "compliance"),
    configured: configuredReal > 0,
    capabilityLevel: "stub",
  };
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
  providers: ReportProviderDiagnosticItem[]
): ReportProviderDiagnostics["summary"] {
  const readyCount = providers.filter((p) => p.status === "ready").length;
  const realCount = providers.filter((p) => p.runtimeMode === "real").length;
  const mockOrStubCount = providers.filter(
    (p) => p.runtimeMode === "mock" || p.status === "stub"
  ).length;
  const highRiskCount = providers.filter((p) => p.risk === "high").length;
  const productionReady = highRiskCount === 0 && readyCount >= 3;
  return { readyCount, realCount, mockOrStubCount, highRiskCount, productionReady };
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

export function buildProviderDiagnostics(): ReportProviderDiagnostics {
  const runtime = resolveRuntimeStrategy();
  const providers: ReportProviderDiagnosticItem[] = [];
  const yandex = normalizeProviderStatus(getProviderStatus("YANDEX"), runtime);
  const google = normalizeProviderStatus(getProviderStatus("GOOGLE"), runtime);
  const wikipedia = normalizeProviderStatus(getProviderStatus("WIKIPEDIA"), runtime);
  const serper = buildSerperDiagnostics(runtime);
  const compliance = buildComplianceDiagnostics(listComplianceProviderStatus(), runtime);
  providers.push(yandex, google, serper, wikipedia, compliance);
  providers.push({
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
  });
  providers.push({
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
  });
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
    summary: summarizeProviderDiagnostics(providers),
  };
}
