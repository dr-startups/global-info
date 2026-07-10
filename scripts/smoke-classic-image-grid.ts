/**
 * Offline smoke: classic image-grid deck injection + risk red-frame classification.
 *
 * Run: npm run smoke:classic-image-grid
 */

import {
  isImageEvidenceHighlighted,
  isImageNamesakeNoise,
  type ReportAssetV1,
} from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import { buildImageGridSvg, type ImageGridItem } from "../src/modules/digital-profile/orion-report-spec/media-asset-svg";
import type { NormalizedEvidenceV1 } from "../src/modules/digital-profile/orion-report-spec/normalized-evidence";
import { composeOrionClassicAuditDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

const FAKE_IMAGE_DATA = "A".repeat(900);
const SUBJECT = "Глинка Сергей Михайлович";

function baseEv(partial: Partial<NormalizedEvidenceV1>): NormalizedEvidenceV1 {
  return {
    evidenceRef: "e1",
    sectionKey: "ru_search_results",
    sourceKind: "image_result",
    provider: "google",
    title: "photo",
    ...partial,
  };
}

function minimalSpec(): OrionClassicAuditReportSpec {
  return {
    version: "r10-classic-orion-audit-report-spec-v1",
    subject: {
      displayName: SUBJECT,
      reportTitle: "Аудит",
      asOfDate: "2026-07-10",
    },
    globalToc: [{ title: "Резюме", sectionId: "01_executive_summary" }],
    registrySections: [
      {
        sectionId: "10_ru_audit_summary",
        order: 10,
        block: {
          sectionKey: "10_ru_audit_summary",
          slideSpecs: [
            {
              slideKey: "ru-sum",
              template: "orion_golden_prose",
              title: "Россия — резюме",
              narrative: "Тест",
            },
          ],
        },
      },
      {
        sectionId: "12_ru_serp_position_table",
        order: 12,
        block: {
          sectionKey: "12_ru_serp_position_table",
          slideSpecs: [
            {
              slideKey: "ru-serp-table",
              template: "orion_golden_search_table",
              title: "Позиции SERP",
              bullets: ["#1 example"],
            },
          ],
        },
      },
    ],
    offer: { sectionKey: "offer", slideSpecs: [{ slideKey: "offer", template: "orion_golden_prose", title: "Оффер" }] },
    productOverview: {
      sectionKey: "productOverview",
      slideSpecs: [{ slideKey: "po", template: "orion_golden_prose", title: "Продукт" }],
    },
    solutionDigitalProfile: {
      sectionKey: "solutionDigitalProfile",
      slideSpecs: [{ slideKey: "sdp", template: "orion_golden_prose", title: "ЦП" }],
    },
    solutionComplianceDatabases: {
      sectionKey: "solutionComplianceDatabases",
      slideSpecs: [{ slideKey: "scd", template: "orion_golden_prose", title: "БД" }],
    },
    solutionWikipedia: {
      sectionKey: "solutionWikipedia",
      slideSpecs: [{ slideKey: "sw", template: "orion_golden_prose", title: "Wiki" }],
    },
    about: { sectionKey: "about", slideSpecs: [{ slideKey: "about", template: "orion_golden_prose", title: "О нас" }] },
  } as OrionClassicAuditReportSpec;
}

function main() {
  console.log("Smoke: classic image-grid injection + risk highlight\n");

  check(
    "rucriminal image: highlighted",
    isImageEvidenceHighlighted(
      baseEv({
        title: "Glinka dossier",
        domain: "rucriminal.info",
        displayUrl: "https://rucriminal.info/photo/1",
        riskTheme: "adverse_media",
      })
    )
  );
  check(
    "forbes soft bio image: not highlighted",
    !isImageEvidenceHighlighted(
      baseEv({
        title: "Сергей Глинка",
        domain: "forbes.ru",
        displayUrl: "https://www.forbes.ru/profile/glinka",
        riskTheme: "neutral_profile",
      })
    )
  );
  check(
    "acompromat image: highlighted by domain",
    isImageEvidenceHighlighted(
      baseEv({
        title: "Биография",
        domain: "acompromat.net",
        displayUrl: "https://acompromat.net/persons/glinka",
      })
    )
  );
  check(
    "vlasti.io sanctioned caption: highlighted even if neutral_profile",
    isImageEvidenceHighlighted(
      baseEv({
        title: "Sergey Glinka, a previous associate of sanctioned oligarchs",
        domain: "vlasti.io",
        displayUrl: "https://vlasti.io/glinka",
        riskTheme: "neutral_profile",
      })
    )
  );
  check(
    "vlasti.io domain alone: highlighted",
    isImageEvidenceHighlighted(
      baseEv({
        title: "Sergey Glinka photo",
        domain: "vlasti.io",
        riskTheme: "neutral_profile",
      })
    )
  );
  check(
    "Glinka choir youtube: namesake noise",
    isImageNamesakeNoise(
      baseEv({
        title: "Glinka Choir of Leningrad ~ Russia Sings - 1991",
        domain: "youtube.com",
      }),
      SUBJECT
    )
  );
  check(
    "Lyapunov piano amazon: namesake noise",
    isImageNamesakeNoise(
      baseEv({
        title: "Piano Concertos Nos. 1 and 2 - Lyapunov",
        domain: "amazon.de",
      }),
      SUBJECT
    )
  );
  check(
    "Sergei Glinka Nutriband: not namesake noise",
    !isImageNamesakeNoise(
      baseEv({
        title: "Sergei Glinka | Nutriband",
        domain: "nutriband.com",
      }),
      SUBJECT
    )
  );

  const items: ImageGridItem[] = [
    { title: "ok", domain: "forbes.ru", highlight: false },
    { title: "bad", domain: "rucriminal.info", highlight: true, themeLabel: "Криминал" },
  ];
  const svg = buildImageGridSvg({ title: "Изображения", items });
  check("svg contains red highlight stroke", /#d1342f/i.test(svg) || /stroke-width="4"/.test(svg));
  check("svg contains highlight badge text", /Криминал/.test(svg));

  const assets: ReportAssetV1[] = [
    {
      assetRef: "ru_provider_serp_synserp_test",
      kind: "synthetic_serp",
      title: "Яндекс — Глинка",
      caption: "Синтетический снимок на основе сохранённых результатов API",
      imageData: FAKE_IMAGE_DATA,
      evidenceRefs: ["serp_observation:1"],
      status: "ready",
    },
    {
      assetRef: "ru_image_grid",
      kind: "image_grid",
      title: "Изображения в поиске",
      caption: "Нежелательные изображения отмечены красной рамкой (1)",
      imageData: FAKE_IMAGE_DATA,
      evidenceRefs: ["img-1"],
      status: "ready",
    },
    {
      assetRef: "r10-img-1",
      kind: "image_grid",
      title: "URL-only placeholder",
      imageUrl: "https://example.com/a.jpg",
      evidenceRefs: [],
      status: "ready",
    },
    {
      assetRef: "ru_video_cards",
      kind: "video_cards",
      title: "Видео",
      caption: "Сводка видео",
      imageData: FAKE_IMAGE_DATA,
      evidenceRefs: ["vid-1"],
      status: "ready",
    },
    {
      assetRef: "r10-vid-1",
      kind: "video_cards",
      title: "URL-only video",
      imageUrl: "https://example.com/v.mp4",
      evidenceRefs: [],
      status: "ready",
    },
    {
      assetRef: "ru_knowledge_panel",
      kind: "knowledge_panel",
      title: "Панель знаний",
      imageData: FAKE_IMAGE_DATA,
      evidenceRefs: ["kp-1"],
      status: "ready",
    },
  ];

  const deck = composeOrionClassicAuditDeck(minimalSpec(), assets);
  const imageSlides = deck.finalSlides.filter((s) => s.template === "orion_golden_image_grid");
  check("deck includes image-grid slide", imageSlides.length >= 1, `count=${imageSlides.length}`);
  check(
    "image slide refs composite ru_image_grid",
    imageSlides.some((s) => (s.assetRefs ?? []).includes("ru_image_grid"))
  );
  check(
    "image slide does not use URL-only r10-img",
    !imageSlides.some((s) => (s.assetRefs ?? []).some((r) => r.startsWith("r10-img")))
  );
  const videoSlides = deck.finalSlides.filter((s) => s.template === "orion_golden_video_cards");
  check("deck includes video slide from composite", videoSlides.length === 1, `count=${videoSlides.length}`);
  check(
    "video slide does not use URL-only r10-vid",
    !videoSlides.some((s) => (s.assetRefs ?? []).some((r) => r.startsWith("r10-vid")))
  );
  const kpSlides = deck.finalSlides.filter((s) => s.template === "orion_golden_knowledge_panel");
  check("deck includes knowledge panel slide", kpSlides.length === 1, `count=${kpSlides.length}`);
  const serpIdx = deck.finalSlides.findIndex((s) => s.template === "orion_golden_serp_screenshot");
  const imgIdx = deck.finalSlides.findIndex((s) => s.template === "orion_golden_image_grid");
  check(
    "image slide follows RU SERP when both present",
    serpIdx >= 0 && imgIdx > serpIdx,
    `serp=${serpIdx} img=${imgIdx}`
  );

  const first36Deck = composeOrionClassicAuditDeck(minimalSpec(), assets, { includeCommercial: false });
  const hasCommercial = first36Deck.finalSlides.some((s) =>
    ["offer", "product_overview", "solution_digital_profile", "about"].includes(s.sectionKey)
  );
  check("first36 omits commercial pack", !hasCommercial);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main();
