/**
 * R10.8b — DB AdminReviewDecisionRepository (deferred until migration applied).
 * Throws clearly when ORION_ADMIN_REVIEW_DECISION_STORE=db without schema.
 */

import type { AdminReviewDecisionRepository } from "./admin-review-decision-repository";
import type {
  AdminReviewDecisionRecord,
  SaveAdminReviewDecisionInput,
} from "./admin-review-decision-record";
import { ORION_ADMIN_REVIEW_DECISION_TABLE_PLAN } from "../db/orion-admin-review-decision-table-plan";

export class DbAdminReviewDecisionRepository implements AdminReviewDecisionRepository {
  readonly mode = "db" as const;

  private notReady(method: string): never {
    throw new Error(
      [
        `admin-review-decision-db-deferred:${method}`,
        `table=${ORION_ADMIN_REVIEW_DECISION_TABLE_PLAN.tableName}`,
        "Prisma model not migrated in R10.8b — use ORION_ADMIN_REVIEW_DECISION_STORE=artifact",
      ].join(" ")
    );
  }

  async listDecisions(_caseId: string): Promise<AdminReviewDecisionRecord[]> {
    return this.notReady("listDecisions");
  }

  async getDecision(
    _caseId: string,
    _evidenceId: string
  ): Promise<AdminReviewDecisionRecord | null> {
    return this.notReady("getDecision");
  }

  async getActiveDecision(
    _caseId: string,
    _evidenceId: string
  ): Promise<AdminReviewDecisionRecord | null> {
    return this.notReady("getActiveDecision");
  }

  async listDecisionHistory(
    _caseId: string,
    _evidenceId: string
  ): Promise<AdminReviewDecisionRecord[]> {
    return this.notReady("listDecisionHistory");
  }

  async saveDecision(
    _caseId: string,
    _evidenceId: string,
    _decision: SaveAdminReviewDecisionInput
  ): Promise<AdminReviewDecisionRecord> {
    return this.notReady("saveDecision");
  }

  async deactivateDecision(_decisionId: string): Promise<AdminReviewDecisionRecord | null> {
    return this.notReady("deactivateDecision");
  }
}
