/**
 * Dynamic image pagination: 14 highlighted frames => continuation slides.
 */

import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function minimalSpec(): OrionClassicAuditReportSpec {
  return {
    version: "r10-classic-orion-audit-report-spec-v1",
    subject: { displayName: "Тест", reportTitle: "Аудит", asOfDate: "2026-07-15" },
    globalToc: [{ title: "Резюме", sectionId: "01_executive_summary" }],
    registrySections: [],
    offer: { sectionKey: "offer", slideSpecs: [{ slideKey: "o", template: "orion_golden_prose", title: "Оффер" }] },
    productOverview: { sectionKey: "po", slideSpecs: [{ slideKey: "p", template: "orion_golden_prose", title: "Продукт" }] },
    solutionDigitalProfile: { sectionKey: "sdp", slideSpecs: [{ slideKey: "s", template: "orion_golden_prose", title: "ЦП" }] },
    solutionComplianceDatabases: { sectionKey: "scd", slideSpecs: [{ slideKey: "c", template: "orion_golden_prose", title: "БД" }] },
    solutionWikipedia: { sectionKey: "sw", slideSpecs: [{ slideKey: "w", template: "orion_golden_prose", title: "Wiki" }] },
    about: { sectionKey: "about", slideSpecs: [{ slideKey: "a", template: "orion_golden_prose", title: "О нас" }] },
  } as OrionClassicAuditReportSpec;
}

function imageAsset14(): ReportAssetV1 {
  return {
    assetRef: "ru_image_grid",
    kind: "image_grid",
    status: "ready",
    title: "Россия — изображения",
    caption: "Сводка изображений",
    imageData: "A".repeat(2000),
    evidenceRefs: Array.from({ length: 14 }, (_, i) => `img:${i + 1}`),
    highlightExplanations: Array.from({ length: 14 }, (_, i) => ({
      frameIndex: i + 1,
      frameTone: i % 3 === 0 ? "red" : "amber",
      clientReason: `Изображение ${i + 1}: требует проверки`,
    })),
  };
}

function main() {
  const deck = composeOrionFirst36CeoDeck(minimalSpec(), [imageAsset14()]);
  const ruImagePages = deck.finalSlides.filter(
    (s) => s.baseSlotId === "p14_ru_images_1" || s.continuationOf === "p14_ru_images_1"
  );
  const cont = ruImagePages.filter((s) => s.isContinuation);
  check("image slot creates continuation for 14 highlights", cont.length > 0, `cont=${cont.length}`);

  const totalDisplayed = ruImagePages.reduce((acc, s) => acc + (s.imageCounters?.pageDisplayedCount ?? 0), 0);
  const totalDataset = ruImagePages[0]?.imageCounters?.datasetCount ?? 0;
  check("image datasetCount reconciles across continuations", totalDisplayed === totalDataset, `${totalDisplayed}/${totalDataset}`);
  check("image datasetCount is 14", totalDataset === 14, `=${totalDataset}`);

  const adjacent = cont.every((s) => {
    const idx = deck.finalSlides.findIndex((x) => x.slideKey === s.slideKey);
    const prev = deck.finalSlides[idx - 1];
    return prev && (prev.slideKey === s.continuationOf || prev.continuationOf === s.continuationOf);
  });
  check("image continuation is adjacent", adjacent);

  if (failures > 0) process.exitCode = 1;
  console.log(failures ? `FAILED ${failures}` : "ALL PASS");
}

main();

