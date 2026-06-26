/**
 * Service layer for ORION-style synthetic SERP snapshots (Stage S1).
 *
 * Orchestrates: load stored results -> group themes deterministically -> build a
 * view model -> render SVG -> rasterize to PNG (sharp) -> persist to private
 * storage -> audit. NO live capture, NO scraping, NO external/provider calls and
 * NO API keys are ever required (key-free, enforced by the smoke test).
 */

import { ForbiddenError } from "../http/errors";
import { recordAudit } from "../services/audit-log-service";
import type { ActorContext } from "../services/case-service";
import { DEFAULT_ENGINES, serpSnapshotConfig } from "./config";
import { loadCaseResults } from "./data-loader";
import { groupThemes } from "./theme-grouper";
import { resolveQuery } from "./query";
import { renderSerpSnapshotPng } from "./renderer";
import { persistSnapshot, getLatestSnapshot } from "./storage";
import type {
  LoadedResult,
  ResultView,
  SerpEngine,
  SerpEngineView,
  SerpLanguage,
  SerpSnapshotMetadata,
  SerpSnapshotRequest,
  SerpSnapshotResult,
  SerpSnapshotViewModel,
  ThemeGrouping,
} from "./types";

function ensureEnabled(): void {
  if (!serpSnapshotConfig.enabled) {
    throw new ForbiddenError("SERP snapshot generation is disabled");
  }
}

function formatDateLabel(date: Date, language: SerpLanguage): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  const stamp = `${dd}.${mm}.${yyyy}`;
  return language === "ru" ? `по состоянию на ${stamp}` : `as of ${stamp}`;
}

function buildTitle(themeCount: number, language: SerpLanguage): string {
  if (themeCount === 0) {
    return language === "ru"
      ? "Нежелательных публикаций в результатах поиска не обнаружено"
      : "No adverse publications were found in the search results";
  }
  if (language === "ru") {
    const word = themeCount === 1 ? "теме" : "темам";
    return `Ссылки в результатах поиска ведут на нежелательные публикации, посвящённые ${themeCount} ${word}`;
  }
  const word = themeCount === 1 ? "theme" : "themes";
  return `Search result links lead to adverse publications covering ${themeCount} ${word}`;
}

function footerNote(language: SerpLanguage): string {
  return language === "ru"
    ? "Синтетический снимок, сформированный из сохранённых результатов поиска. Не является реальным скриншотом выдачи."
    : "Synthetic snapshot generated from stored search evidence. Not a live SERP screenshot.";
}

function toResultView(r: LoadedResult, grouping: ThemeGrouping): ResultView {
  const highlight = grouping.highlights.get(r.id);
  return {
    rank: r.rank,
    title: r.title?.trim() || r.domain || r.url,
    url: r.url,
    domain: r.domain ?? "",
    snippet: r.snippet?.trim() || "",
    classification: r.classification,
    isHighlighted: Boolean(highlight),
    themeNumber: highlight?.themeNumber,
    themeLabel: highlight?.themeLabel,
  };
}

function engineView(
  engine: SerpEngine,
  rows: LoadedResult[],
  requested: SerpEngine[],
  query: string,
  grouping: ThemeGrouping
): SerpEngineView {
  const included = requested.includes(engine);
  const results = included ? rows.map((r) => toResultView(r, grouping)) : [];
  return { engine, query, results, empty: results.length === 0 };
}

export interface BuiltSnapshot {
  viewModel: SerpSnapshotViewModel;
  metadata: SerpSnapshotMetadata;
  grouping: ThemeGrouping;
}

/**
 * Builds the view model + metadata for a case WITHOUT persisting (pure-ish:
 * reads DB, no writes). Exposed for the smoke test and report integration.
 */
