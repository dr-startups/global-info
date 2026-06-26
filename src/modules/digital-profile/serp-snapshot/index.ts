/**
 * ORION-style synthetic SERP snapshot generator (Stage S1) — public surface.
 *
 * Synthetic only: builds an annotated image from already-stored search_results.
 * No live browser capture, no Playwright, no scraping, no real SERP calls and no
 * API keys. Live capture is deferred to Stage S2.
 */

export { serpSnapshotConfig, DEFAULT_ENGINES, snapshotMimeType, snapshotExtension } from "./config";
export { buildSerpSnapshotSvg, renderSerpSnapshotPng } from "./renderer";
export { groupThemes, NO_NEGATIVES_MESSAGE, isNegative } from "./theme-grouper";
export { resolveQuery, sanitizeQueryText } from "./query";
export {
  loadCaseResults,
  selectByPreference,
  deriveSourceMode,
  engineSourceModeOf,
  isRealSource,
} from "./data-loader";
export { DEFAULT_SOURCE_PREFERENCE } from "./types";
export {
  buildSnapshot,
  generateSerpSnapshot,
  getLatestSerpSnapshot,
} from "./service";
export { getLatestSnapshot, persistSnapshot } from "./storage";
export type {
  SerpEngine,
  SerpLanguage,
  SerpSnapshotMode,
  SerpSnapshotRequest,
  SerpSnapshotResult,
  SerpSnapshotViewModel,
  SerpSnapshotMetadata,
  SerpEngineView,
  ResultView,
  SnapshotTheme,
  ThemeGrouping,
  LoadedResult,
  LoadedResults,
  SerpSourceMode,
  SourcePreference,
  EngineSourceMode,
  EnginePerSource,
  PerEngineSource,
} from "./types";
