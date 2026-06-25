/**
 * Agent registry. Maps agent slugs to implementations (mock + real) and defines
 * the audit execution orders. Swapping a mock for a real agent later is a small
 * change here — the rest of the system is unaffected.
 */

import type { AgentDefinition, CaseAgent } from "./types";
import { MockYandexSearchAgent } from "./mock/mock-yandex-search-agent";
import { MockGoogleSearchAgent } from "./mock/mock-google-search-agent";
import { MockWikipediaAgent } from "./mock/mock-wikipedia-agent";
import { MockAiProfileAgent } from "./mock/mock-ai-profile-agent";
import { MockComplianceDatabaseAgent } from "./mock/mock-compliance-database-agent";
import { MockRiskClassifierAgent } from "./mock/mock-risk-classifier-agent";
import { RealWikipediaAgent } from "./real/real-wikipedia-agent";

const AGENT_LIST: CaseAgent[] = [
  new MockYandexSearchAgent(),
  new MockGoogleSearchAgent(),
  new MockWikipediaAgent(),
  new MockAiProfileAgent(),
  new MockComplianceDatabaseAgent(),
  new MockRiskClassifierAgent(),
  new RealWikipediaAgent(),
];

const AGENTS: Map<string, CaseAgent> = new Map(AGENT_LIST.map((a) => [a.name, a]));

/**
 * Mock full-audit order: collectors first, risk classifier last. Real connectors
 * are intentionally excluded so the demo audit stays deterministic and offline.
 */
export const MOCK_FULL_AUDIT_ORDER: string[] = [
  "YANDEX_SEARCH",
  "GOOGLE_SEARCH",
  "WIKIPEDIA",
  "AI_PROFILE",
  "COMPLIANCE_DATABASE",
  "RISK_CLASSIFIER",
];

/** Real connectors that are safe to run automatically (public APIs only). */
export const REAL_SAFE_AUDIT_ORDER: string[] = ["REAL_WIKIPEDIA"];

/** Back-compat alias used by the orchestrator/full-audit service. */
export const FULL_AUDIT_ORDER = MOCK_FULL_AUDIT_ORDER;

export function getAgent(name: string): CaseAgent | undefined {
  return AGENTS.get(name);
}

export function listAgentDefinitions(): AgentDefinition[] {
  return AGENT_LIST.map((a) => {
    const availability = a.availability();
    return {
      name: a.name,
      displayName: a.displayName,
      description: a.description,
      kind: a.kind,
      enabled: availability.status === "ENABLED",
      availability,
    };
  });
}
