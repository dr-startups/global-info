/**
 * R10.11 — Extended asset builder for classic ORION audit (multi-query SERP + risk probes).
 */

import type { OrionRealCaseContext } from "../../orion-section-pipeline/real-case-data-adapter";
import { buildOrionSingleEngineSerpPng } from "../../orion-report-spec/orion-serp-snapshot-builder";
import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import { buildRuSearchEvidence } from "../../orion-report-spec/section-evidence-adapter";
import type { NormalizedEvidenceV1 } from "../../orion-report-spec/normalized-evidence";
import { buildOrionGoldenAssets } from "../assets/orion-asset-builder";

const RU_RISK_TERMS = [
  "суд",
  "арест",
  "санкции",
  "уголовное",
  "мошенничество",
  "компромат",
  "коррупция",
];

const UAE_RISK_TERMS = ["sanctions", "court", "fraud", "corruption", "arrest", "offshore"];

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

function buildUaeSearchEvidence(caseContext: OrionRealCaseContext): NormalizedEvidenceV1[] {
  const sectionKey = "uae_search_results";
  const uaeResults = caseContext.searchResults.filter((r) => {
    const reg = regionOfSearchResult(r);
    return reg === "UAE" || reg === "INTL" || reg === "AE";
  });
  return uaeResults.slice(0, 40).map((r, idx) => {
    const rm = asObj(r.rawMetadata);
    const providerRaw = String(r.source ?? r.engine ?? "google").toLowerCase();
    const provider = providerRaw.includes("yandex") ? "yandex" : "google";
    return {
      evidenceRef: `uae-sr-${r.id || idx + 1}`,
      sectionKey,
      sourceKind: "search_result" as const,
      provider: provider as "yandex" | "google",
      title: String(r.title ?? ""),
      snippet: String(r.snippet ?? ""),
      url: r.url,
      query: String(rm.query ?? rm.orionQuery ?? ""),
      clientSafeSummary: String(r.snippet ?? r.title ?? ""),
      sourceLabel: provider,
      reviewStatus: "requires_review" as const,
      riskTheme: "unknown" as const,
    };
  });
}

function uniqueQueries(evidence: NormalizedEvidenceV1[], subjectName: string, riskTerms: string[], max = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (q: string) => {
    const key = q.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(q.trim());
  };

  for (const e of evidence) {
    if (e.query) push(e.query);
    if (out.length >= max) break;
  }

  push(`${subjectName} биография`);
  push(`${subjectName} biography`);
  for (const term of riskTerms) {
    if (out.length >= max + 2) break;
    push(`${subjectName} ${term}`);
  }

  return out.slice(0, max + 2);
}

async function buildQuerySerpAssets(input: {
  subjectName: string;
  evidence: NormalizedEvidenceV1[];
  query: string;
  assetRefPrefix: string;
}): Promise<ReportAssetV1[]> {
  const assets: ReportAssetV1[] = [];
  for (const provider of ["yandex", "google"] as const) {
    const rows = input.evidence.filter(
      (e) =>
        e.sourceKind === "search_result" &&
        e.provider === provider &&
        (e.query === input.query || !e.query)
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

export async function buildOrionClassicAuditAssets(input: {
  ctx: OrionRealCaseContext;
}): Promise<ReportAssetV1[]> {
  const base = await buildOrionGoldenAssets(input);
  const ruSearchEvidence = buildRuSearchEvidence(input.ctx);
  const uaeSearchEvidence = buildUaeSearchEvidence(input.ctx);
  const ruQueries = uniqueQueries(ruSearchEvidence, input.ctx.subject.fullName, RU_RISK_TERMS);
  const uaeQueries = uniqueQueries(uaeSearchEvidence, input.ctx.subject.fullName, UAE_RISK_TERMS, 4);

  const extraSerp: ReportAssetV1[] = [];
  for (const query of ruQueries) {
    const batch = await buildQuerySerpAssets({
      subjectName: input.ctx.subject.fullName,
      evidence: ruSearchEvidence,
      query,
      assetRefPrefix: "ru_classic_serp",
    });
    extraSerp.push(...batch);
  }
  for (const query of uaeQueries) {
    const batch = await buildQuerySerpAssets({
      subjectName: input.ctx.subject.fullName,
      evidence: uaeSearchEvidence,
      query,
      assetRefPrefix: "uae_classic_serp",
    });
    extraSerp.push(...batch);
  }

  const merged = [...base];
  const existingRefs = new Set(base.map((a) => a.assetRef));
  for (const asset of extraSerp) {
    if (!existingRefs.has(asset.assetRef)) {
      merged.push(asset);
      existingRefs.add(asset.assetRef);
    }
  }
  return merged;
}
