/**
 * R10 — ORION Golden asset builder (SERP, images, video, Lexis, wiki).
 */

import type { OrionRealCaseContext } from "../../orion-section-pipeline/real-case-data-adapter";
import { buildReportAssets } from "../../orion-report-spec/asset-builder";
import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import { buildRuSearchEvidence, buildUaeSearchEvidence } from "../../orion-report-spec/section-evidence-adapter";
import { buildLexisReportAssets } from "../../orion-client-storyboard/lexis-asset-builder";
import { buildComplianceVisualAssets } from "../classic/orion-compliance-visual-assets";
import { loadFile } from "../../storage/private-store";
import {
  isKnowledgeSurface,
  isVideoSurface,
  resolveSearchSurfaceMediaCategory,
} from "../evidence/search-surface-media";

function asObj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

function collectLexisRenderedPages(ctx: OrionRealCaseContext): Array<Record<string, unknown>> {
  const doc = (ctx.lexis.latestReady ?? ctx.lexis.latestAny) as Record<string, unknown> | null;
  const fromDoc = Array.isArray(doc?.renderedPages)
    ? (doc.renderedPages as Array<Record<string, unknown>>)
    : [];
  if (fromDoc.length > 0) return fromDoc;

  const hybrid = asObj(asObj(ctx.reportJson).lexisNexisHybrid);
  const docs = Array.isArray(hybrid.documents) ? (hybrid.documents as Array<Record<string, unknown>>) : [];
  const pages: Array<Record<string, unknown>> = [];
  for (const entry of docs) {
    if (Array.isArray(entry.renderedPages)) {
      pages.push(...(entry.renderedPages as Array<Record<string, unknown>>));
    }
  }
  return pages;
}

async function buildOrionGoldenLexisAssets(ctx: OrionRealCaseContext): Promise<ReportAssetV1[]> {
  const primary = await buildLexisReportAssets(ctx);
  if (primary.length > 0) return primary;

  const pages = collectLexisRenderedPages(ctx);
  const assets: ReportAssetV1[] = [];

  for (const page of pages.slice(0, 12)) {
    const pageNum = Number(page.pageNumber ?? assets.length + 1);
    const assetRef = `lexis_visual_page_${pageNum}`;
    let imageData = String(page.imageBase64 ?? page.contentBase64 ?? "");
    if (!imageData) {
      const key = String(page.storageKey ?? "");
      if (key) {
        try {
          imageData = (await loadFile(key)).toString("base64");
        } catch {
          continue;
        }
      }
    }
    if (!imageData) continue;
    assets.push({
      assetRef,
      kind: "lexis_visual_page",
      title: `LexisNexis — страница ${pageNum}`,
      imageData,
      evidenceRefs: [],
      status: "ready",
    });
  }

  return assets;
}

export async function buildOrionGoldenAssets(input: {
  ctx: OrionRealCaseContext;
}): Promise<ReportAssetV1[]> {
  const ruSearchEvidence = buildRuSearchEvidence(input.ctx);
  const uaeSearchEvidence = buildUaeSearchEvidence(input.ctx);
  const serpAssets = await buildReportAssets({
    subjectName: input.ctx.subject.fullName,
    ruSearchEvidence,
    uaeSearchEvidence,
  });
  const lexisAssets = await buildOrionGoldenLexisAssets(input.ctx);
  const complianceVisualAssets = await buildComplianceVisualAssets(input.ctx);

  // Per-cell URL-only image refs are not renderable (renderer needs imageData).
  // Composite ru_image_grid / uae_image_grid from buildReportAssets cover IMAGE_RESULT surfaces.
  const imageAssets: ReportAssetV1[] = [];

  // Prefer composite video/knowledge PNGs; keep URL-only stubs only as last-resort metadata
  // (classic deck filters them out via preferCompositeMedia).
  const hasCompositeVideo = serpAssets.some((a) => a.kind === "video_cards" && a.imageData);
  const hasCompositeKnowledge = serpAssets.some((a) => a.kind === "knowledge_panel" && a.imageData);

  const videoAssets: ReportAssetV1[] = hasCompositeVideo
    ? []
    : input.ctx.searchSurfaces
        .filter((s) => isVideoSurface(s))
        .slice(0, 12)
        .map((row, idx) => ({
          assetRef: `r10-vid-${idx + 1}`,
          kind: "video_cards" as const,
          title: String(row.title ?? "Видео"),
          caption: String(row.snippet ?? "").slice(0, 120),
          status: row.videoUrl ? ("ready" as const) : ("missing" as const),
          evidenceRefs: [],
        }));

  const knowledgeAssets: ReportAssetV1[] = hasCompositeKnowledge
    ? []
    : input.ctx.searchSurfaces
        .filter((s) => isKnowledgeSurface(s))
        .slice(0, 8)
        .map((row, idx) => ({
          assetRef: `r10-knowledge-${idx + 1}`,
          kind: "knowledge_panel" as const,
          title: String(row.title ?? "Панель знаний"),
          caption: String(row.snippet ?? "").slice(0, 160),
          status: "ready" as const,
          evidenceRefs: [],
        }));

  return [
    ...serpAssets,
    ...lexisAssets,
    ...complianceVisualAssets,
    ...imageAssets,
    ...videoAssets,
    ...knowledgeAssets,
  ];
}

export function summarizeOrionGoldenAssetCounts(assets: ReportAssetV1[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const asset of assets) {
    counts[asset.kind] = (counts[asset.kind] ?? 0) + 1;
  }
  return counts;
}

export function describeSearchSurfaceBreakdown(ctx: OrionRealCaseContext): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of ctx.searchSurfaces) {
    const kind = resolveSearchSurfaceMediaCategory(row);
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

