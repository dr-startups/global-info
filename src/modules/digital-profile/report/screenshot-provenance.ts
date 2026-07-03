import type { ReportScreenshotProvenanceRow } from "../types";

interface SnapshotMetaInput {
  id?: string;
  mode?: string;
  metadata?: Record<string, unknown>;
}

interface ScreenshotRowInput {
  id: string;
  storageKey: string;
  sourceUrl?: string | null;
}

export function buildScreenshotProvenance(input: {
  serpSnapshot?: SnapshotMetaInput | null;
  screenshots?: ScreenshotRowInput[];
  reportLanguage?: "ru" | "en";
}): ReportScreenshotProvenanceRow[] {
  const out: ReportScreenshotProvenanceRow[] = [];
  const ru = input.reportLanguage !== "en";
  const ss = input.serpSnapshot;
  const md = (ss?.metadata as Record<string, unknown> | undefined) ?? {};
  const hasSnapshot = Boolean(ss?.id);
  const sourceMode = String(md.sourceMode ?? "EMPTY").toUpperCase();
  const fallbackReason = String(md.staleReason ?? "").trim() || undefined;

  if (hasSnapshot) {
    const kind: ReportScreenshotProvenanceRow["screenshotKind"] =
      sourceMode === "EMPTY" ? "fallback_serp" : "synthetic_serp";
    out.push({
      screenshotId: String(ss?.id),
      screenshotKind: kind,
      providerId: "serp_snapshot",
      queryId: `ss-${String(md.language ?? "ru")}-${String(md.generatedAt ?? "run")}`,
      region: "MULTI",
      language: String(md.language ?? "ru"),
      sourceSurfaceIds: [],
      generatedFrom:
        kind === "fallback_serp" ? "fallback_empty_state" : "synthetic_renderer",
      fallbackReason,
      containsHighlightedEvidence: Number(md.highlightedCount ?? 0) > 0,
      highlightedSourceFingerprints: [],
      clientSafeCaption:
        kind === "fallback_serp"
          ? ru
            ? "Снимок поисковой выдачи недоступен для этого отчёта."
            : "Search snapshot is unavailable for this report."
          : ru
            ? "Поисковый снимок сформирован по собранным результатам."
            : "Search snapshot generated from collected search results.",
      internalCaption:
        kind === "fallback_serp"
          ? "Synthetic snapshot fallback (empty/no linked search data)."
          : `Synthetic SERP snapshot built from stored result data (sourceMode=${sourceMode}).`,
      warningCodes: kind === "fallback_serp" ? ["fallback_empty_state"] : [],
    });
  }

  for (const sc of input.screenshots ?? []) {
    // Keep user/manual screenshots auditable but never claim "real SERP" unless source URL is explicit.
    const src = String(sc.sourceUrl ?? "").toLowerCase();
    const isSerp =
      src.includes("google.") || src.includes("yandex.") || src.includes("search?");
    out.push({
      screenshotId: sc.id,
      screenshotKind: isSerp ? "real_serp" : "none",
      providerId: "manual_screenshot",
      region: "UNKNOWN",
      language: "unknown",
      sourceSurfaceIds: [],
      generatedFrom: "unknown",
      containsHighlightedEvidence: false,
      clientSafeCaption: ru
        ? "Скриншот источника приложен для проверки материалов."
        : "Source screenshot attached for evidence review.",
      internalCaption: "Manual screenshot attachment from stored case evidence.",
      artifactPathInternal: sc.storageKey,
      warningCodes: [],
    });
  }

  return out;
}
