/**
 * Approved manual visual pages for Dow Jones / World-Check (Lexis-parallel).
 *
 * Expected DatabaseProfile.rawMetadataSafe.complianceVisual shape:
 * {
 *   kind: "dow_jones_report" | "world_check_report",
 *   approved: true,
 *   approvedAt?: string,
 *   approvedBy?: string,
 *   renderedPages: Array<{ pageNumber, storageKey?, imageBase64?, contentBase64?, caption? }>
 * }
 */

import { loadFile } from "../../storage/private-store";
import type { ReportAssetV1 } from "../assets/asset-builder";
import type { OrionRealCaseContext } from "../evidence/real-case-context";

function asObj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

export type ComplianceVisualProvider = "DOW_JONES" | "WORLD_CHECK";

export type ComplianceVisualPageInput = {
  pageNumber: number;
  storageKey?: string;
  imageBase64?: string;
  contentBase64?: string;
  caption?: string;
};

export type ComplianceVisualMeta = {
  kind: "dow_jones_report" | "world_check_report";
  approved: boolean;
  approvedAt?: string;
  approvedBy?: string;
  renderedPages: ComplianceVisualPageInput[];
};

export function parseComplianceVisualMeta(raw: unknown): ComplianceVisualMeta | null {
  const root = asObj(raw);
  const visual = asObj(root.complianceVisual);
  if (!visual || Object.keys(visual).length === 0) return null;
  const pages = Array.isArray(visual.renderedPages)
    ? (visual.renderedPages as Array<Record<string, unknown>>)
    : [];
  const kindRaw = String(visual.kind ?? "");
  const kind =
    kindRaw === "world_check_report" || /world.?check/i.test(kindRaw)
      ? ("world_check_report" as const)
      : ("dow_jones_report" as const);
  return {
    kind,
    approved: visual.approved === true || String(visual.approved).toLowerCase() === "true",
    approvedAt: visual.approvedAt ? String(visual.approvedAt) : undefined,
    approvedBy: visual.approvedBy ? String(visual.approvedBy) : undefined,
    renderedPages: pages.map((p, idx) => ({
      pageNumber: Number(p.pageNumber ?? idx + 1),
      storageKey: p.storageKey ? String(p.storageKey) : undefined,
      imageBase64: p.imageBase64 ? String(p.imageBase64) : undefined,
      contentBase64: p.contentBase64 ? String(p.contentBase64) : undefined,
      caption: p.caption ? String(p.caption) : undefined,
    })),
  };
}

/** Build a rawMetadataSafe patch for approved DJ/WC screenshots (admin/import helper). */
export function buildApprovedComplianceVisualMeta(input: {
  provider: ComplianceVisualProvider;
  pages: ComplianceVisualPageInput[];
  approvedBy?: string;
  approvedAt?: string;
}): ComplianceVisualMeta {
  return {
    kind: input.provider === "WORLD_CHECK" ? "world_check_report" : "dow_jones_report",
    approved: true,
    approvedAt: input.approvedAt ?? new Date().toISOString(),
    approvedBy: input.approvedBy,
    renderedPages: input.pages.map((p, idx) => ({
      pageNumber: p.pageNumber || idx + 1,
      storageKey: p.storageKey,
      imageBase64: p.imageBase64,
      contentBase64: p.contentBase64,
      caption: p.caption,
    })),
  };
}

function providerLabel(provider: string): string {
  if (/world.?check/i.test(provider)) return "World-Check";
  if (/dow.?jones/i.test(provider)) return "Dow Jones";
  return provider;
}

function assetRefPrefix(provider: string): string {
  return /world.?check/i.test(provider) ? "world_check_visual_page" : "dow_jones_visual_page";
}

async function resolvePageBytes(page: ComplianceVisualPageInput): Promise<string | null> {
  const inline = String(page.imageBase64 ?? page.contentBase64 ?? "").trim();
  if (inline.length >= 800) return inline;
  const key = String(page.storageKey ?? "").trim();
  if (!key) return null;
  try {
    const bytes = await loadFile(key);
    if (bytes.length < 500) return null;
    return bytes.toString("base64");
  } catch {
    return null;
  }
}

/**
 * Emit ready compliance_visual_page assets only for approved manual screenshots.
 */
export async function buildComplianceVisualAssets(
  ctx: OrionRealCaseContext
): Promise<ReportAssetV1[]> {
  const assets: ReportAssetV1[] = [];
  const profiles = ctx.databaseProfiles ?? [];

  for (const row of profiles) {
    const provider = String(row.provider ?? "").toUpperCase();
    if (provider !== "DOW_JONES" && provider !== "WORLD_CHECK") continue;

    const meta = parseComplianceVisualMeta(row.rawMetadataSafe);
    if (!meta || !meta.approved || meta.renderedPages.length === 0) continue;

    // Prefer confirmed matches; still allow approved visuals on NEEDS_REVIEW with explicit approved flag.
    const reviewOk =
      row.reviewStatus === "MATCH_CONFIRMED" ||
      row.reviewStatus === "POTENTIAL_MATCH" ||
      meta.approved;
    if (!reviewOk) continue;

    const prefix = assetRefPrefix(provider);
    const label = providerLabel(provider);
    let pageIdx = 0;
    for (const page of meta.renderedPages.slice(0, 4)) {
      const imageData = await resolvePageBytes(page);
      if (!imageData) continue;
      pageIdx += 1;
      assets.push({
        assetRef: `${prefix}_${page.pageNumber || pageIdx}`,
        kind: "compliance_visual_page",
        title: `${label} — страница ${page.pageNumber || pageIdx}`,
        caption:
          page.caption ||
          (meta.approvedAt
            ? `Approved manual visual · ${meta.approvedAt.slice(0, 10)}`
            : "Approved manual visual"),
        imageData,
        storageKey: page.storageKey,
        evidenceRefs: [`database_profile:${row.id}`, `compliance_visual:${provider.toLowerCase()}`],
        status: "ready",
      });
    }
  }

  return assets;
}
