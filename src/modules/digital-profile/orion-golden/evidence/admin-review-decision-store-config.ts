/**
 * R10.8b — Store mode config (artifact default). Does not print secrets.
 */

import type { AdminReviewDecisionStoreMode } from "./admin-review-decision-record";

export const ORION_ADMIN_REVIEW_DECISION_STORE_ENV = "ORION_ADMIN_REVIEW_DECISION_STORE";

export function resolveAdminReviewDecisionStoreMode(
  env: NodeJS.ProcessEnv = process.env
): AdminReviewDecisionStoreMode {
  const raw = (env[ORION_ADMIN_REVIEW_DECISION_STORE_ENV] ?? "artifact").trim().toLowerCase();
  if (raw === "db") return "db";
  return "artifact";
}
