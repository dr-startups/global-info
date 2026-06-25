/**
 * Audit Summary Builder agent (Stage J).
 *
 * A deterministic system agent (kind REAL, not MOCK). It assembles the audit
 * summary from stored evidence + risk findings and records it into the
 * agent_runs output/metadata. It never mutates evidence or risk findings, so
 * reviewed/dismissed decisions are preserved. No LLM, no network.
 */

import { buildAuditSummary } from "../../audit-summary/builder";
import { loadCaseSubject } from "../mock/mock-utils";
import type {
  AgentAvailability,
  AgentContext,
  AgentRunResult,
  CaseAgent,
  SavedEvidenceSummary,
} from "../types";
import type { AgentNameValue } from "../../types";

export class AuditSummaryBuilderAgent implements CaseAgent {
  readonly name = "AUDIT_SUMMARY_BUILDER";
  readonly displayName = "Audit Summary Builder";
  readonly description =
    "Deterministically aggregates evidence + risk findings into a cautious audit summary. No LLM. Read-only over evidence.";
  readonly kind = "REAL" as const;
  readonly agentName: AgentNameValue = "REPORT_SYNTHESIS";

  availability(): AgentAvailability {
    return { status: "ENABLED" };
  }

  async validateInput(ctx: AgentContext): Promise<void> {
    await loadCaseSubject(ctx.caseId);
  }

  async normalizeOutput(raw: unknown): Promise<unknown> {
    return raw;
  }

  /** Read-only: nothing is persisted to evidence tables. */
  async saveEvidence(): Promise<SavedEvidenceSummary> {
    return {};
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    try {
      const summary = await buildAuditSummary(ctx.caseId);
      return {
        agentName: this.agentName,
        status: "SUCCEEDED",
        output: {
          demo: false,
          overallRiskLevel: summary.overallRiskLevel,
          overallTone: summary.overallTone,
          totalFindings: summary.riskSummary.totalFindings,
          searchNegativeShare: summary.searchSummary.negativeShare,
          evidenceCount: summary.dataQualitySummary.evidenceCount,
          auditSummary: summary,
        },
        saved: {},
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        agentName: this.agentName,
        status: "FAILED",
        saved: {},
        error: err instanceof Error ? err.message : "Audit summary builder failed",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }
}
