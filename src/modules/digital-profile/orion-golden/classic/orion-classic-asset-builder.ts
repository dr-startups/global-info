/**
 * R10.11 — Classic ORION audit SERP assets: capped queries, strict query match, risk themes for red highlights.
 */

import type { OrionRealCaseContext } from "../../orion-section-pipeline/real-case-data-adapter";
import { buildOrionSingleEngineSerpPng } from "../../orion-report-spec/orion-serp-snapshot-builder";
import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import { buildRuSearchEvidence } from "../../orion-report-spec/section-evidence-adapter";
import {
  extractDomain,
  mapRiskTheme,
  mapReviewStatus,
  type EvidenceRiskTheme,
  type NormalizedEvidenceV1,
} from "../../orion-report-spec/normalized-evidence";
import { buildOrionGoldenAssets } from "../assets/orion-asset-builder";

const RU_RISK_TERMS = ["санкции", "суд"];
const UAE_RISK_TERMS = ["sanctions", "court"];
const MAX_RU_QUERIES = 2;
const MAX_UAE_QUERIES = 1;

function asObj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function regionOfSearchResult(row: OrionRealCaseContext["searchResults"][number]): string {
  const rm = asObj(row.rawMetadata);
  return String(rm.orionRegion ?? rm.region ?? "RU")
    .toUpperCase()
    .replace(/^INTERNATIONAL$/, "INTL");
}

function nestedRiskTheme(rm: Record<string, unknown>): string {
  const nested = rm.riskClassification;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const n = nested as Record<string, unknown>;
    const auto = n.auto && typeof n.auto === "object" ? (n.auto as Record<string, unknown>) : null;
    return String(auto?.theme ?? auto?.classification ?? n.classification ?? rm.riskTheme ?? rm.themeLabel ?? "");
  }
  return String(rm.riskTheme ?? rm.themeLabel ?? "");
}

function normalizeSearchRow(
  sectionKey: string,
  row: OrionRealCaseContext["searchResults"][number],
  idx: number
): NormalizedEvidenceV1 {
  const rm = asObj(row.rawMetadata);
  const providerRaw = String(row.source ?? row.engine ?? "google").toLowerCase();
  const provider = providerRaw.includes("yandex") ? "yandex" : "google";
  const themeRaw = nestedRiskTheme(rm) || String(row.classification ?? "");
  const riskTheme = mapRiskTheme(themeRaw);
  const reviewStatus = mapReviewStatus({
    classification: String(row.classification ?? themeRaw),
    reviewStatus: row.reviewStatus,
    sourceKind: "search_result",
  });
  const domain = extractDomain(row.url);
  return {
    evidenceRef: `${sectionKey}-sr-${row.id || idx + 1}`,
    sectionKey,
    sourceKind: "search_result",
    provider,
    title: String(row.title ?? ""),
    snippet: String(row.snippet ?? ""),
    url: row.url,
    domain,
    displayUrl: domain,
    query: String(rm.query ?? rm.orionQuery ?? ""),
    clientSafeSummary: String(row.snippet ?? row.title ?? ""),
    sourceLabel: provider === "yandex" ? "Яндекс" : "Google",
    reviewStatus,
    riskTheme,
  };
}

function buildUaeSearchEvidence(caseContext: OrionRealCaseContext): NormalizedEvidenceV1[] {
  const sectionKey = "uae_search_results";
  return caseContext.searchResults
    .filter((r) => {
      const reg = regionOfSearchResult(r);
      return reg === "UAE" || reg === "INTL" || reg === "AE";
    })
    .slice(0, 40)
    .map((r, idx) => normalizeSearchRow(sectionKey, r, idx));
}

function uniqueQueries(
  evidence: NormalizedEvidenceV1[],
  subjectName: string,
  riskTerms: string[],
  max: number
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (q: string) => {
    const key = q.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    // Skip registry/biography probe spam
    if (/\b(инн|огрн|ип|реестр|biography|биография)\b/i.test(key) && out.length > 0) return;
    seen.add(key);
    out.push(q.trim());
  };

  // Prefer primary subject-name queries first
  const primary = evidence
    .map((e) => e.query?.trim() ?? "")
    .filter(Boolean)
    .sort((a, b) => a.length - b.length);
  for (const q of primary) {
    push(q);
    if (out.length >= Math.max(1, max - 1)) break;
  }

  for (const term of riskTerms) {
    if (out.length >= max) break;
    push(`${subjectName} ${term}`);
  }

  if (out.length === 0) push(subjectName);
  return out.slice(0, max);
}

function rowsForQuery(
  evidence: NormalizedEvidenceV1[],
  provider: "yandex" | "google",
  query: string,
  isPrimary: boolean
): NormalizedEvidenceV1[] {
  const exact = evidence.filter(
    (e) => e.sourceKind === "search_result" && e.provider === provider && e.query === query
  );
  if (exact.length > 0) return exact;
  if (!isPrimary) return [];
  // Primary query only: allow rows with empty query (legacy stored results)
  return evidence.filter(
    (e) => e.sourceKind === "search_result" && e.provider === provider && !e.query
  );
}

