/**
 * Continuation slide adjacency + base slot coverage (spec §14 J/K/L).
 */

import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

const LONG =
  "Очень длинный заголовок новостной публикации о субъекте проверки с уточняющими деталями и контекстом события";

function serpRows(n: number): string[][] {
  return Array.from({ length: n }, (_, i) => [
    "Глинка Сергей Михайлович",
    String(i + 1),
    `site${i}.ru`,
    `${LONG} #${i + 1}`,
    i % 4 === 0 ? "Н" : "·",
  ]);
}

function minimalSpec(ruCount: number, uaeCount: number): OrionClassicAuditReportSpec {
  const block = (id: string, key: string, rows: string[][], title: string) => ({
    sectionId: id,
    order: 1,
    block: {
      sectionKey: key,
      slideSpecs: [
        {
          slideKey: `${key}-t`,
          template: "orion_golden_search_table",
          title,
          table: { headers: ["Запрос", "Позиция", "Домен", "Заголовок", "Статус"], rows },
        },
      ],
    },
  });
  return {
    version: "r10-classic-orion-audit-report-spec-v1",
    subject: { displayName: "Тест", reportTitle: "Аудит", asOfDate: "2026-07-15" },
    globalToc: [{ title: "Резюме", sectionId: "01" }],
    registrySections: [
      block("12_ru_serp_position_table", "12_ru_serp_position_table", serpRows(ruCount), "Россия — позиции в поисковой выдаче"),
      block("32_uae_serp_position_table", "32_uae_serp_position_table", serpRows(uaeCount), "ОАЭ — позиции в поисковой выдаче"),
    ],
    offer: { sectionKey: "offer", slideSpecs: [{ slideKey: "o", template: "orion_golden_prose", title: "Оффер" }] },
    productOverview: { sectionKey: "po", slideSpecs: [{ slideKey: "p", template: "orion_golden_prose", title: "Продукт" }] },
    solutionDigitalProfile: { sectionKey: "sdp", slideSpecs: [{ slideKey: "s", template: "orion_golden_prose", title: "ЦП" }] },
    solutionComplianceDatabases: { sectionKey: "scd", slideSpecs: [{ slideKey: "c", template: "orion_golden_prose", title: "БД" }] },
    solutionWikipedia: { sectionKey: "sw", slideSpecs: [{ slideKey: "w", template: "orion_golden_prose", title: "Wiki" }] },
    about: { sectionKey: "about", slideSpecs: [{ slideKey: "a", template: "orion_golden_prose", title: "О нас" }] },
  } as OrionClassicAuditReportSpec;
}

function main() {
  console.log("Smoke: first36 continuation slides\n");
  const deck = composeOrionFirst36CeoDeck(minimalSpec(20, 14), []);

  check("K. baseSlotCoverage === 36", deck.baseSlotCoverage === 36);
  check("totalSlideCount >= 36", (deck.totalSlideCount ?? 0) >= 36, `=${deck.totalSlideCount}`);
  check("totalSlideCount > 36 when data overflows", (deck.totalSlideCount ?? 0) > 36, `=${deck.totalSlideCount}`);

  const cont = deck.finalSlides.filter((s) => s.isContinuation === true);
  check("has continuation slides when overflow", cont.length > 0, `=${cont.length}`);

  for (const c of cont) {
    const idx = deck.finalSlides.findIndex((s) => s.slideKey === c.slideKey);
    const prev = deck.finalSlides[idx - 1];
    const ok =
      prev &&
      (prev.slideKey === c.continuationOf ||
        prev.continuationOf === c.continuationOf ||
        prev.baseSlotId === c.continuationOf);
    check(`CONTINUATION_NOT_ADJACENT ${c.slideKey}`, Boolean(ok));
  }

  const commercial = deck.finalSlides.filter((s) => /offer|commercial|productOverview/i.test(s.sectionKey));
  check("L. no commercial pages", commercial.length === 0);

  const toc = deck.finalSlides.find((s) => s.slotId === "p02_toc");
  check("TOC slide has dynamic page refs", Boolean(toc?.bullets?.some((b) => /стр\./i.test(b))));

  if (failures) process.exitCode = 1;
  console.log(failures ? `\nFAILED ${failures}` : "\nALL PASS");
}

main();
