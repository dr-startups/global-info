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
}

/** Results grouped per engine after loading + de-duplication. */
export interface LoadedResults {
  subjectName: string;
  yandex: LoadedResult[];
  google: LoadedResult[];
  total: number;
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
}
