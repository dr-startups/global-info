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
import { MockSearchSurfaceAgent } from "./mock/mock-search-surface-agent";
import { RealWikipediaAgent } from "./real/real-wikipedia-agent";
import { RealGoogleSearchAgent } from "./real/real-google-search-agent";
import { RealYandexSearchAgent } from "./real/real-yandex-search-agent";
import { RealSearchSurfaceAgent } from "./real/real-search-surface-agent";
import {
  RealOrionGoogleSurfacesAgent,
  RealOrionSearchProfileAgent,
  RealOrionUaeInternationalAgent,
} from "./real/real-orion-search-profile-agent";
import { RiskClassifierV1Agent } from "./real/risk-classifier-agent";
import { AuditSummaryBuilderAgent } from "./real/audit-summary-agent";

const AGENT_LIST: CaseAgent[] = [
  new MockYandexSearchAgent(),
  new MockGoogleSearchAgent(),
  new MockWikipediaAgent(),
  new MockAiProfileAgent(),
  new MockComplianceDatabaseAgent(),
  new MockRiskClassifierAgent(),
  new MockSearchSurfaceAgent(),
  new RealWikipediaAgent(),
  new RealGoogleSearchAgent(),
  new RealYandexSearchAgent(),
  new RealSearchSurfaceAgent(),
  new RealOrionSearchProfileAgent(),
  new RealOrionGoogleSurfacesAgent(),
  new RealOrionUaeInternationalAgent(),
  new RiskClassifierV1Agent(),
  new AuditSummaryBuilderAgent(),
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

/** Real connectors that are safe to run as an opt-in real audit (official APIs). */
export const REAL_SAFE_AUDIT_ORDER: string[] = [
  "REAL_WIKIPEDIA",
  "REAL_ORION_SEARCH_PROFILE",
  "REAL_GOOGLE_SEARCH",
  "REAL_YANDEX_SEARCH",
  "REAL_SEARCH_SURFACES",
  "RISK_CLASSIFIER_V1",
  "AUDIT_SUMMARY_BUILDER",
];

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
