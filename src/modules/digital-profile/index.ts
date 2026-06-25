/**
 * Digital Profile Audit module — public entry point (barrel).
 *
 * Isolated, feature-flagged module. Import from "@/modules/digital-profile"
 * rather than reaching into internal files.
 *
 * Implementation stages:
 *   A) DB schema + core types + empty module
 *   B) Case CRUD
 *   C) Manual evidence input                    <-- current
 *   D) report_json builder
 *   E) Report renderer (PPTX template -> PDF)
 *   F) Admin UI
 *   G) Mock agents
 *   H) Real collectors (official APIs / manual import only)
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

export const DIGITAL_PROFILE_MODULE = {
  name: "digital-profile",
  /** Bumped as stages land. */
  stage: "C",
} as const;
