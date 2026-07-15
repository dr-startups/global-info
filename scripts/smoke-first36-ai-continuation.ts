import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
};

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

function longAnswer(seed: string): string {
  return Array.from({ length: 36 }, (_, i) =>
    `${seed} Параграф ${i + 1}. Содержит длинное предложение для пагинации и не обрывается посередине.`
  ).join(" ");
}

function aiAsset(assetRef: string, title: string, engine: "YANDEX" | "GOOGLE", region: "RU" | "UAE", answer: string, absent = false): ReportAssetV1 {
  return {
    assetRef,
    kind: "surface_panel",
    status: "ready",
    title,
    caption: absent ? "AI-блок не найден" : "AI-блок найден",
    imageData: "A".repeat(4096),
    evidenceRefs: Array.from({ length: 12 }, (_, i) => `serp_observation:${i + 1}`),
    meta: {
      surface: "ai_answer",
      engine,
      region,
      query: region === "RU" ? "Глинка Сергей Михайлович" : "Sergey Glinka",
      capturedAt: "2026-07-15T10:00:00Z",
      answerText: answer,
      citations: Array.from({ length: 8 }, (_, i) => ({
        domain: `source${i + 1}.org`,
        title: `Источник ${i + 1}`,
        url: `https://source${i + 1}.org`,
      })),
    },
  };
}

const deck = composeOrionFirst36CeoDeck(minimalSpec(), [
  aiAsset("ru_ai_yandex", "Россия — AI-выдача Яндекса", "YANDEX", "RU", "Нейтральный ответ."),
  aiAsset("ru_ai_google", "Россия — Google AI Overview", "GOOGLE", "RU", longAnswer("Google AI")),
  aiAsset("uae_ai_google", "ОАЭ — Google AI Overview", "GOOGLE", "UAE", "", true),
]);

const aiSlides = deck.finalSlides.filter((s) => s.extensionSurface === "ai_answer");
const cont = aiSlides.filter((s) => s.isContinuation);
check("baseSlotCoverage=36", deck.baseSlotCoverage === 36);
check("at least one AI continuation exists", cont.length >= 1, `cont=${cont.length}`);
check("totalSlideCount >= 40", (deck.totalSlideCount ?? 0) >= 40, `slides=${deck.totalSlideCount}`);
check(
  "continuation points to AI extension parent",
  cont.every((s) => Boolean(s.continuationOf) && aiSlides.some((x) => x.slideKey === s.continuationOf))
);
check(
  "AI continuation keeps dataset/displayed counters",
  aiSlides.every((s) => (s.datasetCount ?? 0) >= (s.displayedCount ?? 0))
);

if (failures > 0) process.exitCode = 1;
console.log(failures ? `FAILED ${failures}` : "ALL PASS");
