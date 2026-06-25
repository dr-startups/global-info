/**
 * Digital Profile Audit module — public entry point (barrel).
 *
 * Isolated, feature-flagged module. Import from "@/modules/digital-profile"
 * rather than reaching into internal files.
 *
 * Implementation stages:
 *   A) DB schema + core types + empty module
 *   B) Case CRUD
 *   C) Manual evidence input
 *   D) report_json builder
 *   E) Report renderer (PPTX template -> PDF)
 *   F) Admin UI
 *   G) Mock agents + orchestration
 *   H1) Real connector layer + live Wikipedia
 *   H2) Real Google/Yandex search connectors (official APIs)
 *   H3) Search surface expansion (suggestions/related/images/videos/knowledge)
 *   I)  Risk Classifier v1 (deterministic, evidence-first findings)
 *   J)  Audit Summary builder (deterministic, evidence-derived)
 *   K1) ORION-like report template v1 (dynamic analytics + offer pages)  <-- current
 *   K2) Full 36-page template + final commercial block
 */

export * from "./types";
export {
  digitalProfileConfig,
  isDigitalProfileEnabled,
  reportPricing,
} from "./config";

// Stage B — case services & validation
export * as caseService from "./services/case-service";
export { recordAudit } from "./services/audit-log-service";
export type { AuditAction } from "./services/audit-log-service";
export {
  CreateDigitalProfileCaseSchema,
  UpdateDigitalProfileCaseSchema,
  ListDigitalProfileCasesQuerySchema,
} from "./validation/case-schemas";

// Stage C — manual evidence input
export * as evidenceService from "./services/evidence-service";
export * as screenshotService from "./services/screenshot-service";
export {
  AddSearchQuerySchema,
  AddSearchResultSchema,
  ClassifySearchResultSchema,
  AddDatabaseProfileSchema,
  AddWikipediaCheckSchema,
  AddRiskFindingSchema,
  ReviewRiskFindingSchema,
} from "./validation/evidence-schemas";

// Stage D — report_json builder
export * as reportBuilderService from "./services/report-builder-service";
export { buildStaticPages } from "./report/static-pages";

// Stage E — report renderer (PPTX/PDF via renderer microservice)
export * as reportRendererService from "./services/report-renderer-service";

// Stage G — mock agents + orchestration
export * as agentRunService from "./services/agent-run-service";
export {
  FULL_AUDIT_ORDER,
  MOCK_FULL_AUDIT_ORDER,
  REAL_SAFE_AUDIT_ORDER,
  getAgent,
  listAgentDefinitions,
} from "./agents/registry";

// Stage H1/H2 — real connector provider layer (Wikipedia + Google/Yandex official APIs)
export {
  providerConfig,
  getProviderAvailability,
  computeAvailability,
  missingConfigKeys,
  getProviderStatus,
  listProviderStatus,
  listProviderAvailability,
} from "./providers/config";
export { wikipediaProvider } from "./providers/wikipedia-provider";
export { googleSearchProvider } from "./providers/google-search-provider";
export { yandexSearchProvider } from "./providers/yandex-search-provider";
export { buildPersonSearchQueries } from "./providers/query-builder";
export { getProviderCapabilities } from "./providers/capabilities";

// Stage H3 — search surface expansion (suggestions/related/images/videos/knowledge)
export * from "./search-surfaces/types";
export {
  listSearchSurfaceItems,
  createSearchSurfaceItem,
  createManySearchSurfaceItems,
  markSearchSurfaceItemReviewed,
  deleteSearchSurfaceItemSoft,
  surfaceDedupHash,
} from "./services/search-surface-service";
export { buildSurfacesReportSection } from "./report/surfaces-summary";
export {
  buildSyntheticSnapshotModel,
  createSyntheticSnapshot,
} from "./services/synthetic-snapshot-service";

// Stage I — deterministic Risk Classifier v1
export * from "./risk-classifier/types";
export { classifyEvidence } from "./risk-classifier/classifier";
export { loadCaseEvidence } from "./risk-classifier/evidence-loader";
export {
  classifyCaseRisks,
  listRiskFindings,
  RISK_CLASSIFIER_OWNER,
} from "./services/risk-finding-service";

// Stage J — deterministic Audit Summary builder
export * from "./audit-summary/types";
export { buildAuditSummary } from "./audit-summary/builder";

// Stage K1 — ORION-like report template v1 (offer config)
export { buildOfferConfig } from "./report/offer-config";

export const DIGITAL_PROFILE_MODULE = {
  name: "digital-profile",
  /** Bumped as stages land. */
  stage: "K1",
} as const;
