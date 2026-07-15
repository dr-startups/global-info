/**
 * Dynamic First36 pagination — end-to-end composer test (spec §2/§3/§6, tests J/K/L).
 * Feeds a 16-row RU + 12-row UAE dataset through the real composer and asserts
 * base-slot coverage stays 36, continuations are adjacent, counters reconcile,
 * and no rows are dropped. LIVE API NOT RUN, NETWORK_CALLS=0.
 */

import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

const LONG =
  "Очень длинный заголовок новостной публикации о субъекте проверки с уточняющими деталями и контекстом события";

function serpRows(count: number, query: string, adverseEvery: number): string[][] {
  return Array.from({ length: count }, (_, i) => [
    query,
    String(i + 1),
    `example${i}.ru`,
    `${LONG} #${i + 1}`,
    (i % adverseEvery === 0 ? "Н" : "·"),
  ]);
}

function specWith(ruRows: string[][], uaeRows: string[][]): OrionClassicAuditReportSpec {
  const serpBlock = (sectionId: string, key: string, rows: string[][]) => ({
    sectionId,
    order: Number(sectionId.slice(0, 2)),
    block: {
      sectionKey: key,
      slideSpecs: [
        {
          slideKey: `${key}-table`,
          template: "orion_golden_search_table",
          title: sectionId.includes("uae") ? "ОАЭ — позиции в поисковой выдаче" : "Россия — позиции в поисковой выдаче",
          narrative: "Таблица фиксирует сохранённые позиции поисковой выдачи по субъекту.",
          table: { headers: ["Запрос", "Позиция", "Домен", "Заголовок", "Статус"], rows },
        },
      ],
    },
  });
  return {
    version: "r10-classic-orion-audit-report-spec-v1",
    subject: { displayName: "Глинка Сергей Михайлович", reportTitle: "Аудит", asOfDate: "2026-07-10" },
    globalToc: [
      { title: "Резюме", sectionId: "01_executive_summary" },
      { title: "Россия", sectionId: "10_ru_audit_summary" },
      { title: "ОАЭ", sectionId: "30_uae_audit_summary" },
    ],
    registrySections: [
      serpBlock("12_ru_serp_position_table", "12_ru_serp_position_table", ruRows),
      serpBlock("32_uae_serp_position_table", "32_uae_serp_position_table", uaeRows),
    ],
    offer: { sectionKey: "offer", slideSpecs: [{ slideKey: "offer", template: "orion_golden_prose", title: "Оффер" }] },
    productOverview: { sectionKey: "productOverview", slideSpecs: [{ slideKey: "po", template: "orion_golden_prose", title: "Продукт" }] },
    solutionDigitalProfile: { sectionKey: "solutionDigitalProfile", slideSpecs: [{ slideKey: "sdp", template: "orion_golden_prose", title: "ЦП" }] },
    solutionComplianceDatabases: { sectionKey: "solutionComplianceDatabases", slideSpecs: [{ slideKey: "scd", template: "orion_golden_prose", title: "БД" }] },
    solutionWikipedia: { sectionKey: "solutionWikipedia", slideSpecs: [{ slideKey: "sw", template: "orion_golden_prose", title: "Wiki" }] },
    about: { sectionKey: "about", slideSpecs: [{ slideKey: "about", template: "orion_golden_prose", title: "О нас" }] },
  } as OrionClassicAuditReportSpec;
}

function main() {
  console.log("Smoke: dynamic First36 pagination\n");
  const assets: ReportAssetV1[] = [];

  const ru = serpRows(16, "Глинка Сергей Михайлович", 5);
  const uae = serpRows(12, "Sergey Glinka UAE", 4);
  const deck = composeOrionFirst36CeoDeck(specWith(ru, uae), assets);

  // K. Base slot coverage stays 36.
  check("K. baseSlotCoverage === 36", deck.baseSlotCoverage === 36, `=${deck.baseSlotCoverage}`);
  check("K. missingBaseSlots empty", (deck.missingBaseSlots?.length ?? 0) === 0);

  // Continuations pushed total past 36.
  check("totalSlideCount > 36 (continuations added)", (deck.totalSlideCount ?? 0) > 36, `=${deck.totalSlideCount}`);

  // J. Sequential page numbers 1..N and footer/TOC aware.
  const seq = deck.finalSlides.every((s, i) => s.pageNumber === i + 1);
  check("J. page numbers sequential 1..N", seq);
  check("J. every slide carries totalPageCount = N", deck.finalSlides.every((s) => s.totalPageCount === deck.finalSlides.length));
  check("J. TOC excludes continuation slides", deck.toc.every((t) => {
    const s = deck.finalSlides.find((x) => x.pageNumber === t.pageNumber);
    return s && s.isContinuation !== true;
  }));

  // RU search table: base + continuation adjacency + counters.
  const ruSlides = deck.finalSlides.filter((s) => s.template === "orion_golden_search_table" && /Россия/.test(s.title));
  check("RU serp produced >=2 pages (16 long rows)", ruSlides.length >= 2, `=${ruSlides.length}`);
  const ruBase = ruSlides.find((s) => s.isContinuation !== true);
  const ruCont = ruSlides.filter((s) => s.isContinuation === true);
  check("RU base is non-continuation", Boolean(ruBase));
  check("RU continuations adjacent to base", ruCont.every((c) => {
    const idx = deck.finalSlides.findIndex((x) => x.slideKey === c.slideKey);
    const prev = deck.finalSlides[idx - 1];
    return prev && (prev.slideKey === ruBase!.slideKey || prev.continuationOf === ruBase!.slideKey);
  }));

  // §6 reconciliation: sum of page displayed == datasetCount; adverse too.
  const ruDisplayed = ruSlides.reduce((a, s) => a + (s.searchCounters?.pageDisplayedCount ?? 0), 0);
  const ruDataset = ruBase?.searchCounters?.datasetCount ?? -1;
  check("RU deckDisplayed == datasetCount (no rows lost)", ruDisplayed === ruDataset && ruDataset === 16, `disp=${ruDisplayed} dataset=${ruDataset}`);
  const ruAdverseDisplayed = ruSlides.reduce((a, s) => a + (s.searchCounters?.pageDisplayedAdverseCount ?? 0), 0);
  const ruAdverseDataset = ruBase?.searchCounters?.datasetAdverseCount ?? -1;
  check("RU adverse displayed == dataset adverse", ruAdverseDisplayed === ruAdverseDataset, `disp=${ruAdverseDisplayed} dataset=${ruAdverseDataset}`);

  // Grouped layout: query not repeated as a body column; group header present.
  check("RU table body has 4 columns (query moved to group header)", ruSlides.every((s) => (s.table?.headers?.length ?? 0) === 4));
  check("RU table carries group headers", ruSlides.every((s) => (s.table?.groups?.length ?? 0) >= 1));

  // UAE 12 rows all displayed.
  const uaeSlides = deck.finalSlides.filter((s) => s.template === "orion_golden_search_table" && /ОАЭ/.test(s.title));
  const uaeDisplayed = uaeSlides.reduce((a, s) => a + (s.searchCounters?.pageDisplayedCount ?? 0), 0);
  check("UAE 12 rows all displayed", uaeDisplayed === 12, `=${uaeDisplayed}`);

  // L. No commercial pages.
  check("L. no commercial sections", !deck.finalSlides.some((s) => /commercial|offer|product/i.test(s.sectionKey)));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed.");
  }
}

main();
