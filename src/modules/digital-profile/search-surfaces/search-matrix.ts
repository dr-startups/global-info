/**
 * Stage O1 — search matrix view model.
 *
 * Aggregates organic rows across query variants and engines into a matrix where
 * rows are unique URLs and columns track rank positions per query/engine.
 */

import { normalizeUrl } from "../services/evidence-service";
import {
  isRiskyResultClass,
  readRiskClassification,
  type ResultClass,
} from "../risk-classifier/result-classifier";

export interface MatrixResultInput {
  id: string;
  engine: string;
  url: string;
  title: string | null;
  snippet: string | null;
  rank: number | null;
  classification: string | null;
  rawMetadata: unknown;
}

export interface MatrixCell {
  query: string;
  engine: string;
  rank: number | null;
  page?: number;
}

export interface SearchMatrixRow {
  normalizedUrl: string;
  url: string;
  title: string;
  domain: string;
  classification: string;
  riskTheme: string | null;
  isAdverse: boolean;
  /** Rank appearances keyed by `engine|query`. */
  appearances: MatrixCell[];
  providerSources: string[];
}

export interface SearchMatrixSummary {
  queryVariants: string[];
  engines: string[];
  totalResultRows: number;
  uniqueUrls: number;
  uniqueAdverseUrls: number;
  adversePercentage: number;
  topAdverseThemes: { theme: string; count: number }[];
  topAdverseDomains: { domain: string; count: number }[];
  providerLimitNotes: string[];
}

export interface SearchMatrix {
  rows: SearchMatrixRow[];
  summary: SearchMatrixSummary;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function metaQuery(row: MatrixResultInput): string | null {
  const meta = (row.rawMetadata ?? {}) as Record<string, unknown>;
  const q = meta.query ?? meta.orionQuery;
  return typeof q === "string" && q.trim() ? q.trim() : null;
}

function metaRegion(row: MatrixResultInput): string | null {
  const meta = (row.rawMetadata ?? {}) as Record<string, unknown>;
  const r = meta.region ?? meta.orionRegion;
  return typeof r === "string" ? r : null;
}

function effectiveClassification(row: MatrixResultInput): { classification: string; theme: string | null; adverse: boolean } {
  const rc = readRiskClassification(row.rawMetadata);
  const auto = rc?.auto;
  const manual = rc?.manual;
  const cls = (manual?.classification ?? auto?.classification ?? row.classification ?? "UNCLASSIFIED") as ResultClass | string;
  const theme = manual?.riskTheme ?? auto?.riskTheme ?? null;
  const adverse = manual ? isRiskyResultClass(manual.classification) : isRiskyResultClass(cls as ResultClass);
  return { classification: String(cls), theme, adverse };
}

/** Filters matrix inputs to a single audit region when region metadata is present. */
export function filterMatrixInputsByRegion(
  rows: MatrixResultInput[],
  region: string
): MatrixResultInput[] {
  const upper = region.toUpperCase();
  const withRegion = rows.filter((r) => metaRegion(r)?.toUpperCase() === upper);
  if (withRegion.length > 0) return withRegion;
  // Legacy rows without region metadata — include all for RU, none for others.
  return upper === "RU" ? rows : [];
}

export function buildSearchMatrix(rows: MatrixResultInput[]): SearchMatrix {
  const byUrl = new Map<string, SearchMatrixRow>();
  const querySet = new Set<string>();
  const engineSet = new Set<string>();
  const providerLimits = new Set<string>();
  let totalRows = 0;

  for (const row of rows) {
    const url = row.url?.trim();
    if (!url) continue;
    totalRows += 1;
    const norm = normalizeUrl(url);
    const query = metaQuery(row) ?? "";
    if (query) querySet.add(query);
    engineSet.add(row.engine);
    const meta = (row.rawMetadata ?? {}) as Record<string, unknown>;
    if (typeof meta.providerLimit === "number") {
      providerLimits.add(`Provider returned max ${meta.providerLimit} results per query`);
    }

    const { classification, theme, adverse } = effectiveClassification(row);
    let existing = byUrl.get(norm);
    if (!existing) {
      existing = {
        normalizedUrl: norm,
        url,
        title: row.title ?? url,
        domain: domainOf(url),
        classification,
        riskTheme: theme,
        isAdverse: adverse,
        appearances: [],
        providerSources: [],
      };
      byUrl.set(norm, existing);
    }
    if (adverse) {
      existing.isAdverse = true;
      if (theme) existing.riskTheme = theme;
    }
    existing.appearances.push({
      query: query || "(unknown)",
      engine: row.engine,
      rank: row.rank,
      page: typeof meta.page === "number" ? meta.page : undefined,
    });
    const src = String(meta.provider ?? row.engine);
    if (!existing.providerSources.includes(src)) existing.providerSources.push(src);
  }

  const matrixRows = [...byUrl.values()].sort((a, b) => {
    const aMin = Math.min(...a.appearances.map((x) => x.rank ?? 999), 999);
    const bMin = Math.min(...b.appearances.map((x) => x.rank ?? 999), 999);
    return aMin - bMin;
  });

  const adverseRows = matrixRows.filter((r) => r.isAdverse);
  const themeCounts = new Map<string, number>();
  const domainCounts = new Map<string, number>();
  for (const r of adverseRows) {
    const t = r.riskTheme ?? r.classification;
    themeCounts.set(t, (themeCounts.get(t) ?? 0) + 1);
    if (r.domain) domainCounts.set(r.domain, (domainCounts.get(r.domain) ?? 0) + 1);
  }

  const uniqueUrls = matrixRows.length;
  const uniqueAdverseUrls = adverseRows.length;

  return {
    rows: matrixRows,
    summary: {
      queryVariants: [...querySet],
      engines: [...engineSet],
      totalResultRows: totalRows,
      uniqueUrls,
      uniqueAdverseUrls,
      adversePercentage: uniqueUrls > 0 ? Math.round((uniqueAdverseUrls / uniqueUrls) * 1000) / 10 : 0,
      topAdverseThemes: [...themeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([theme, count]) => ({ theme, count })),
      topAdverseDomains: [...domainCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([domain, count]) => ({ domain, count })),
      providerLimitNotes: [...providerLimits],
    },
  };
}
