/**
 * Offline smoke: classic report-spec + deck composition (no PDF render).
 */
import { sanitizeOrionGoldenClientText } from "../src/modules/digital-profile/orion-golden/client/client-text-sanitizer";
import { buildOrionClassicCommercialPack } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-commercial-pack";
import { composeOrionClassicAuditDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-deck-composer";
import { buildOrionClassicReportSpecFromClientContent } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { FullEvidenceInventory } from "../src/modules/digital-profile/orion-golden/evidence/full-evidence-inventory";
import type { OrionClientContent } from "../src/modules/digital-profile/orion-golden/content/orion-client-content-builder";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const sanitizerCases = [
  ["compliance-рисков", "комплаенс-рисков"],
  ["compliance-выводы", "комплаенс-выводы"],
  ["Матрица compliance-рисков", "Матрица комплаенс-рисков"],
];
for (const [input, expect] of sanitizerCases) {
  const out = sanitizeOrionGoldenClientText(input);
  assert(!/Комплаенс-проверка-/.test(out), `broken sanitizer for ${input} -> ${out}`);
  assert(out.toLowerCase().includes(expect.toLowerCase().slice(0, 12)), `expected compound in ${out}`);
}

const commercial = buildOrionClassicCommercialPack();
const commercialSlideCount =
  commercial.offer.slideSpecs.length +
  commercial.productOverview.slideSpecs.length +
  commercial.solutionDigitalProfile.slideSpecs.length +
  commercial.solutionComplianceDatabases.slideSpecs.length +
  commercial.solutionWikipedia.slideSpecs.length +
  commercial.about.slideSpecs.length;
assert(commercialSlideCount <= 12, `commercial too fat: ${commercialSlideCount}`);
assert(commercial.offer.slideSpecs[0].bullets.length >= 2, "offer should be dense");

const inventory: FullEvidenceInventory = {
  version: "r10-full-evidence-inventory-v1",
  caseId: "smoke-case",
  reportRunId: "smoke-run",
  inspectedAt: new Date().toISOString(),
  subject: { fullName: "Дерипаска Олег Владимирович", aliases: ["Oleg Deripaska"] },
  counts: {
    searchResults: 6,
    searchSurfaces: 8,
    databaseProfiles: 2,
    riskFindings: 2,
    wikiChecks: 1,
    screenshots: 0,
  },
  countsBySource: {},
  countsByRegion: { RU: 4, UAE: 2 },
  countsByEvidenceType: {},
  mediaAvailability: {
    images: 0,
    videos: 0,
    knowledgePanels: 0,
    serpScreenshots: 0,
    suggestions: 4,
    relatedQueries: 2,
    manualNotes: 0,
    organicResults: 6,
  },
  lexisNexis: {
    uploadExists: false,
    latestReady: false,
    visualPageCount: 0,
    parsedSignals: 0,
    status: "missing",
  },
  missingSources: [],
  warnings: [],
  items: [
    {
      inventoryId: "sr-1",
      caseId: "smoke-case",
      reportRunId: "smoke-run",
      source: "search_result",
      provider: "GOOGLE",
      region: "RU",
      query: "Дерипаска",
      collectedAt: new Date().toISOString(),
      evidenceType: "search_result",
      title: "Олег Дерипаска — санкции США",
      snippet: "санкционный профиль",
      sourceUrl: "https://forbes.ru/deripaska-sanctions",
      classification: "adverse_media",
      rawMetadata: { position: 1, themeLabel: "Санкции", riskTheme: "sanctions" },
    },
    {
      inventoryId: "sr-2",
      caseId: "smoke-case",
      reportRunId: "smoke-run",
      source: "search_result",
      provider: "YANDEX",
      region: "RU",
      query: "Дерипаска",
      collectedAt: new Date().toISOString(),
      evidenceType: "search_result",
      title: "Rusal и Дерипаска",
      snippet: "бизнес",
      sourceUrl: "https://tadviser.ru/rusal",
      classification: "corporate",
      rawMetadata: { position: 2 },
    },
    {
      inventoryId: "sr-3",
      caseId: "smoke-case",
      reportRunId: "smoke-run",
      source: "search_result",
      provider: "GOOGLE",
      region: "UAE",
      query: "Oleg Deripaska Dubai",
      collectedAt: new Date().toISOString(),
      evidenceType: "search_result",
      title: "Deripaska in Dubai",
      snippet: "residence",
      sourceUrl: "https://example.ae/deripaska",
      classification: "identity",
      rawMetadata: { position: 1 },
    },
    {
      inventoryId: "ss-1",
      caseId: "smoke-case",
      reportRunId: "smoke-run",
      source: "search_surface",
      provider: "GOOGLE",
      region: "RU",
      query: "дерипаска санкции",
      collectedAt: new Date().toISOString(),
      evidenceType: "suggestion",
      title: "дерипаска санкции",
    },
    {
      inventoryId: "ss-2",
      caseId: "smoke-case",
      reportRunId: "smoke-run",
      source: "search_surface",
      provider: "GOOGLE",
      region: "UAE",
      query: "oleg deripaska dubai",
      collectedAt: new Date().toISOString(),
      evidenceType: "suggestion",
      title: "oleg deripaska dubai",
    },
    {
      inventoryId: "ss-3",
      caseId: "smoke-case",
      reportRunId: "smoke-run",
      source: "search_surface",
      provider: "GOOGLE",
      region: "RU",
      query: "deripaska oleg vladimirovich autocomplete lyrics",
      collectedAt: new Date().toISOString(),
      evidenceType: "suggestion",
      title: "deripaska oleg vladimirovich autocomplete lyrics",
    },
    {
      inventoryId: "rf-1",
      caseId: "smoke-case",
      reportRunId: "smoke-run",
      source: "risk_finding",
      provider: "INTERNAL",
      region: "GLOBAL",
      collectedAt: new Date().toISOString(),
      evidenceType: "risk_finding",
      title: "Санкционный риск",
      snippet: "OFAC",
      classification: "sanctions",
    },
    {
      inventoryId: "wiki-1",
      caseId: "smoke-case",
      reportRunId: "smoke-run",
      source: "wikipedia",
      provider: "WIKIPEDIA",
      region: "RU",
      collectedAt: new Date().toISOString(),
      evidenceType: "wikipedia",
      title: "Дерипаска, Олег Владимирович",
      snippet: "Страница найдена",
      sourceUrl: "https://ru.wikipedia.org/wiki/Дерипаска",
    },
  ],
};

const client: OrionClientContent = {
  version: "r10-6-orion-client-content-v1",
  mode: "post_review",
  generatedAt: new Date().toISOString(),
  caseId: "smoke-case",
  reportRunId: "smoke-run",
  subject: { displayName: "Дерипаска Олег Владимирович", aliases: ["Oleg Deripaska"] },
  executiveSummaryDraft:
    "Проверка ORION по субъекту «Дерипаска Олег Владимирович» (после применения решений аналитика (artifact-backed)). В ключевые выводы включено 2 материал(ов).",
  approvedFindings: [
    {
      title: "Санкции",
      summary: "Упоминания санкционного статуса в открытых источниках.",
      evidenceRefs: ["sr-1"],
    },
  ],
  appendixFindings: [],
  manualReviewSection: {
    title: "MR",
    intro: "intro",
    items: [],
  },
  limitations: ["smoke"],
  recommendations: ["Проверить первоисточники по санкциям."],
};

const spec = buildOrionClassicReportSpecFromClientContent({
  clientContent: client,
  inventory,
  assets: [],
});
const deck = composeOrionClassicAuditDeck(spec, []);

const titles = deck.finalSlides.map((s) => s.title);
const joined = deck.finalSlides.flatMap((s) => [s.title, s.narrative ?? "", ...(s.bullets ?? [])]).join("\n");

assert(!/Комплаенс-проверка-риск/i.test(joined), "broken compliance phrase in deck");
assert(/forbes\.ru|tadviser|wikipedia/i.test(joined), "expected concrete URLs/domains");
assert(/Санкц/i.test(joined), "expected sanctions theme");
assert(
  titles.some((t) => /позиции|SERP|ссылк/i.test(t)),
  `missing SERP/search slides: ${titles.slice(0, 20).join(" | ")}`
);

const ruSug = deck.finalSlides.filter((s) => /Россия — подсказки/i.test(s.title));
const uaeSug = deck.finalSlides.filter((s) => /ОАЭ — подсказки/i.test(s.title));
if (ruSug.length && uaeSug.length) {
  const ruText = (ruSug[0].bullets ?? []).join("|");
  const uaeText = (uaeSug[0].bullets ?? []).join("|");
  assert(ruText !== uaeText, "RU and UAE suggestions must differ");
}
assert(!/autocomplete lyrics/i.test(joined), "noise suggestion leaked");

const commercialInDeck = deck.finalSlides.filter((s) =>
  ["offer", "product_overview", "solution_digital_profile", "solution_compliance_databases", "solution_wikipedia", "about"].includes(
    s.sectionKey
  )
).length;
assert(commercialInDeck / deck.slideCount <= 0.35, `commercial ratio too high: ${commercialInDeck}/${deck.slideCount}`);
assert(!/материал\(ов\) остаются на ручной/i.test(spec.executiveSummary.executiveSummary), "resume still meta-only");

console.log(
  JSON.stringify(
    {
      ok: true,
      slideCount: deck.slideCount,
      commercialInDeck,
      registrySections: spec.registrySections.map((s) => s.sectionId),
      sampleTitles: titles.slice(0, 25),
    },
    null,
    2
  )
);