export async function buildSnapshot(
  request: SerpSnapshotRequest
): Promise<BuiltSnapshot> {
  ensureEnabled();
  const language: SerpLanguage = request.language === "en" ? "en" : "ru";
  const engines = request.engines?.length ? request.engines : DEFAULT_ENGINES;
  const maxPerEngine = Math.min(
    request.maxResultsPerEngine ?? serpSnapshotConfig.maxResultsPerEngine,
    serpSnapshotConfig.maxResultsPerEngine
  );

  const loaded = await loadCaseResults(request.caseId, maxPerEngine);
  const query = resolveQuery(request.query, request.subjectName || loaded.subjectName);

  const combined = [...loaded.yandex, ...loaded.google];
  const grouping = groupThemes(combined, language);

  const generatedAt = new Date();
  const viewModel: SerpSnapshotViewModel = {
    title: buildTitle(grouping.themes.length, language),
    dateLabel: formatDateLabel(generatedAt, language),
    subjectName: request.subjectName || loaded.subjectName || query,
    query,
    language,
    themes: grouping.themes,
    noNegatives: grouping.themes.length === 0,
    engines: {
      yandex: engineView("YANDEX", loaded.yandex, engines, query, grouping),
      google: engineView("GOOGLE", loaded.google, engines, query, grouping),
    },
    width: serpSnapshotConfig.width,
    height: serpSnapshotConfig.height,
    footerNote: footerNote(language),
  };

  const metadata: SerpSnapshotMetadata = {
    caseId: request.caseId,
    query,
    mode: "SYNTHETIC",
    engines,
    language,
    themeCount: grouping.themes.length,
    highlightedCount: grouping.highlightedCount,
    resultCount: loaded.total,
    width: viewModel.width,
    height: viewModel.height,
    generatedAt: generatedAt.toISOString(),
    synthetic: true,
  };

  return { viewModel, metadata, grouping };
}

/**
 * Generates, renders and persists a synthetic SERP snapshot for a case.
 * Returns the stored snapshot with a fresh signed download URL.
 */
export async function generateSerpSnapshot(
  request: SerpSnapshotRequest,
  ctx: ActorContext = {}
): Promise<SerpSnapshotResult> {
  const { viewModel, metadata } = await buildSnapshot(request);
  const image = await renderSerpSnapshotPng(viewModel);
  const persisted = await persistSnapshot(request.caseId, image, metadata, ctx.actorId);

  await recordAudit({
    caseId: request.caseId,
    action: "SERP_SNAPSHOT_GENERATED",
    actorId: ctx.actorId,
    metadata: {
      snapshotId: persisted.id,
      query: metadata.query,
      mode: metadata.mode,
      themeCount: metadata.themeCount,
      highlightedCount: metadata.highlightedCount,
      resultCount: metadata.resultCount,
    },
  });

  return {
    id: persisted.id,
    storageKey: persisted.storageKey,
    signedUrl: persisted.signedUrl,
    query: metadata.query,
    mode: metadata.mode,
    engines: metadata.engines,
    language: metadata.language,
    themeCount: metadata.themeCount,
    highlightedCount: metadata.highlightedCount,
    resultCount: metadata.resultCount,
    width: metadata.width,
    height: metadata.height,
    generatedAt: metadata.generatedAt,
    sha256: persisted.sha256,
    sizeBytes: persisted.sizeBytes,
  };
}

/** Returns the latest stored snapshot for a case (metadata + signed URL) or null. */
export async function getLatestSerpSnapshot(
  caseId: string
): Promise<SerpSnapshotResult | null> {
  const latest = await getLatestSnapshot(caseId);
  if (!latest) return null;
  const md = latest.metadata;
  return {
    id: latest.id,
    storageKey: latest.storageKey,
    signedUrl: latest.signedUrl,
    query: md?.query ?? "",
    mode: "SYNTHETIC",
    engines: md?.engines ?? DEFAULT_ENGINES,
    language: md?.language ?? "ru",
    themeCount: md?.themeCount ?? 0,
    highlightedCount: md?.highlightedCount ?? 0,
    resultCount: md?.resultCount ?? 0,
    width: md?.width ?? serpSnapshotConfig.width,
    height: md?.height ?? serpSnapshotConfig.height,
    generatedAt: md?.generatedAt ?? latest.capturedAt.toISOString(),
    sha256: latest.sha256,
    sizeBytes: latest.sizeBytes ?? 0,
  };
}
