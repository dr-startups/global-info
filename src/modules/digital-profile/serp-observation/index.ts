/**
 * Provider-first run-scoped SERP observations.
 *
 * Vertical slice (this package):
 *   Serper Google + Yandex Search API organic → SerpObservation drafts
 *   → dual-engine synthetic PNG (themes + red frames) → ReportAsset
 *
 * No residential proxy, no CAPTCHA solving, no browser scraping of Google/Yandex.
 */

export {
  SYNTHETIC_API_SERP_CAPTION,
  type SerpProviderStatus,
  type SerpObservationDraft,
  type PersistedSerpObservation,
  type SerperOrganicIngestResult,
} from "./types";
export { classifyProviderFetchOutcome, isCaptchaBlocked, isEmptyResultsStatus } from "./provider-status";
export { buildSerpQueryId } from "./query-id";
export {
  mapSerperOrganicToObservationDrafts,
  mergeObservationDraftsWithoutUrlDedupe,
} from "./map-serper-organic";
export { mapYandexOrganicToObservationDrafts } from "./map-yandex-organic";
export { persistSerpObservations, listSerpObservationsForAuditRun } from "./persist";
export {
  buildSyntheticSerpViewModelFromObservations,
  createSyntheticSerpAssetFromObservations,
} from "./synthetic-asset";
export {
  classifyObservationHighlight,
  buildObservationThemeGrouping,
} from "./resolve-observation-highlights";
export {
  isSyntheticSerpNoiseHit,
  filterObservationsForSyntheticSerp,
} from "./filter-synthetic-serp-noise";
export { serpSyntheticAssetToReportAsset } from "./to-report-asset";
export { evaluateClientVisualAssetGate } from "./client-report-gate";
export { ingestSerperOrganicObservations } from "./ingest-serper-organic";
export { ingestYandexOrganicObservations } from "./ingest-yandex-organic";
export { buildSerperOrganicReportAssetsFromDrafts } from "./build-report-assets";
export {
  fetchDataForSeoOrganic,
  isDataForSeoConfigured,
} from "./adapters/dataforseo-adapter";
