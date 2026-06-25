/**
 * Risk Classifier v1 agent (Stage I).
 *
 * A deterministic, evidence-driven classifier (kind REAL, not MOCK). It runs the
 * rule-based classifier over already-stored evidence and persists idempotent,
 * review-first risk_findings. No LLM, no scraping, no network.
 */

import { classifyCaseRisks } from "../../services/risk-finding-service";
import { loadCaseSubject } from "../mock/mock-utils";
import type {
  AgentAvailability,
  AgentContext,
  AgentRunResult,
  CaseAgent,
  SavedEvidenceSummary,
} from "../types";
import type { AgentNameValue } from "../../types";

export class RiskClassifierV1Agent implements CaseAgent {
  readonly name = "RISK_CLASSIFIER_V1";
  readonly displayName = "Risk Classifier v1";
  readonly description =
    "Deterministic, rule-based classifier. Derives evidence-linked, review-first risk findings from stored evidence. No LLM.";
  readonly kind = "REAL" as const;
  readonly agentName: AgentNameValue = "RISK_CLASSIFIER";

  availability(): AgentAvailability {
    return { status: "ENABLED" };
  }

  async validateInput(ctx: AgentContext): Promise<void> {
    await loadCaseSubject(ctx.caseId);
  }

  async normalizeOutput(raw: unknown): Promise<unknown> {
    return raw;
  }

  /** Persistence happens inside classifyCaseRisks; this is a no-op for the interface. */
  async saveEvidence(): Promise<SavedEvidenceSummary> {
    return {};
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    try {
      const summary = await classifyCaseRisks(ctx.caseId, { actorId: ctx.actorId });
      return {
        agentName: this.agentName,
        status: "SUCCEEDED",
        output: { demo: false, ...summary },
        saved: { riskFindings: summary.findingsCreated + summary.findingsUpdated },
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        agentName: this.agentName,
        status: "FAILED",
        saved: {},
        error: err instanceof Error ? err.message : "Risk classifier failed",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }
}
