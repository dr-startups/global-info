/**
 * Types for the ORION-style synthetic SERP snapshot generator (Stage S1).
 *
 * IMPORTANT: this module produces a SYNTHETIC, self-attributed image built only
 * from already-stored `search_results`. It is NOT a live browser screenshot of
 * Google/Yandex — no Playwright, no scraping, no real SERP calls. Live capture
 * is deferred to Stage S2.
 */

export type SerpEngine = "YANDEX" | "GOOGLE";

export type SerpLanguage = "ru" | "en";

export type SerpSnapshotMode = "SYNTHETIC";

/**
 * Stage N1 — provenance of the underlying search_results that fed the snapshot.
 * The image is always SYNTHETIC; this only records whether the data behind it
 * came from mock agents, the real Yandex Cloud Search API, or a mix.
 * Stage N1.2 adds EMPTY for the no-data state.
 */
export type SerpSourceMode = "MOCK_ONLY" | "REAL_ONLY" | "MIXED" | "EMPTY";

/** Per-engine provenance after applying the source preference (Stage N1.2). */
export type EngineSourceMode = "REAL" | "MOCK" | "EMPTY";

/**
 * Stage N1.2 — how the snapshot picks between real and mock rows per engine.
 *  - prefer_real (default): use real:* rows when present, else fall back to mock.
 *  - real_only:  use only real:* rows (engine is EMPTY when none exist).
 *  - mock_only:  use only mock/demo rows.
 *  - mixed:      use every stored row (legacy behaviour).
 */
export type SourcePreference = "prefer_real" | "real_only" | "mock_only" | "mixed";

export const DEFAULT_SOURCE_PREFERENCE: SourcePreference = "prefer_real";

/** Per-engine source breakdown surfaced in metadata / the API response. */
export interface EnginePerSource {
  sourceMode: EngineSourceMode;
  resultCount: number;
  highlightedCount: number;
}

/** Both engines' source breakdown. */
export interface PerEngineSource {
  yandex: EnginePerSource;
  google: EnginePerSource;
}

/** Request accepted by the generator (route layer validates + narrows this). */
export interface SerpSnapshotRequest {
  caseId: string;
  /** Search query shown in the SERP bars. Defaults to the subject full name. */
  query?: string;
  /** Subject name (used as the default query and in the header). */
  subjectName?: string;
  engines?: SerpEngine[];
  language?: SerpLanguage;
  maxResultsPerEngine?: number;
  /** Stage N1.2 — real-vs-mock selection strategy. Defaults to prefer_real. */
  sourcePreference?: SourcePreference;
}

/** A single stored search result loaded for snapshot rendering. */
export interface LoadedResult {
  id: string;
  engine: SerpEngine;
  rank: number | null;
  title: string | null;
  url: string;
  domain: string | null;
  snippet: string | null;
  classification: string;
  /** Free-form risk theme harvested from rawMetadata, when present. */
  riskTheme: string | null;
  region: string | null;
  language: string | null;
  source: string | null;
  createdAt: Date;
  /**
   * Stage N1.3 — resolved highlight decision (manual > findings > auto > enum).
   * When true the result gets a red frame; `riskTheme`/`themeTitle` carry the
   * effective theme used for grouping. `false` for neutral/unknown/dismissed.
   */
  isHighlighted: boolean;
  /** Human-readable theme title hint for the left-column grouping, if any. */
  themeTitle: string | null;
}

/** Results grouped per engine after loading + applying the source preference. */
export interface LoadedResults {
  subjectName: string;
  yandex: LoadedResult[];
  google: LoadedResult[];
  total: number;
  /** Stage N1 — provenance derived from the selected rows' `source` field. */
  sourceMode: SerpSourceMode;
  /** True when at least one selected row came from a real provider. */
  hasRealResults: boolean;
  /** Stage N1.2 — preference that was applied to produce this selection. */
  sourcePreference: SourcePreference;
  /** Stage N1.2 — per-engine source mode (highlightedCount filled later). */
  perEngine: { yandex: EngineSourceMode; google: EngineSourceMode };
}

/** A deterministic risk theme grouping (left-column table row). */
export interface SnapshotTheme {
  themeNumber: number;
  /** Display label such as "Тема 1" / "Theme 1". */
  themeLabel: string;
  title: string;
  count: number;
  resultIds: string[];
  color: string;
}

/** Output of the theme grouper. */
export interface ThemeGrouping {
  themes: SnapshotTheme[];
  /** resultId -> { themeNumber, themeLabel } for highlighted results only. */
  highlights: Map<string, { themeNumber: number; themeLabel: string }>;
  highlightedCount: number;
}

/** A rendered result card in the view model. */
export interface ResultView {
  rank: number | null;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  classification: string;
  isHighlighted: boolean;
  themeNumber?: number;
  themeLabel?: string;
}

export interface SerpEngineView {
  engine: SerpEngine;
  query: string;
  results: ResultView[];
  /** True when no stored results exist for this engine. */
  empty: boolean;
}

/** The complete, self-contained model consumed by the SVG renderer. */
export interface SerpSnapshotViewModel {
  title: string;
  dateLabel: string;
  subjectName: string;
  query: string;
  language: SerpLanguage;
  themes: SnapshotTheme[];
  noNegatives: boolean;
  engines: {
    yandex: SerpEngineView;
    google: SerpEngineView;
  };
  width: number;
  height: number;
  footerNote: string;
  /**
   * Stage N1.2 — small, secrets-free source attribution drawn in the footer
   * (e.g. "Источник: реальные данные Yandex Search API / demo Google").
   */
  sourceLabel: string;
}

/** Persisted metadata sidecar (metadata.json). */
export interface SerpSnapshotMetadata {
  caseId: string;
  query: string;
  mode: SerpSnapshotMode;
  engines: SerpEngine[];
  language: SerpLanguage;
  themeCount: number;
  highlightedCount: number;
  resultCount: number;
  width: number;
  height: number;
  generatedAt: string;
  /** Always synthetic — never a live capture. */
  synthetic: true;
  /** Stage N1 — provenance of the underlying search_results. */
  sourceMode: SerpSourceMode;
  /** Stage N1.2 — selection strategy that produced this snapshot. */
  sourcePreference: SourcePreference;
  /** Stage N1.2 — per-engine source breakdown. */
  perEngine: PerEngineSource;
}

/** Result returned by the service / API layer. */
export interface SerpSnapshotResult {
  id: string;
  storageKey: string;
  signedUrl: string;
  query: string;
  mode: SerpSnapshotMode;
  engines: SerpEngine[];
  language: SerpLanguage;
  themeCount: number;
  highlightedCount: number;
  resultCount: number;
  width: number;
  height: number;
  generatedAt: string;
  sha256: string;
  sizeBytes: number;
  /** Stage N1 — provenance of the underlying search_results. */
  sourceMode: SerpSourceMode;
  /** Stage N1.2 — selection strategy that produced this snapshot. */
  sourcePreference: SourcePreference;
  /** Stage N1.2 — per-engine source breakdown. */
  perEngine: PerEngineSource;
}
