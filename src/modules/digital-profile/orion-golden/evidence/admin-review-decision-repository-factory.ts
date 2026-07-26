/**
 * R10.8b — Factory for AdminReviewDecisionRepository.
 * Default: artifact. DB mode requires explicit env flag and is deferred until migration.
 */

import type { AdminReviewDecisionRepository } from "./admin-review-decision-repository";
import { ArtifactAdminReviewDecisionRepository } from "./artifact-admin-review-decision-repository";
import { DbAdminReviewDecisionRepository } from "./db-admin-review-decision-repository";
import { resolveAdminReviewDecisionStoreMode } from "./admin-review-decision-store-config";
import type { AdminReviewDecisionStoreMode } from "./admin-review-decision-record";

let cached: { mode: AdminReviewDecisionStoreMode; repo: AdminReviewDecisionRepository } | null =
  null;

export function createAdminReviewDecisionRepository(
  mode: AdminReviewDecisionStoreMode = resolveAdminReviewDecisionStoreMode()
): AdminReviewDecisionRepository {
  if (mode === "db") return new DbAdminReviewDecisionRepository();
  return new ArtifactAdminReviewDecisionRepository();
}

export function getAdminReviewDecisionRepository(): AdminReviewDecisionRepository {
  const mode = resolveAdminReviewDecisionStoreMode();
  if (cached && cached.mode === mode) return cached.repo;
  const repo = createAdminReviewDecisionRepository(mode);
  cached = { mode, repo };
  return repo;
}

/** Test helper — clears cached repository instance. */
export function resetAdminReviewDecisionRepositoryCache(): void {
  cached = null;
}
