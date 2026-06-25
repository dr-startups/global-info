/**
 * Digital Profile Audit module — public entry point (barrel).
 *
 * Isolated, feature-flagged module. Import from "@/modules/digital-profile"
 * rather than reaching into internal files.
 *
 * Implementation stages:
 *   A) DB schema + core types + empty module   <-- current
 *   B) Case CRUD
 *   C) Manual evidence input
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

export const DIGITAL_PROFILE_MODULE = {
  name: "digital-profile",
  /** Bumped as stages land. */
  stage: "A",
} as const;
