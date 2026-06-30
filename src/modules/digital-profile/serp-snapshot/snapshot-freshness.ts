/**
 * Stage R1.1.3 — ensure report generation embeds a fresh, consistent SERP snapshot.
 */

import { prisma } from "@/server/prisma/client";
import { createInternalHygieneWarning, type ReportWarning } from "../report/report-data-policy";
import { assertSnapshotHighlightInvariant } from "./snapshot-consistency";
import { buildSnapshot, generateSerpSnapshot, getLatestSerpSnapshot } from "./service";
import type { SerpLanguage, SerpSnapshotMetadata, SerpSnapshotResult, SourcePreference } from "./types";
import type { ActorContext } from "../services/case-service";

/** Bump when highlight/classification policy or snapshot layout semantics change. */
export const SERP_SNAPSHOT_GENERATOR_VERSION = "r1.1.3";

export const REPORT_WARNING_SERP_REGENERATE_FAILED = {
  en: "SERP snapshot could not be refreshed for this report; search-screens page uses fallback text.",
  ru: "SERP snapshot не удалось обновить для отчёта; страница поисковых экранов использует запасной текст.",
} as const;

export const REPORT_WARNING_SERP_STALE_EMBED_BLOCKED = {
  en: "Stale or inconsistent SERP snapshot was not embedded; search-screens page uses fallback text.",
  ru: "Устаревший или неконсistentный SERP snapshot не встроен; страница поисковых экранов использует запасной текст.",
} as const;

export interface EnsureFreshSerpSnapshotOptions {
  language?: SerpLanguage;
  sourcePreference?: SourcePreference;
  subjectName?: string;
  actorId?: string | null;
}

export interface EnsureFreshSerpSnapshotResult {
  snapshot: SerpSnapshotResult | null;
  wasRegenerated: boolean;
  staleReason?: string;
  regenerateFailed: boolean;
  internalWarning?: ReportWarning;
}

async function latestEvidenceUpdatedAt(caseId: string): Promise<Date | null> {
  const [searchMax, findingMax] = await Promise.all([
    prisma.searchResult.findFirst({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.riskFinding.findFirst({
      where: { caseId },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
  ]);
  const dates = [searchMax?.createdAt, findingMax?.updatedAt].filter(Boolean) as Date[];
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

export function metadataStaleReason(
  md: SerpSnapshotMetadata | null | undefined,
  caseId: string,
  evidenceUpdatedAt: Date | null
): string | null {
  if (!md) return "missing_metadata";
  if (md.caseId !== caseId) return "case_mismatch";
  if (md.generatorVersion !== SERP_SNAPSHOT_GENERATOR_VERSION) return "generator_version";
  if (md.themeCount > 0 && md.highlightedCount === 0) return "inconsistent_theme";
  if (md.visibleHighlightedCount != null && md.themeCount > 0 && md.visibleHighlightedCount === 0) {
    return "inconsistent_visible_highlight";
  }
  if (evidenceUpdatedAt) {
    const generated = new Date(md.generatedAt).getTime();
    if (Number.isFinite(generated) && evidenceUpdatedAt.getTime() > generated) {
      return "evidence_newer";
    }
  }
  return null;
}

async function isSnapshotConsistent(caseId: string, md: SerpSnapshotMetadata): Promise<boolean> {
  try {
    const built = await buildSnapshot({
      caseId,
      language: md.language,
      sourcePreference: md.sourcePreference,
    });
    if (!assertSnapshotHighlightInvariant(built.grouping)) return false;
    if (built.metadata.themeCount !== md.themeCount) return false;
    if (built.metadata.highlightedCount !== md.highlightedCount) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures the case has a current SERP snapshot suitable for report embedding.
 * Regenerates when missing, stale, or inconsistent with current highlight policy.
 */
export async function ensureFreshSerpSnapshotForReport(
  caseId: string,
  reportLanguage: SerpLanguage,
  options: EnsureFreshSerpSnapshotOptions = {}
): Promise<EnsureFreshSerpSnapshotResult> {
  const ctx: ActorContext = { actorId: options.actorId ?? "report-builder" };

  try {
    const { classifyCaseSearchResults } = await import("../services/result-classification-service");
    await classifyCaseSearchResults(caseId, ctx);
  } catch {
    /* best-effort re-classify before snapshot */
  }

  const evidenceUpdatedAt = await latestEvidenceUpdatedAt(caseId);
  const latest = await getLatestSerpSnapshot(caseId);

  let staleReason: string | null = null;
  if (!latest) {
    staleReason = "missing";
  } else {
    const stored = await import("./storage").then((m) => m.getLatestSnapshot(caseId));
    staleReason = metadataStaleReason(stored?.metadata, caseId, evidenceUpdatedAt);
    if (!staleReason && stored?.metadata) {
      const consistent = await isSnapshotConsistent(caseId, stored.metadata);
      if (!consistent) staleReason = "inconsistent_rebuild";
    }
  }

  if (!staleReason && latest) {
    return { snapshot: latest, wasRegenerated: false, regenerateFailed: false };
  }

  try {
    const regenerated = await generateSerpSnapshot(
      {
        caseId,
        language: options.language ?? reportLanguage,
        subjectName: options.subjectName,
        sourcePreference: options.sourcePreference,
      },
      ctx
    );
    const withFlag = await patchSnapshotMetadata(caseId, regenerated.id, {
      wasRegeneratedForReport: true,
      staleReason: staleReason ?? undefined,
    });
    return {
      snapshot: withFlag ?? regenerated,
      wasRegenerated: true,
      staleReason: staleReason ?? undefined,
      regenerateFailed: false,
    };
  } catch {
    return {
      snapshot: null,
      wasRegenerated: false,
      staleReason: staleReason ?? undefined,
      regenerateFailed: true,
      internalWarning: createInternalHygieneWarning(
        reportLanguage === "ru"
          ? REPORT_WARNING_SERP_REGENERATE_FAILED.ru
          : REPORT_WARNING_SERP_REGENERATE_FAILED.en
      ),
    };
  }
}

async function patchSnapshotMetadata(
  caseId: string,
  snapshotId: string,
  patch: Partial<SerpSnapshotMetadata>
): Promise<SerpSnapshotResult | null> {
  const { getLatestSnapshot } = await import("./storage");
  const { buildStorageKey } = await import("../storage/keys");
  const { saveFile } = await import("../storage/private-store");
  const latest = await getLatestSnapshot(caseId);
  if (!latest?.metadata || latest.id !== snapshotId) return null;
  const merged = { ...latest.metadata, ...patch };
  const metadataKey = buildStorageKey.serpSnapshotMetadata(caseId, snapshotId);
  await saveFile(metadataKey, Buffer.from(JSON.stringify(merged, null, 2), "utf8"));
  return getLatestSerpSnapshot(caseId);
}

/** Blocks embedding a stale snapshot when regeneration failed. */
export function staleEmbedBlockedWarning(language: SerpLanguage): ReportWarning {
  return createInternalHygieneWarning(
    language === "ru"
      ? REPORT_WARNING_SERP_STALE_EMBED_BLOCKED.ru
      : REPORT_WARNING_SERP_STALE_EMBED_BLOCKED.en
  );
}
