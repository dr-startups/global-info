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
 *   H1) Real connector layer + live Wikipedia    <-- current
 *   H2+) Google/Yandex live search, compliance connectors (official APIs only)
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

// Stage H1 — real connector provider layer (Wikipedia live; Google/Yandex safe placeholders)
export {
  providerConfig,
  getProviderAvailability,
  listProviderAvailability,
} from "./providers/config";
export { wikipediaProvider } from "./providers/wikipedia-provider";
export { googleSearchProvider } from "./providers/google-search-provider";
export { yandexSearchProvider } from "./providers/yandex-search-provider";

export const DIGITAL_PROFILE_MODULE = {
  name: "digital-profile",
  /** Bumped as stages land. */
  stage: "H1",
} as const;
