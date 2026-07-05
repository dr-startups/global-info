/**
 * ORION-quality single-engine synthetic SERP PNG builder for ReportSpec assets.
 * Reuses serp-snapshot layout tokens for visual consistency with production SERP snapshots.
 */

import { renderSerpSnapshotPng } from "../serp-snapshot/renderer";
import type { ResultView, SerpEngine, SerpSnapshotViewModel } from "../serp-snapshot/types";
import { riskThemeLabel, type EvidenceRiskTheme, type NormalizedEvidenceV1 } from "./normalized-evidence";

function isHighlighted(ev: NormalizedEvidenceV1): boolean {
  return (
    ev.reviewStatus === "official_record_found" ||
    ev.reviewStatus === "requires_review" ||
    ev.riskTheme === "adverse_media" ||
    ev.riskTheme === "sanctions_watchlist" ||
    ev.riskTheme === "pep" ||
    ev.riskTheme === "legal_regulatory"
  );
}

function themeLabelFor(ev: NormalizedEvidenceV1): string {
  if (ev.riskTheme && ev.riskTheme !== "unknown" && ev.riskTheme !== "neutral_profile") {
    return riskThemeLabel(ev.riskTheme);
  }
  if (ev.reviewStatus === "requires_review") return "Проверка";
  return "Сигнал";
}

function toResultView(ev: NormalizedEvidenceV1): ResultView {
  const highlighted = isHighlighted(ev) && ev.riskTheme !== "neutral_profile";
  return {
    rank: null,
    title: ev.title ?? ev.domain ?? "Результат поиска",
    url: ev.displayUrl ?? ev.domain ?? "",
    domain: ev.domain ?? ev.displayUrl ?? "",
    snippet: ev.snippet ?? "",
    classification: "",
    isHighlighted: highlighted,
    themeLabel: highlighted ? themeLabelFor(ev) : undefined,
  };
}

function buildSingleEngineViewModel(input: {
  engine: SerpEngine;
  query: string;
  subjectName: string;
  results: NormalizedEvidenceV1[];
  language?: "ru" | "en";
}): SerpSnapshotViewModel {
  const language = input.language ?? "ru";
  const resultViews = input.results.slice(0, 8).map(toResultView);
  const empty = resultViews.length === 0;
  const engineView = {
    engine: input.engine,
    query: input.query,
    results: resultViews,
    empty,
  };
  const dateLabel = new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());

  return {
    title: language === "ru" ? "Поисковая выдача" : "Search results",
    dateLabel,
    subjectName: input.subjectName,
    query: input.query,
    language,
    themes: [],
    noNegatives: !resultViews.some((r) => r.isHighlighted),
    engines: {
      yandex: input.engine === "YANDEX" ? engineView : { engine: "YANDEX", query: input.query, results: [], empty: true },
      google: input.engine === "GOOGLE" ? engineView : { engine: "GOOGLE", query: input.query, results: [], empty: true },
    },
    width: 1400,
    height: 900,
    footerNote:
      language === "ru"
        ? "Синтетический снимок на основе сохранённых результатов поиска"
        : "Synthetic snapshot from stored search results",
    sourceLabel: input.engine === "YANDEX" ? "Яндекс" : "Google",
  };
}

/** Full-width single-engine SERP PNG (ORION serp-snapshot renderer, cropped to active engine). */
export async function buildOrionSingleEngineSerpPng(input: {
  provider: "yandex" | "google";
  query: string;
  subjectName: string;
  evidence: NormalizedEvidenceV1[];
}): Promise<Buffer | null> {
  const engine: SerpEngine = input.provider === "yandex" ? "YANDEX" : "GOOGLE";
  const rows = input.evidence.filter(
    (e) => e.sourceKind === "search_result" && e.provider === input.provider
  );
  if (rows.length === 0) return null;

  const vm = buildSingleEngineViewModel({
    engine,
    query: input.query,
    subjectName: input.subjectName,
    results: rows,
    language: "ru",
  });

  // Use production renderer — shows both panels but populated engine has real ORION styling.
  return renderSerpSnapshotPng(vm);
}

export function inspectSyntheticSerpAssets(assets: Array<{ assetRef: string; status: string; kind: string }>): {
  yandexReady: boolean;
  googleReady: boolean;
  yandexRef: string;
  googleRef: string;
} {
  const yandex = assets.find((a) => a.assetRef === "ru_yandex_serp_snapshot");
  const google = assets.find((a) => a.assetRef === "ru_google_serp_snapshot");
  return {
    yandexReady: yandex?.status === "ready",
    googleReady: google?.status === "ready",
    yandexRef: "ru_yandex_serp_snapshot",
    googleRef: "ru_google_serp_snapshot",
  };
}
