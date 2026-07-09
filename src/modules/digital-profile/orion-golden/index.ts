/** R10 — ORION Golden 3-layer agent architecture module exports. */

export * from "./architecture/orion-agent-architecture";
export * from "./blueprint/orion-golden-blueprint";
export * from "./db/orion-supabase-schema-plan";
export * from "./evidence/full-evidence-inventory";
export * from "./evidence/orion-section-router";
export * from "./evidence/relevance-classifier";
export * from "./gpt/orion-section-analyzer";
export * from "./gpt/orion-executive-synthesizer";
export * from "./report-spec/orion-report-spec";
export * from "./assets/orion-asset-builder";
export * from "./composer/orion-deck-composer";
export * from "./renderer/orion-golden-render-client";
export * from "./qa/client-policy-inspection";
export * from "./qa/visual-qa-inspection";
export * from "./evidence/evidence-judgment";
export * from "./evidence/evidence-judgment-builder";
export * from "./evidence/evidence-client-gate";
export * from "./evidence/manual-review-queue";
export * from "./content/orion-client-content-builder";
export * from "./qa/r10-4-evidence-judgment-qa";
export * from "./qa/r10-4-content-quality-review";
export * from "./evidence/admin-review-decision";
export {
  ORION_GOLDEN_QA_STORAGE_ROOT,
  adminReviewDecisionsPath,
  caseScopedArtifactRoot,
  sanitizeCaseIdForPath,
  loadAdminReviewDecisions,
  saveAdminReviewDecisions,
  ensureAdminReviewDecisions,
  applyAdminReviewDecision,
  saveAdminReviewSampleFixture,
} from "./evidence/admin-review-decision-store";
export * from "./auth/orion-admin-auth";
export * from "./qa/r10-10a-admin-auth-qa";
export * from "./evidence/apply-admin-decisions-to-judgments";
export * from "./evidence/admin-review-sample-fixture";
export * from "./services/admin-review-workflow-service";
export * from "./qa/r10-5-admin-review-workflow-qa";
export * from "./sections/orion-section-registry";
export * from "./sections/orion-section-bundle";
export * from "./sections/orion-section-bundle-builder";
export * from "./sections/orion-section-analysis";
export * from "./sections/orion-risk-matrix-from-sections";
export * from "./gpt/orion-section-analysis-orchestrator";
export * from "./gpt/orion-executive-synthesis-from-sections";
export * from "./qa/r10-6-section-gpt-orchestration-qa";
export * from "./qa/r10-7a-threshold-tuning-qa";
export * from "./qa/r10-7b-subject-binding-qa";
export * from "./qa/r10-7c-section-content-polish-qa";
export * from "./qa/r10-8-admin-ui-qa";
export * from "./qa/r10-8a-admin-ui-polish-qa";
export * from "./qa/r10-8b-admin-decision-persistence-qa";
export * from "./qa/r10-9-client-render-content-inspection";
export * from "./qa/r10-9-renderer-integration-qa";
export * from "./qa/r10-9a-visual-polish-qa";
export * from "./report-spec/orion-client-content-to-report-spec";
export * from "./composer/orion-client-audit-deck-composer";
export * from "./evidence/admin-review-decision-validation";
export * from "./evidence/admin-review-decision-record";
export * from "./evidence/admin-review-decision-repository";
export * from "./evidence/admin-review-decision-store-config";
export * from "./evidence/admin-review-decision-repository-factory";
export * from "./evidence/artifact-admin-review-decision-repository";
export * from "./evidence/db-admin-review-decision-repository";
export * from "./db/orion-admin-review-decision-table-plan";
export * from "./content/evidence-cluster";
export * from "./content/manual-review-groups";
export * from "./content/risk-matrix-compaction";
export * from "./content/ru-section-content-polish";
export * from "./content/section-content-recommendations";
export * from "./identity/subject-identity-profile";
export * from "./identity/subject-identity-profile-builder";
export * from "./identity/subject-binding-scorer";
export * from "./identity/homonym-disambiguation-policy";
export * from "./run-r10-orion-golden-e2e";
export * from "./types";
