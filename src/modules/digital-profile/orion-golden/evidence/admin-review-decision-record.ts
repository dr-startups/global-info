/**
 * R10.8b — Production-grade admin review decision persistence model.
 * Artifact-backed today; DB table planned (not migrated in this step).
 */

import type { AdminReviewStatus } from "./admin-review-decision";

export type AdminReviewDecisionSource = "admin_ui" | "imported_artifact" | "test_fixture";

export type AdminReviewDecisionStoreMode = "artifact" | "db";

export type AdminReviewDecisionRecord = {
  id: string;
  caseId: string;
  evidenceId: string;
  status: AdminReviewStatus;
  reviewerNote?: string;
  approvedClientSummary?: string;
  caveatText?: string;
  requestedSources?: string[];
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
  decisionVersion: number;
  source: AdminReviewDecisionSource;
  isActive: boolean;
  previousDecisionId?: string;
  metadata?: Record<string, unknown>;
};

export type SaveAdminReviewDecisionInput = {
  status: AdminReviewStatus;
  reviewerNote?: string;
  approvedClientSummary?: string;
  caveatText?: string;
  requestedSources?: string[];
  reviewedBy?: string;
  reviewedAt?: string;
  source?: AdminReviewDecisionSource;
  metadata?: Record<string, unknown>;
};

export function recordToLegacyDecision(record: AdminReviewDecisionRecord): {
  evidenceId: string;
  status: AdminReviewStatus;
  reviewerNote?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  approvedClientSummary?: string;
  caveatText?: string;
  requestedSources?: string[];
} {
  return {
    evidenceId: record.evidenceId,
    status: record.status,
    reviewerNote: record.reviewerNote,
    reviewedBy: record.reviewedBy,
    reviewedAt: record.reviewedAt,
    approvedClientSummary: record.approvedClientSummary,
    caveatText: record.caveatText,
    requestedSources: record.requestedSources,
  };
}

export function newDecisionId(): string {
  return `ard_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