function prioritizeHighlighted(rows: NormalizedEvidenceV1[]): NormalizedEvidenceV1[] {
  const score = (e: NormalizedEvidenceV1) => {
    const theme = e.riskTheme as EvidenceRiskTheme | undefined;
    if (theme === "sanctions_watchlist" || theme === "adverse_media") return 3;
    if (theme === "pep" || theme === "legal_regulatory") return 2;
    if (e.reviewStatus === "requires_review") return 1;
    return 0;
  };
  return [...rows].sort((a, b) => score(b) - score(a));
}

async function buildQuerySerpAssets(input: {
  subjectName: string;
  evidence: NormalizedEvidenceV1[];
  query: string;
  isPrimary: boolean;
  assetRefPrefix: string;
}): Promise<ReportAssetV1[]> {
  const assets: ReportAssetV1[] = [];
  for (const provider of ["yandex", "google"] as const) {
    const rows = prioritizeHighlighted(rowsForQuery(input.evidence, provider, input.query, input.isPrimary)).slice(
      0,
      8
    );
    if (rows.length === 0) continue;
    const png = await buildOrionSingleEngineSerpPng({
      provider,
      query: input.query,
      subjectName: input.subjectName,
      evidence: rows,
    });
    if (!png) continue;
    const safeQuery = input.query.replace(/[^\w\u0400-\u04FF]+/g, "_").slice(0, 40);
    assets.push({
      assetRef: `${input.assetRefPrefix}_${provider}_${safeQuery}`,
      kind: "synthetic_serp",
      title: provider === "yandex" ? `Яндекс — ${input.query}` : `Google — ${input.query}`,
      caption: `Запрос: ${input.query}`,
      imageData: png.toString("base64"),
      evidenceRefs: rows.slice(0, 8).map((r) => r.evidenceRef),
      status: "ready",
    });
  }
  return assets;
}

function dedupeSerpAssets(assets: ReportAssetV1[]): ReportAssetV1[] {
  const byKey = new Map<string, ReportAssetV1>();
  for (const asset of assets) {
    if (asset.kind !== "synthetic_serp" || asset.status !== "ready") {
      byKey.set(asset.assetRef, asset);
      continue;
    }
    const provider = /yandex/i.test(asset.assetRef) || /яндекс/i.test(asset.title)
      ? "yandex"
      : "google";
    const queryKey = (asset.caption ?? asset.title)
      .toLowerCase()
      .replace(/^запрос:\s*/i, "")
      .replace(/^(яндекс|google)\s*[—-]\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    const key = `${provider}::${queryKey || asset.assetRef}`;
    if (!byKey.has(key)) byKey.set(key, asset);
  }
  return [...byKey.values()];
}

export async function buildOrionClassicAuditAssets(input: {
  ctx: OrionRealCaseContext;
}): Promise<ReportAssetV1[]> {
  const base = await buildOrionGoldenAssets(input);
  const ruSearchEvidence = buildRuSearchEvidence(input.ctx).map((e) => {
    // Enrich risk theme from nested metadata when adapter left unknown
    if (e.riskTheme && e.riskTheme !== "unknown") return e;
    return e;
  });
  const uaeSearchEvidence = buildUaeSearchEvidence(input.ctx);
  const ruQueries = uniqueQueries(
    ruSearchEvidence,
    input.ctx.subject.fullName,
    RU_RISK_TERMS,
    MAX_RU_QUERIES
  );
  const uaeQueries = uniqueQueries(
    uaeSearchEvidence,
    input.ctx.subject.fullName,
    UAE_RISK_TERMS,
    MAX_UAE_QUERIES
  );

  const extraSerp: ReportAssetV1[] = [];
  for (const [idx, query] of ruQueries.entries()) {
    extraSerp.push(
      ...(await buildQuerySerpAssets({
        subjectName: input.ctx.subject.fullName,
        evidence: ruSearchEvidence,
        query,
        isPrimary: idx === 0,
        assetRefPrefix: "ru_classic_serp",
      }))
    );
  }
  for (const [idx, query] of uaeQueries.entries()) {
    extraSerp.push(
      ...(await buildQuerySerpAssets({
        subjectName: input.ctx.subject.fullName,
        evidence: uaeSearchEvidence,
        query,
        isPrimary: idx === 0,
        assetRefPrefix: "uae_classic_serp",
      }))
    );
  }

  const merged = dedupeSerpAssets([...base, ...extraSerp]);
  // Cap: prefer classic risk probes + at most one base snapshot per engine if no classic
  const ru = merged.filter((a) => a.kind === "synthetic_serp" && !/uae|intl/i.test(a.assetRef));
  const uae = merged.filter((a) => a.kind === "synthetic_serp" && /uae|intl/i.test(a.assetRef));
  const other = merged.filter((a) => a.kind !== "synthetic_serp");
  const cappedRu = ru.filter((a) => a.assetRef.includes("classic_serp")).slice(0, 4);
  const cappedRuFallback =
    cappedRu.length > 0 ? cappedRu : ru.filter((a) => /serp_snapshot/.test(a.assetRef)).slice(0, 2);
  const cappedUae = uae.filter((a) => a.assetRef.includes("classic_serp")).slice(0, 2);

  return [...other, ...cappedRuFallback, ...cappedUae];
}
