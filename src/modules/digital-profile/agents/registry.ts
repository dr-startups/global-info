/**
 * Agent registry. Maps agent names to their (currently mock) implementations and
 * defines the full-audit execution order. Swapping a mock for a real agent later
 * is a one-line change here — the rest of the system is unaffected.
 */

import type { AgentNameValue } from "../types";
import type { AgentDefinition, CaseAgent } from "./types";
import { MockYandexSearchAgent } from "./mock/mock-yandex-search-agent";
import { MockGoogleSearchAgent } from "./mock/mock-google-search-agent";
import { MockWikipediaAgent } from "./mock/mock-wikipedia-agent";
import { MockAiProfileAgent } from "./mock/mock-ai-profile-agent";
import { MockComplianceDatabaseAgent } from "./mock/mock-compliance-database-agent";
import { MockRiskClassifierAgent } from "./mock/mock-risk-classifier-agent";

const AGENT_LIST: CaseAgent[] = [
  new MockYandexSearchAgent(),
  new MockGoogleSearchAgent(),
  new MockWikipediaAgent(),
  new MockAiProfileAgent(),
  new MockComplianceDatabaseAgent(),
  new MockRiskClassifierAgent(),
];

const AGENTS: Map<AgentNameValue, CaseAgent> = new Map(
  AGENT_LIST.map((a) => [a.name, a])
);

/**
 * Full-audit order: collectors first (search, wikipedia, ai, compliance), then
 * the risk classifier last so it can reason over everything collected.
 */
export const FULL_AUDIT_ORDER: AgentNameValue[] = [
  "YANDEX_SEARCH",
  "GOOGLE_SEARCH",
  "WIKIPEDIA",
  "AI_PROFILE",
  "COMPLIANCE_DATABASE",
  "RISK_CLASSIFIER",
];

export function getAgent(name: string): CaseAgent | undefined {
  return AGENTS.get(name as AgentNameValue);
}

export function listAgentDefinitions(): AgentDefinition[] {
  return AGENT_LIST.map((a) => ({
    name: a.name,
    displayName: a.displayName,
    description: a.description,
    enabled: a.enabled,
  }));
}
