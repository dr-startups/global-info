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

function uniqueQueries(evidence: NormalizedEvidenceV1[], subjectName: string, max = 5): string[] {
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
  for (const term of RU_RISK_TERMS) {
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
  const queries = uniqueQueries(ruSearchEvidence, input.ctx.subject.fullName);

  const extraSerp: ReportAssetV1[] = [];
  for (const query of queries) {
    const batch = await buildQuerySerpAssets({
      subjectName: input.ctx.subject.fullName,
      evidence: ruSearchEvidence,
      query,
      assetRefPrefix: "ru_classic_serp",
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
