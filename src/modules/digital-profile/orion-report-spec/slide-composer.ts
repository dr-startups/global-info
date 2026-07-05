import type { ReportAssetV1 } from "./asset-builder";
import type { NormalizedEvidenceV1 } from "./normalized-evidence";
import type { OrionReportSectionKey, OrionReportSectionSpecV1, OrionSlideSpecV1 } from "./report-spec-schema";
import { SECTION_TITLES } from "./report-spec-schema";

function splitBullets(bullets: string[], maxPerSlide: number): string[][] {
  if (bullets.length <= maxPerSlide) return [bullets];
  const chunks: string[][] = [];
  for (let i = 0; i < bullets.length; i += maxPerSlide) {
    chunks.push(bullets.slice(i, i + maxPerSlide));
  }
  return chunks;
}

function narrativeChunks(text: string, maxLen: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return [trimmed];
  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if ((current + " " + s).trim().length > maxLen && current) {
      chunks.push(current.trim());
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [trimmed.slice(0, maxLen)];
}

/** Canonical ORION slide flow for R9.7b target sections. */
export function composeTargetSectionSlides(input: {
  sectionKey: OrionReportSectionKey;
  section: Omit<OrionReportSectionSpecV1, "slides">;
  evidence: NormalizedEvidenceV1[];
  assets: ReportAssetV1[];
}): OrionSlideSpecV1[] {
  const { sectionKey, section, evidence, assets } = input;
  const narrative = section.clientNarrative;
  const slides: OrionSlideSpecV1[] = [];

  if (sectionKey === "executive_summary") {
    const summaryParts = narrativeChunks(narrative.summary, 420);
    slides.push({
      slideKey: "executive_summary-main",
      template: "orion_executive_summary",
      title: SECTION_TITLES.executive_summary,
      subtitle: narrative.headline,
      narrative: summaryParts[0],
      bullets: narrative.whatWasFound.slice(0, 4),
      metricRefs: section.metrics.slice(0, 4).map((m) => m.label),
      evidenceRefs: section.evidenceHighlights.slice(0, 4).map((h) => h.evidenceRef),
    });
    if (summaryParts.length > 1 || narrative.recommendedNextSteps.length > 0) {
      slides.push({
        slideKey: "executive_summary-actions",
        template: "orion_executive_summary",
        title: "Рекомендуемые действия",
        subtitle: narrative.riskInterpretation.slice(0, 120),
        bullets: [
          ...narrative.recommendedNextSteps.slice(0, 4),
          ...narrative.whatWasNotConfirmed.slice(0, 2),
        ],
      });
    }
    return slides;
  }

  if (sectionKey === "ru_audit_summary") {
    slides.push({
      slideKey: "ru_audit_summary-main",
      template: "orion_section_summary",
      title: "Россия — сводка аудита",
      subtitle: section.subtitle ?? "RU 2.1",
      narrative: narrative.summary,
      bullets: narrative.whatWasFound.slice(0, 5),
      metricRefs: section.metrics.map((m) => m.label),
      evidenceRefs: section.evidenceHighlights.slice(0, 5).map((h) => h.evidenceRef),
    });
    const reviewBullets = narrative.manualReviewQueue.slice(0, 6);
    if (reviewBullets.length > 0) {
      for (const [idx, chunk] of splitBullets(reviewBullets, 5).entries()) {
        slides.push({
          slideKey: `ru_audit_summary-review-${idx + 1}`,
          template: "orion_evidence_explanation",
          title: idx === 0 ? "Очередь ручной проверки" : "Очередь проверки (продолжение)",
          narrative: narrative.whyItMatters,
          bullets: chunk,
          evidenceRefs: section.evidenceHighlights.slice(0, 4).map((h) => h.evidenceRef),
        });
      }
    }
    return slides;
  }

  // ru_search_results — preferred flow per R9.7b spec
  slides.push({
    slideKey: "ru_search_results-overview",
    template: "orion_section_summary",
    title: "Россия — обзор поисковой выдачи",
    subtitle: "RU 2.2 — SERP и медиа-поверхности",
    narrative: narrative.summary,
    bullets: narrative.whatWasFound.slice(0, 4),
    metricRefs: section.metrics.map((m) => m.label),
  });

  const yandexAsset = assets.find((a) => a.assetRef === "ru_yandex_serp_snapshot" && a.status === "ready");
  if (yandexAsset) {
    slides.push({
      slideKey: "ru_search_yandex_serp",
      template: "orion_serp_screenshot",
      title: "Яндекс — синтетический снимок выдачи",
      subtitle: yandexAsset.caption,
      assetRefs: [yandexAsset.assetRef],
      evidenceRefs: yandexAsset.evidenceRefs.slice(0, 6),
    });
  }

  const googleAsset = assets.find((a) => a.assetRef === "ru_google_serp_snapshot" && a.status === "ready");
  if (googleAsset) {
    slides.push({
      slideKey: "ru_search_google_serp",
      template: "orion_serp_screenshot",
      title: "Google — синтетический снимок выдачи",
      subtitle: googleAsset.caption,
      assetRefs: [googleAsset.assetRef],
      evidenceRefs: googleAsset.evidenceRefs.slice(0, 6),
    });
  }

  const topSearch = evidence.filter((e) => e.sourceKind === "search_result").slice(0, 5);
  if (topSearch.length > 0) {
    for (const [idx, chunk] of splitBullets(
      topSearch.map((e) => `${e.title ?? e.domain}: ${(e.clientSafeSummary ?? e.snippet ?? "").slice(0, 100)}`),
      4
    ).entries()) {
      slides.push({
        slideKey: `ru_search_evidence-${idx + 1}`,
        template: "orion_evidence_explanation",
        title: idx === 0 ? "Пояснение ключевых результатов поиска" : "Результаты поиска (продолжение)",
        narrative: narrative.whyItMatters,
        bullets: chunk,
        evidenceRefs: topSearch.slice(idx * 4, idx * 4 + 4).map((e) => e.evidenceRef),
      });
    }
  }

  const imageAsset = assets.find((a) => a.assetRef === "ru_image_grid" && a.status === "ready");
  if (imageAsset) {
    slides.push({
      slideKey: "ru_search_images",
      template: "orion_serp_screenshot",
      title: imageAsset.title,
      assetRefs: [imageAsset.assetRef],
      evidenceRefs: imageAsset.evidenceRefs,
    });
  }

  const videoAsset = assets.find((a) => a.assetRef === "ru_video_cards" && a.status === "ready");
  if (videoAsset) {
    slides.push({
      slideKey: "ru_search_videos",
      template: "orion_serp_screenshot",
      title: videoAsset.title,
      assetRefs: [videoAsset.assetRef],
      evidenceRefs: videoAsset.evidenceRefs,
    });
  }

  const knowledgeAsset = assets.find((a) => a.assetRef === "ru_knowledge_panel" && a.status === "ready");
  if (knowledgeAsset) {
    slides.push({
      slideKey: "ru_search_knowledge",
      template: "orion_serp_screenshot",
      title: knowledgeAsset.title,
      assetRefs: [knowledgeAsset.assetRef],
      evidenceRefs: knowledgeAsset.evidenceRefs,
    });
  } else if (!evidence.some((e) => e.sourceKind === "knowledge_panel")) {
    // No fake card — note lives in narrative only (already in section text)
  }

  return slides;
}

export function applyComposedSlidesToSection(
  section: OrionReportSectionSpecV1,
  evidence: NormalizedEvidenceV1[],
  assets: ReportAssetV1[]
): OrionReportSectionSpecV1 {
  return {
    ...section,
    slides: composeTargetSectionSlides({
      sectionKey: section.sectionKey,
      section,
      evidence,
      assets,
    }),
  };
}
