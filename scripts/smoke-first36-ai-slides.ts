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

function aiAsset(assetRef: string, title: string, engine: "YANDEX" | "GOOGLE", region: "RU" | "UAE"): ReportAssetV1 {
  return {
    assetRef,
    kind: "surface_panel",
    status: "ready",
    title,
    caption: "AI-блок найден",
    imageData: "A".repeat(2048),
    evidenceRefs: ["serp_observation:1", "serp_observation:2"],
    meta: {
      surface: "ai_answer",
      engine,
      region,
      query: region === "RU" ? "Глинка Сергей Михайлович" : "Sergey Glinka",
      capturedAt: "2026-07-15T10:00:00Z",
      answerText: "Нейтральный ответ ИИ по субъекту.",
      citations: [
        { domain: "example.org", title: "Example", url: "https://example.org" },
        { domain: "forbes.ru", title: "Forbes", url: "https://forbes.ru/x" },
      ],
    },
  };
}

const deck = composeOrionFirst36CeoDeck(minimalSpec(), [
  aiAsset("ru_ai_yandex", "Россия — AI-выдача Яндекса", "YANDEX", "RU"),
  aiAsset("ru_ai_google", "Россия — Google AI Overview", "GOOGLE", "RU"),
  {
    ...aiAsset("uae_ai_google", "ОАЭ — Google AI Overview", "GOOGLE", "UAE"),
    caption: "AI-блок не найден",
  },
]);

const aiSlides = deck.finalSlides.filter((s) => s.extensionSurface === "ai_answer");
check("three AI extension slides exist", aiSlides.filter((s) => !s.isContinuation).length === 3);
check("baseSlotCoverage remains 36", deck.baseSlotCoverage === 36);
check("AI slides increase totalSlideCount", deck.totalSlideCount >= 39, `slides=${deck.totalSlideCount}`);
check(
  "AI slides are inserted after knowledge slots",
  aiSlides.some((s) => s.extensionOf === "p19_ru_knowledge_2") &&
    aiSlides.some((s) => s.extensionOf === "p31_uae_knowledge")
);
const ruAi = aiSlides.find((s) => s.extensionId === "ext_ru_yandex_ai" && !s.isContinuation);
check(
  "RU Yandex AI slide has visualAnalysis answer text",
  Boolean(ruAi?.visualAnalysis?.whatIsVisible?.includes("Нейтральный ответ"))
);
check(
  "RU Yandex AI slide clientTakeaway is not bare Вывод",
  Boolean(ruAi?.clientTakeaway && ruAi.clientTakeaway !== "Вывод")
);
check(
  "AI sectionKeys are distinct per engine",
  new Set(aiSlides.map((s) => s.sectionKey)).size >= 3
);
const toc = deck.finalSlides.find((s) => s.slideKey === "p02_toc");
check(
  "TOC does not claim AI spans into UAE pages",
  !(toc?.bullets ?? []).some((b) => /AI-выдача Яндекса — стр\.\s*20–3[0-9]/i.test(b))
);

if (failures > 0) process.exitCode = 1;
console.log(failures ? `FAILED ${failures}` : "ALL PASS");
