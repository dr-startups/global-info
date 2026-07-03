import {
  FULL_AUDIT_ORDER,
  MOCK_FULL_AUDIT_ORDER,
  REAL_SAFE_AUDIT_ORDER,
} from "../agents/registry";
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

function normalizeProviderStatus(status: ProviderStatus): ReportProviderDiagnosticItem {
  const missingCount = status.missingConfigKeys.length;
  const activeReal = status.status === "ENABLED" && status.supportsRealCalls;
  return {
    id: status.name.toLowerCase(),
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
  };
}

function buildSerperDiagnostics(): ReportProviderDiagnosticItem {
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
  };
}

function buildComplianceDiagnostics(
  statuses: ComplianceProviderStatus[]
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
  };
}

function auditMode(): ReportProviderDiagnostics["auditMode"] {
  const sameAsMock =
    FULL_AUDIT_ORDER.length === MOCK_FULL_AUDIT_ORDER.length &&
    FULL_AUDIT_ORDER.every((v, i) => v === MOCK_FULL_AUDIT_ORDER[i]);
  const sameAsReal =
    FULL_AUDIT_ORDER.length === REAL_SAFE_AUDIT_ORDER.length &&
    FULL_AUDIT_ORDER.every((v, i) => v === REAL_SAFE_AUDIT_ORDER[i]);
  const mode = sameAsMock ? "mock_first" : sameAsReal ? "real_first" : "mixed";
  const notes =
    mode === "mock_first"
      ? ["Full audit currently resolves to mock-first execution order."]
      : mode === "real_first"
        ? ["Full audit currently resolves to real-first execution order."]
        : ["Full audit order includes mixed or custom agent sequence."];
  return {
    fullAuditOrderMode: mode,
    isMockDefault: mode === "mock_first",
    notes,
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
  providers: ReportProviderDiagnosticItem[];
}): ReportProviderDiagnostics {
  return {
    auditMode: input.auditMode,
    providers: input.providers,
    summary: summarizeProviderDiagnostics(input.providers),
  };
}

export function buildProviderDiagnostics(): ReportProviderDiagnostics {
  const providers: ReportProviderDiagnosticItem[] = [];
  const yandex = normalizeProviderStatus(getProviderStatus("YANDEX"));
  const google = normalizeProviderStatus(getProviderStatus("GOOGLE"));
  const wikipedia = normalizeProviderStatus(getProviderStatus("WIKIPEDIA"));
  const serper = buildSerperDiagnostics();
  const compliance = buildComplianceDiagnostics(listComplianceProviderStatus());
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
  });
  return {
    auditMode: auditMode(),
    providers,
    summary: summarizeProviderDiagnostics(providers),
  };
}
