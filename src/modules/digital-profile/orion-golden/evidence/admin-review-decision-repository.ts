/**
 * R10.8b — AdminReviewDecisionRepository abstraction.
 */

import type {
  AdminReviewDecisionRecord,
  AdminReviewDecisionStoreMode,
  SaveAdminReviewDecisionInput,
} from "./admin-review-decision-record";

export interface AdminReviewDecisionRepository {
  readonly mode: AdminReviewDecisionStoreMode;
  listDecisions(caseId: string): Promise<AdminReviewDecisionRecord[]>;
  getDecision(caseId: string, evidenceId: string): Promise<AdminReviewDecisionRecord | null>;
  getActiveDecision(caseId: string, evidenceId: string): Promise<AdminReviewDecisionRecord | null>;
  listDecisionHistory(caseId: string, evidenceId: string): Promise<AdminReviewDecisionRecord[]>;
  saveDecision(
    caseId: string,
    evidenceId: string,
    decision: SaveAdminReviewDecisionInput
  ): Promise<AdminReviewDecisionRecord>;
  deactivateDecision(decisionId: string): Promise<AdminReviewDecisionRecord | null>;
}
