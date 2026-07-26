import { getAgent } from "./registry";
import type { AgentAvailability } from "./types";
import type {
  ProviderFallbackPolicy,
  ProviderRuntimeMode,
  ReportProviderDiagnostics,
} from "../types";

export interface RuntimeStrategyRequest {
  mode?: ProviderRuntimeMode;
  requestedBy?: "default" | "request" | "config" | "test";
  availabilityOverride?: Record<string, boolean>;
}

export const FULL_AUDIT_DEFAULT_RUNTIME_MODE: ProviderRuntimeMode = "real_first_with_fallback";

export interface RuntimeStrategyStep {
  providerId: string;
  phase: "collection" | "surfaces" | "enrichment" | "report";
  primaryAgent: string;
  primaryRuntime: "real" | "mock";
  fallbackAgent?: string;
}

export interface RuntimeStrategyDecision {
  providerId: string;
  phase: "collection" | "surfaces" | "enrichment" | "report";
  status: "selected" | "skipped_unavailable" | "skipped_by_mode";
  selectedAgent?: string;
  selectedRuntime?: "real" | "mock";
  fallbackAgent?: string;
  realReady: boolean;
  mockReady: boolean;
  reason: string;
}

export interface ResolvedRuntimeStrategy {
  mode: ProviderRuntimeMode;
  selectedOrder: string[];
  fallbackPolicy: ProviderFallbackPolicy;
  requestedBy: "default" | "request" | "config" | "test";
  realProvidersAvailable: number;
  mockProvidersAvailable: number;
  fallbackEvents: ReportProviderDiagnostics["runtimeStrategy"]["fallbackEvents"];
  warnings: string[];
  steps: RuntimeStrategyStep[];
  decisions: RuntimeStrategyDecision[];
}

interface CapabilityPair {
  providerId: string;
  phase: RuntimeStrategyStep["phase"];
  realAgent?: string;
  mockAgent?: string;
}

const CAPABILITY_PAIRS: CapabilityPair[] = [
  { providerId: "yandex", phase: "collection", realAgent: "REAL_YANDEX_SEARCH", mockAgent: "YANDEX_SEARCH" },
  { providerId: "google", phase: "collection", realAgent: "REAL_GOOGLE_SEARCH", mockAgent: "GOOGLE_SEARCH" },
  { providerId: "wikipedia", phase: "collection", realAgent: "REAL_WIKIPEDIA", mockAgent: "WIKIPEDIA" },
  {
    providerId: "orion_profile",
    phase: "collection",
    realAgent: "REAL_ORION_SEARCH_PROFILE",
  },
  {
    providerId: "orion_uae_international",
    phase: "collection",
    realAgent: "REAL_ORION_UAE_INTERNATIONAL",
  },
  {
    providerId: "surfaces",
    phase: "surfaces",
    realAgent: "REAL_SEARCH_SURFACES",
    mockAgent: "SEARCH_SURFACES",
  },
  {
    providerId: "orion_google_surfaces",
    phase: "surfaces",
    realAgent: "REAL_ORION_GOOGLE_SURFACES",
  },
  { providerId: "ai_profile", phase: "enrichment", mockAgent: "AI_PROFILE" },
  { providerId: "compliance", phase: "enrichment", mockAgent: "COMPLIANCE_DATABASE" },
  {
    providerId: "risk",
    phase: "enrichment",
    realAgent: "RISK_CLASSIFIER_V1",
    mockAgent: "RISK_CLASSIFIER",
  },
  { providerId: "audit_summary", phase: "report", realAgent: "AUDIT_SUMMARY_BUILDER" },
];

function isEnabled(name: string | undefined, availabilityOverride?: Record<string, boolean>): boolean {
  if (!name) return false;
  if (availabilityOverride && Object.prototype.hasOwnProperty.call(availabilityOverride, name)) {
    return Boolean(availabilityOverride[name]);
  }
  const a: AgentAvailability | undefined = getAgent(name)?.availability();
  return a?.status === "ENABLED";
}

function base(
  mode: ProviderRuntimeMode,
  requestedBy: ResolvedRuntimeStrategy["requestedBy"]
): ResolvedRuntimeStrategy {
  return {
    mode,
    selectedOrder: [],
    fallbackPolicy:
      mode === "real_only"
        ? "no_mock_fallback"
        : mode === "mock_only"
          ? "allow_empty_fallback"
          : "allow_mock_fallback",
    requestedBy,
    realProvidersAvailable: 0,
    mockProvidersAvailable: 0,
    fallbackEvents: [],
    warnings: [],
    steps: [],
    decisions: [],
  };
}

function pushSelected(
  strategy: ResolvedRuntimeStrategy,
  pair: CapabilityPair,
  selected: {
    agent: string;
    runtime: "real" | "mock";
    fallbackAgent?: string;
    reason: string;
    realReady: boolean;
    mockReady: boolean;
  }
): void {
  strategy.steps.push({
    providerId: pair.providerId,
    phase: pair.phase,
    primaryAgent: selected.agent,
    primaryRuntime: selected.runtime,
    fallbackAgent: selected.fallbackAgent,
  });
  strategy.decisions.push({
    providerId: pair.providerId,
    phase: pair.phase,
    status: "selected",
    selectedAgent: selected.agent,
    selectedRuntime: selected.runtime,
    fallbackAgent: selected.fallbackAgent,
    realReady: selected.realReady,
    mockReady: selected.mockReady,
    reason: selected.reason,
  });
}

