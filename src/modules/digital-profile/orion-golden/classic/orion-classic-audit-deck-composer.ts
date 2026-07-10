/**
 * R10.11 — Classic ORION audit deck composer (registry 1:1 + full commercial, no R10.9a caps).
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";
import type { OrionGoldenDeckManifest, OrionGoldenDeckSlide } from "../composer/orion-deck-composer";
import { scrubClientFacingProse, truncateAtWordBoundary, isEnglishAnalystDump } from "./orion-classic-text-utils";
import type { OrionClassicAuditReportSpec } from "./orion-classic-client-content-to-report-spec";
import {
  assetSectionKeyForRegistry,
  regionDividerTitle,
} from "./orion-classic-section-template-map";

function slidesFromBlock(
  sectionKey: string,
  block: OrionClassicAuditReportSpec["registrySections"][number]["block"]
): OrionGoldenDeckSlide[] {
  const specs = block.slideSpecs ?? [];
  const isExecutive = sectionKey === "01_executive_summary" || /executive/i.test(sectionKey);
  const isProseHeavy =
    isExecutive ||
    /risk_matrix|audit_summary|compliance|dow_jones|world_check|lexis|undesirable_theme|digital_profile_overview|recommendations/i.test(
      sectionKey
    );
  const narrativeMax = isExecutive ? 2200 : isProseHeavy ? 900 : 520;
  const bulletMax = isExecutive || isProseHeavy ? 360 : 220;
  return specs.map((spec, idx) => {
    const perSlideNarrative =
      typeof spec.narrative === "string" ? spec.narrative : idx === 0 ? block.narrative : undefined;
    return {
      slideKey: spec.slideKey,
      sectionKey,
      template: spec.template,
      title: spec.title,
      pageNumber: 0,
      bullets: spec.bullets?.map((b) => truncateAtWordBoundary(b, bulletMax)),
      // Per-slide narrative when provided; else first-slide block narrative only.
      narrative: perSlideNarrative ? truncateAtWordBoundary(perSlideNarrative, narrativeMax) : undefined,
      assetRefs: idx === 0 ? block.visualAssets : undefined,
    };
  });
}

function serpDedupeQueryKey(asset: ReportAssetV1): string {
  // Provider API assets share one caption — identity must come from title/query, not caption.
  const useTitle = isProviderApiAsset(asset);
  const raw = useTitle ? (asset.title ?? "") : (asset.caption ?? asset.title ?? "");
  return raw
    .toLowerCase()
    .replace(/^запрос:\s*/i, "")
    .replace(/^(яндекс|google)\s*[—-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeSerpAssetList(assets: ReportAssetV1[], max: number): ReportAssetV1[] {
  const seen = new Set<string>();
  const out: ReportAssetV1[] = [];
  for (const asset of assets) {
    const provider = /yandex|яндекс/i.test(`${asset.assetRef} ${asset.title}`) ? "yandex" : "google";
    const q = serpDedupeQueryKey(asset);
    const key = `${provider}::${q || asset.assetRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
    if (out.length >= max) break;
  }
  return out;
}

function isProviderApiAsset(asset: ReportAssetV1): boolean {
  return (
    asset.kind === "synthetic_serp" &&
    (asset.evidenceRefs.some((r) => r.startsWith("serp_observation:")) ||
      /provider_serp|serper_organic/i.test(asset.assetRef) ||
      asset.caption === "Синтетический снимок на основе сохранённых результатов API")
  );
}

function hasSerpImageContent(asset: ReportAssetV1): boolean {
  const data = String(asset.imageData ?? "").trim();
  if (data.length >= 800) return true;
  return Boolean(String(asset.imageUrl ?? "").trim());
}

function preferSerpAssets(
  assets: ReportAssetV1[],
  region: "ru" | "uae",
  max: number
): ReportAssetV1[] {
  const inRegion = assets.filter((a) => {
    const uae = /uae|intl|ae_/i.test(a.assetRef);
    return region === "uae" ? uae : !uae;
  });
  const withImage = inRegion.filter(hasSerpImageContent);
  const provider = withImage.filter(isProviderApiAsset);
  const live = withImage.filter((a) => a.kind === "live_serp");
  const captured = withImage.filter((a) => a.kind === "captured_serp");
  const legacySynthetic = withImage.filter(
    (a) => a.kind === "synthetic_serp" && !isProviderApiAsset(a)
  );
  return dedupeSerpAssetList([...provider, ...live, ...captured, ...legacySynthetic], max);
}

function commercialSlides(
  sectionKey: string,
  block: OrionClassicAuditReportSpec["registrySections"][number]["block"]
): OrionGoldenDeckSlide[] {
  // Keep commercial as a thin trailer after the static audit block (~GSM first 36).
  return slidesFromBlock(sectionKey, block).slice(0, 1);
}

function assetSlides(
  sectionKey: string,
  template: string,
  titlePrefix: string,
  assets: ReportAssetV1[]
): OrionGoldenDeckSlide[] {
  return assets.map((asset, idx) => ({
    slideKey: `${sectionKey}-${asset.assetRef}`,
    sectionKey,
    template,
    title: asset.title || `${titlePrefix} ${idx + 1}`,
    pageNumber: 0,
    bullets: asset.caption ? [truncateAtWordBoundary(asset.caption, 180)] : undefined,
    assetRefs: [asset.assetRef],
  }));
}

function chunkAssetSlides(
  sectionKey: string,
  template: string,
  title: string,
  assets: ReportAssetV1[],
  perSlide: number
): OrionGoldenDeckSlide[] {
  const slides: OrionGoldenDeckSlide[] = [];
  for (let i = 0; i < assets.length; i += perSlide) {
    const chunk = assets.slice(i, i + perSlide);
    slides.push({
      slideKey: `${sectionKey}-grid-${Math.floor(i / perSlide) + 1}`,
      sectionKey,
      template,
      title: `${title} (${Math.floor(i / perSlide) + 1})`,
      pageNumber: 0,
      assetRefs: chunk.map((a) => a.assetRef),
    });
  }
  return slides;
}

function sanitizeSlide(slide: OrionGoldenDeckSlide): OrionGoldenDeckSlide {
  const scrub = (s: string) => scrubClientFacingProse(sanitizeOrionGoldenClientText(s));
  return {
    ...slide,
    title: scrub(slide.title),
    narrative: slide.narrative ? scrub(slide.narrative) : undefined,
    bullets: slide.bullets
      ?.map((b) => scrub(b))
      .filter((b) => Boolean(b) && !/\[object Object\]/i.test(b))
      .filter((b) => !isEnglishAnalystDump(b))
      .filter(
        (b) =>
          !/\.example(\/|$|\s)|example\.com|\[DEMO\]|Demo DOW JONES|Demo WORLD CHECK|Demo LEXIS|potential match only|демо[- ]?скрининг|демонстрационн|DATA\s*POOR|match score|requires analyst review|Sergey Mikhaylovich Kozlov|Козлов|No authoritative Wikipedia|Possible criminal-allegation|Negative search suggestion/i.test(
            b
          )
      ),
  };
}

function hasRealLexisPageContent(asset: ReportAssetV1): boolean {
  const data = String(asset.imageData ?? "").trim();
  // Tiny / placeholder payloads produce blank visual pages in the deck.
  if (data.length < 800) return false;
  const blob = `${asset.title} ${asset.caption ?? ""} ${asset.assetRef}`;
  if (/demo|placeholder|empty|blank/i.test(blob)) return false;
  return true;
}

function pickAssets(assets: ReportAssetV1[], kind: ReportAssetV1["kind"], refPrefix?: string): ReportAssetV1[] {
  return assets.filter(
    (a) =>
      a.kind === kind &&
      a.status === "ready" &&
      (!refPrefix || a.assetRef.startsWith(refPrefix)) &&
      (kind !== "lexis_visual_page" || hasRealLexisPageContent(a)) &&
      (kind !== "live_serp" && kind !== "captured_serp" && kind !== "synthetic_serp"
        ? true
        : hasSerpImageContent(a))
  );
}

export function composeOrionClassicAuditDeck(
  reportSpec: OrionClassicAuditReportSpec,
  assets: ReportAssetV1[] = []
): OrionGoldenDeckManifest {
  const serpAssets = [
    ...pickAssets(assets, "live_serp"),
    ...pickAssets(assets, "captured_serp"),
    ...pickAssets(assets, "synthetic_serp"),
  ];
  const lexisAssets = pickAssets(assets, "lexis_visual_page");
  const imageAssets = pickAssets(assets, "image_grid");
  const videoAssets = pickAssets(assets, "video_cards");
  const knowledgeAssets = pickAssets(assets, "knowledge_panel");

  // Provider API synthetic first, then LIVE, captured, legacy synthetic.
  // Never invent a text-only substitute when assets are empty (section omitted;
  // render pipeline must gate/block client reports separately).
  const ruSerp = preferSerpAssets(serpAssets, "ru", 3);
  const uaeSerp = preferSerpAssets(serpAssets, "uae", 2);
  const uaeImages = imageAssets.filter((a) => /uae|intl/i.test(a.assetRef));
  const ruImages = imageAssets.filter((a) => !uaeImages.includes(a));
  const uaeVideos = videoAssets.filter((a) => /uae|intl/i.test(a.assetRef));
  const ruVideos = videoAssets.filter((a) => !uaeVideos.includes(a));
  const uaeKnowledge = knowledgeAssets.filter((a) => /uae|intl/i.test(a.assetRef));
  const ruKnowledge = knowledgeAssets.filter((a) => !uaeKnowledge.includes(a));

  const insertedAssetSections = new Set<string>();
  const sections: Array<{ sectionKey: string; slides: OrionGoldenDeckSlide[] }> = [
    {
      sectionKey: "cover",
      slides: [
        {
          slideKey: "cover",
          sectionKey: "cover",
          template: "orion_golden_cover",
          title: reportSpec.subject.reportTitle,
          pageNumber: 0,
          narrative: reportSpec.subject.displayName,
        },
      ],
    },
    {
      sectionKey: "global_toc",
      slides: [
        {
          slideKey: "toc-1",
          sectionKey: "global_toc",
          template: "orion_golden_toc",
          title: "Содержание",
          pageNumber: 0,
          bullets: reportSpec.globalToc.map((t) => t.title).slice(0, 20),
        },
      ],
    },
  ];

  for (const entry of reportSpec.registrySections.sort((a, b) => a.order - b.order)) {
    const divider = regionDividerTitle(entry.sectionId);
    if (divider) {
      sections.push({
        sectionKey: entry.sectionId === "10_ru_audit_summary" ? "ru_digital_profile" : "uae_digital_profile",
        slides: [
          {
            slideKey: `divider-${entry.sectionId}`,
            sectionKey: entry.sectionId === "10_ru_audit_summary" ? "ru_digital_profile" : "uae_digital_profile",
            template: "orion_golden_region_divider",
            title: divider,
            pageNumber: 0,
          },
        ],
      });
    }

    const blockSlides = slidesFromBlock(entry.sectionId, entry.block);
    if (blockSlides.length > 0) {
      sections.push({ sectionKey: entry.sectionId, slides: blockSlides });
    }

    const assetKey = assetSectionKeyForRegistry(entry.sectionId);
    if (assetKey && !insertedAssetSections.has(assetKey)) {
      insertedAssetSections.add(assetKey);
      if (assetKey === "ru_serp_screenshots" && ruSerp.length > 0) {
        sections.push({
          sectionKey: "ru_serp_screenshots",
          slides: assetSlides("ru_serp_screenshots", "orion_golden_serp_screenshot", "Снимок выдачи", ruSerp),
        });
      }
      if (assetKey === "uae_serp_screenshots" && uaeSerp.length > 0) {
        sections.push({
          sectionKey: "uae_serp_screenshots",
          slides: assetSlides("uae_serp_screenshots", "orion_golden_serp_screenshot", "Снимок выдачи", uaeSerp),
        });
      }
      if (assetKey === "ru_images" && ruImages.length > 0) {
        sections.push({
          sectionKey: "ru_images",
          slides: chunkAssetSlides("ru_images", "orion_golden_image_grid", "Изображения", ruImages, 6),
        });
      }
      if (assetKey === "uae_images" && uaeImages.length > 0) {
        sections.push({
          sectionKey: "uae_images",
          slides: chunkAssetSlides("uae_images", "orion_golden_image_grid", "Изображения", uaeImages, 6),
        });
      }
      if (assetKey === "ru_videos" && ruVideos.length > 0) {
        sections.push({
          sectionKey: "ru_videos",
          slides: chunkAssetSlides("ru_videos", "orion_golden_video_cards", "Видео", ruVideos, 4),
        });
      }
      if (assetKey === "uae_videos" && uaeVideos.length > 0) {
        sections.push({
          sectionKey: "uae_videos",
          slides: chunkAssetSlides("uae_videos", "orion_golden_video_cards", "Видео", uaeVideos, 4),
        });
      }
      if (assetKey === "ru_knowledge" && ruKnowledge.length > 0) {
        sections.push({
          sectionKey: "ru_knowledge",
          slides: assetSlides("ru_knowledge", "orion_golden_knowledge_panel", "Панель знаний", ruKnowledge),
        });
      }
      if (assetKey === "uae_knowledge" && uaeKnowledge.length > 0) {
        sections.push({
          sectionKey: "uae_knowledge",
          slides: assetSlides("uae_knowledge", "orion_golden_knowledge_panel", "Панель знаний", uaeKnowledge),
        });
      }
      if (assetKey === "lexisnexis_visual" && lexisAssets.length > 0) {
        // Cap Lexis visuals — ORION shows a few real pages, not a blank gallery.
        sections.push({
          sectionKey: "lexisnexis_visual",
          slides: assetSlides(
            "lexisnexis",
            "orion_golden_lexis_visual_page",
            "LexisNexis",
            lexisAssets.slice(0, 4)
          ),
        });
      }
    }
  }

  const commercialKeys: Array<keyof Pick<
    OrionClassicAuditReportSpec,
    | "offer"
    | "productOverview"
    | "solutionDigitalProfile"
    | "solutionComplianceDatabases"
    | "solutionWikipedia"
    | "about"
  >> = [
    "offer",
    "productOverview",
    "solutionDigitalProfile",
    "solutionComplianceDatabases",
    "solutionWikipedia",
    "about",
  ];

  for (const key of commercialKeys) {
    const block = reportSpec[key];
    const sectionKey = key === "solutionDigitalProfile"
      ? "solution_digital_profile"
      : key === "solutionComplianceDatabases"
        ? "solution_compliance_databases"
        : key === "solutionWikipedia"
          ? "solution_wikipedia"
          : key === "productOverview"
            ? "product_overview"
            : key;
    sections.push({
      sectionKey,
      slides: commercialSlides(sectionKey, block),
    });
  }

  let page = 1;
  const sectionManifests: OrionGoldenDeckManifest["sectionManifests"] = [];
  const finalSlides: OrionGoldenDeckSlide[] = [];

  for (const section of sections) {
    const slides = section.slides.filter(
      (s) => s.title || s.narrative || (s.bullets?.length ?? 0) > 0 || (s.assetRefs?.length ?? 0) > 0
    );
    if (slides.length === 0) continue;
    for (const s of slides) s.pageNumber = page++;
    sectionManifests.push({ sectionKey: section.sectionKey, slideCount: slides.length, slides });
    finalSlides.push(...slides.map(sanitizeSlide));
  }

  const toc = finalSlides
    .filter((s) => s.sectionKey !== "cover")
    .filter((_, idx, arr) => idx === 0 || arr[idx - 1]?.sectionKey !== arr[idx].sectionKey)
    .slice(0, 40)
    .map((s) => ({ title: s.title, pageNumber: s.pageNumber }));

  const pageNumberMap: Record<string, number> = {};
  for (const s of finalSlides) pageNumberMap[s.slideKey] = s.pageNumber;

  return {
    version: "r10-orion-golden-deck-manifest-v1",
    slideCount: finalSlides.length,
    sectionManifests,
    finalSlides,
    toc,
    pageNumberMap,
  };
}
