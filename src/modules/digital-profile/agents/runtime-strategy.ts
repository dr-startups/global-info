import { getAgent, MOCK_FULL_AUDIT_ORDER } from "./registry";
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

export interface RuntimeStrategyStep {
  providerId: string;
  primaryAgent: string;
  primaryRuntime: "real" | "mock";
  fallbackAgent?: string;
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
}

interface CapabilityPair {
  providerId: string;
  realAgent?: string;
  mockAgent?: string;
}

const CAPABILITY_PAIRS: CapabilityPair[] = [
  { providerId: "yandex", realAgent: "REAL_YANDEX_SEARCH", mockAgent: "YANDEX_SEARCH" },
  { providerId: "google", realAgent: "REAL_GOOGLE_SEARCH", mockAgent: "GOOGLE_SEARCH" },
  { providerId: "wikipedia", realAgent: "REAL_WIKIPEDIA", mockAgent: "WIKIPEDIA" },
  { providerId: "surfaces", realAgent: "REAL_SEARCH_SURFACES", mockAgent: "SEARCH_SURFACES" },
  { providerId: "ai_profile", mockAgent: "AI_PROFILE" },
  { providerId: "compliance", mockAgent: "COMPLIANCE_DATABASE" },
  { providerId: "risk", realAgent: "RISK_CLASSIFIER_V1", mockAgent: "RISK_CLASSIFIER" },
  { providerId: "audit_summary", realAgent: "AUDIT_SUMMARY_BUILDER" },
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
  };
}

export function resolveRuntimeStrategy(input: RuntimeStrategyRequest = {}): ResolvedRuntimeStrategy {
  const mode = input.mode ?? "legacy_mock_first";
  const strategy = base(mode, input.requestedBy ?? "default");

  for (const pair of CAPABILITY_PAIRS) {
    const realReady = isEnabled(pair.realAgent, input.availabilityOverride);
    const mockReady = isEnabled(pair.mockAgent, input.availabilityOverride);
    if (realReady) strategy.realProvidersAvailable += 1;
    if (mockReady) strategy.mockProvidersAvailable += 1;

    if (mode === "legacy_mock_first") continue;

    if (mode === "mock_only") {
      if (pair.mockAgent && mockReady) {
        strategy.steps.push({
          providerId: pair.providerId,
          primaryAgent: pair.mockAgent,
          primaryRuntime: "mock",
        });
      } else if (pair.mockAgent && !mockReady) {
        strategy.warnings.push(`${pair.providerId}: mock agent unavailable.`);
      }
      continue;
    }

    if (mode === "real_only") {
      if (pair.realAgent && realReady) {
        strategy.steps.push({
          providerId: pair.providerId,
          primaryAgent: pair.realAgent,
          primaryRuntime: "real",
        });
      } else {
        strategy.warnings.push(`${pair.providerId}: real agent unavailable; skipped by real_only policy.`);
      }
      continue;
    }

    if (pair.realAgent && realReady) {
      strategy.steps.push({
        providerId: pair.providerId,
        primaryAgent: pair.realAgent,
        primaryRuntime: "real",
        fallbackAgent: pair.mockAgent && mockReady ? pair.mockAgent : undefined,
      });
      if (pair.mockAgent && !mockReady) {
        strategy.warnings.push(`${pair.providerId}: mock fallback unavailable.`);
      }
    } else if (pair.mockAgent && mockReady) {
      strategy.steps.push({
        providerId: pair.providerId,
        primaryAgent: pair.mockAgent,
        primaryRuntime: "mock",
      });
      strategy.fallbackEvents.push({
        providerId: pair.providerId,
        reason: "Real agent unavailable; mock fallback selected.",
        from: "real",
        to: "mock",
      });
    } else {
      strategy.warnings.push(`${pair.providerId}: no available agent in current runtime mode.`);
      strategy.fallbackEvents.push({
        providerId: pair.providerId,
        reason: "No available agent; provider skipped.",
        from: "real",
        to: "none",
      });
    }
  }

  if (mode === "legacy_mock_first") {
    strategy.steps = MOCK_FULL_AUDIT_ORDER.map((agentName) => {
      const pair = CAPABILITY_PAIRS.find((p) => p.mockAgent === agentName);
      return {
        providerId: pair?.providerId ?? agentName.toLowerCase(),
        primaryAgent: agentName,
        primaryRuntime: "mock" as const,
      };
    });
    strategy.warnings.push("Legacy mock-first strategy active; real adapters are not prioritized.");
  }

  strategy.selectedOrder = strategy.steps.map((s) => s.primaryAgent);
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
