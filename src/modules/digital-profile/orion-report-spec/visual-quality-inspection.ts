import { scanReportSpecClientText, scanReportSpecForEnglishStatus } from "./client-policy-scan";
import type { ReportAssetV1 } from "./asset-builder";
import type { OrionReportSpecV1 } from "./report-spec-schema";

export type VisualQualityInspection = {
  passed: boolean;
  score: number;
  maxScore: number;
  checks: Array<{ id: string; passed: boolean; detail?: string }>;
  gptUsed: boolean;
  gptRequired: boolean;
  pageCount: number;
  serpSlideCount: number;
};

export function inspectReportSpecVisualQuality(input: {
  reportSpec: OrionReportSpecV1;
  pageCount: number;
  gptUsed: boolean;
  gptRequired: boolean;
}): VisualQualityInspection {
  const checks: VisualQualityInspection["checks"] = [];
  const spec = input.reportSpec;
  const clientText = JSON.stringify(
    spec.sections.flatMap((s) => [
      s.title,
      s.subtitle,
      s.clientNarrative.summary,
      ...s.slides.map((sl) => sl.title),
    ])
  );

  checks.push({
    id: "no-raw-internal-keys",
    passed: !scanReportSpecClientText(clientText).some((i) => i.startsWith("raw-enum:")),
    detail: scanReportSpecClientText(clientText).filter((i) => i.startsWith("raw-enum:")).join("; "),
  });
  checks.push({ id: "no-placeholder-row", passed: !/\brow\b/i.test(clientText) });
  checks.push({ id: "no-orion-static", passed: !/ORION_STATIC/i.test(clientText) });
  checks.push({ id: "no-commercial-context", passed: !/COMMERCIAL_CONTEXT/i.test(clientText) });
  checks.push({ id: "no-field-value-table", passed: !/поле\s*\/\s*значение/i.test(clientText) });
  checks.push({
    id: "no-mixed-en-ru-status",
    passed: !scanReportSpecForEnglishStatus(spec),
  });

  const hasSearchRows = spec.evidence.some((e) => e.sourceKind === "search_result");
  const serpAssets = spec.assets.filter((a) => a.kind === "synthetic_serp" && a.status === "ready");
  checks.push({
    id: "synthetic-serp-when-search-rows",
    passed: !hasSearchRows || serpAssets.length >= 1,
    detail: String(serpAssets.length),
  });

  const serpSlides = spec.sections
    .flatMap((s) => s.slides)
    .filter((sl) => sl.template === "orion_serp_screenshot" && (sl.assetRefs?.length ?? 0) > 0);
  checks.push({
    id: "serp-screenshot-slide-rendered",
    passed: serpSlides.length >= 1,
    detail: String(serpSlides.length),
  });

  const emptyTitle = spec.sections.flatMap((s) => s.slides).some((sl) => !String(sl.title ?? "").trim());
  checks.push({ id: "all-slide-titles-present", passed: !emptyTitle });

  const emptyOnly = spec.sections.flatMap((s) => s.slides).every(
    (sl) => !sl.narrative && !(sl.bullets?.length) && !(sl.assetRefs?.length)
  );
  checks.push({ id: "no-empty-only-slides", passed: !emptyOnly });

  const sectionKeys = new Set(spec.sections.map((s) => s.sectionKey));
  checks.push({
    id: "all-three-section-narratives",
    passed:
      sectionKeys.has("executive_summary") &&
      sectionKeys.has("ru_audit_summary") &&
      sectionKeys.has("ru_search_results") &&
      spec.sections.every((s) => s.clientNarrative.summary.trim().length > 10),
  });

  checks.push({
    id: "gpt-used-when-required",
    passed: !input.gptRequired || input.gptUsed,
    detail: input.gptUsed ? "gpt-5.5" : "deterministic",
  });

  checks.push({
    id: "footer-pages-generated",
    passed: input.pageCount >= 3,
    detail: String(input.pageCount),
  });

  const passedCount = checks.filter((c) => c.passed).length;
  return {
    passed: passedCount === checks.length,
    score: passedCount,
    maxScore: checks.length,
    checks,
    gptUsed: input.gptUsed,
    gptRequired: input.gptRequired,
    pageCount: input.pageCount,
    serpSlideCount: serpSlides.length,
  };
}

export function inspectSyntheticSerp(input: {
  assets: ReportAssetV1[];
  evidenceCount: number;
}): Record<string, unknown> {
  const yandex = input.assets.find((a) => a.assetRef === "ru_yandex_serp_snapshot");
  const google = input.assets.find((a) => a.assetRef === "ru_google_serp_snapshot");
  return {
    yandex: {
      assetRef: "ru_yandex_serp_snapshot",
      status: yandex?.status ?? "missing",
      hasImage: Boolean(yandex?.imageData),
      evidenceRefs: yandex?.evidenceRefs ?? [],
      renderer: "orion-serp-snapshot-builder",
    },
    google: {
      assetRef: "ru_google_serp_snapshot",
      status: google?.status ?? "missing",
      hasImage: Boolean(google?.imageData),
      evidenceRefs: google?.evidenceRefs ?? [],
      renderer: "orion-serp-snapshot-builder",
    },
    searchEvidenceCount: input.evidenceCount,
  };
}
