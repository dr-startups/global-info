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
  loadAdminReviewDecisions,
  saveAdminReviewDecisions,
  ensureAdminReviewDecisions,
  applyAdminReviewDecision,
  saveAdminReviewSampleFixture,
} from "./evidence/admin-review-decision-store";
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
export * from "./identity/subject-identity-profile";
export * from "./identity/subject-identity-profile-builder";
export * from "./identity/subject-binding-scorer";
export * from "./identity/homonym-disambiguation-policy";
export * from "./run-r10-orion-golden-e2e";
export * from "./types";