function pushSkipped(
  strategy: ResolvedRuntimeStrategy,
  pair: CapabilityPair,
  input: {
    status: "skipped_unavailable" | "skipped_by_mode";
    reason: string;
    realReady: boolean;
    mockReady: boolean;
  }
): void {
  strategy.decisions.push({
    providerId: pair.providerId,
    phase: pair.phase,
    status: input.status,
    realReady: input.realReady,
    mockReady: input.mockReady,
    reason: input.reason,
  });
  strategy.warnings.push(`${pair.providerId}: ${input.reason}`);
}

export function resolveRuntimeStrategy(input: RuntimeStrategyRequest = {}): ResolvedRuntimeStrategy {
  const mode = input.mode ?? "legacy_mock_first";
  const strategy = base(mode, input.requestedBy ?? "default");

  for (const pair of CAPABILITY_PAIRS) {
    const realReady = isEnabled(pair.realAgent, input.availabilityOverride);
    const mockReady = isEnabled(pair.mockAgent, input.availabilityOverride);
    if (realReady) strategy.realProvidersAvailable += 1;
    if (mockReady) strategy.mockProvidersAvailable += 1;

    if (mode === "mock_only") {
      if (pair.mockAgent && mockReady) {
        pushSelected(strategy, pair, {
          agent: pair.mockAgent,
          runtime: "mock",
          reason: "mock_only policy selected the mock agent.",
          realReady,
          mockReady,
        });
      } else {
        pushSkipped(strategy, pair, {
          status: pair.mockAgent ? "skipped_unavailable" : "skipped_by_mode",
          reason: pair.mockAgent
            ? "mock agent unavailable or not configured."
            : "provider has no mock implementation in mock_only mode.",
          realReady,
          mockReady,
        });
      }
      continue;
    }

    if (mode === "real_only") {
      if (pair.realAgent && realReady) {
        pushSelected(strategy, pair, {
          agent: pair.realAgent,
          runtime: "real",
          reason: "real_only policy selected the real agent.",
          realReady,
          mockReady,
        });
      } else {
        pushSkipped(strategy, pair, {
          status: pair.realAgent ? "skipped_unavailable" : "skipped_by_mode",
          reason: pair.realAgent
            ? "real agent unavailable or not configured; skipped by real_only policy."
            : "provider has no real implementation in real_only mode.",
          realReady,
          mockReady,
        });
      }
      continue;
    }

    if (mode === "legacy_mock_first") {
      if (pair.mockAgent && mockReady) {
        pushSelected(strategy, pair, {
          agent: pair.mockAgent,
          runtime: "mock",
          reason: "legacy_mock_first selected mock agent first.",
          realReady,
          mockReady,
        });
      } else if (pair.realAgent && realReady) {
        pushSelected(strategy, pair, {
          agent: pair.realAgent,
          runtime: "real",
          reason: "legacy_mock_first had no mock; real agent selected as best available.",
          realReady,
          mockReady,
        });
        strategy.fallbackEvents.push({
          providerId: pair.providerId,
          reason: "Mock agent unavailable; real implementation selected in legacy mode.",
          from: "mock",
          to: "real",
        });
      } else {
        pushSkipped(strategy, pair, {
          status: "skipped_unavailable",
          reason: "no available agent in legacy_mock_first mode.",
          realReady,
          mockReady,
        });
      }
      continue;
    }

    if (pair.realAgent && realReady) {
      pushSelected(strategy, pair, {
        agent: pair.realAgent,
        runtime: "real",
        fallbackAgent: pair.mockAgent && mockReady ? pair.mockAgent : undefined,
        reason: "real_first_with_fallback selected the real agent.",
        realReady,
        mockReady,
      });
      if (pair.mockAgent && !mockReady) {
        strategy.warnings.push(`${pair.providerId}: mock fallback unavailable.`);
      }
    } else if (pair.mockAgent && mockReady) {
      pushSelected(strategy, pair, {
        agent: pair.mockAgent,
        runtime: "mock",
        reason: "real agent unavailable; selected mock fallback.",
        realReady,
        mockReady,
      });
      strategy.fallbackEvents.push({
        providerId: pair.providerId,
        reason: "Real agent unavailable; mock fallback selected.",
        from: "real",
        to: "mock",
      });
    } else {
      pushSkipped(strategy, pair, {
        status: "skipped_unavailable",
        reason: "no available agent in current runtime mode.",
        realReady,
        mockReady,
      });
      strategy.fallbackEvents.push({
        providerId: pair.providerId,
        reason: "No available agent; provider skipped.",
        from: "real",
        to: "none",
      });
    }
  }

  strategy.selectedOrder = strategy.steps.map((s) => s.primaryAgent);
  if (mode === "legacy_mock_first") {
    strategy.warnings.push("Legacy mock-first strategy active; mock agents are prioritized.");
  }
  return strategy;
}

export function parseRuntimeMode(raw: unknown): ProviderRuntimeMode | undefined {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (
    value === "legacy_mock_first" ||
    value === "real_first_with_fallback" ||
    value === "real_only" ||
    value === "mock_only"
  ) {
    return value;
  }
  return undefined;
}
