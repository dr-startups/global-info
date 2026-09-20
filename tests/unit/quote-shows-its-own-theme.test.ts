/**
 * Цитата показывает свою тему и говорит о субъекте (шаг 0142).
 *
 * Отчёт Фридмана 20.09.2026:
 *   * стр. 7 и 14 — под «Вниманием по линии безопасности / оборонный контур»
 *     напечатано «Родители работали на оборонном предприятии.» Слово словаря
 *     есть («оборонном»), но подлежащее — родители, а не субъект, и речь о
 *     заводе шестидесятых годов;
 *   * стр. 13 — под «Криминальными / судебными материалами» две цитаты про
 *     санкции, ни одна не про суд и не про криминал. Они прошли потому, что у
 *     обвиняющей темы сигналом считается любое слово негатива (шаг 0115);
 *   * стр. 7 — «Browse 151 mikhail fridman photos and images available, or
 *     start a new search to explore more photos and images.»: интерфейс Getty
 *     Images. Предикат призывов знает только русские глаголы.
 *
 * Правила: своё слово темы предпочитается слову негатива; фраза о третьем лице
 * без упоминания субъекта цитатой темы не бывает; призыв интерфейса не бывает
 * цитатой ни на каком языке.
 */

import { describe, expect, it } from "vitest";
import { resolveExampleQuote } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { looksLikeWholeStatement } from "@/modules/digital-profile/orion-golden/analytics/theme-quote";
import { getFindingThemes } from "@/modules/digital-profile/config/finding-themes";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { ObservationVerdict } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";

const SECURITY = getFindingThemes().find((t) => t.themeId === "security_scrutiny")!;
const CRIMINAL = getFindingThemes().find((t) => t.themeId === "criminal_legal")!;
const NAMES = ["Фридман Михаил Маратович", "Mikhail Fridman"];

let seq = 0;
function item(partial: Partial<RawInventoryItem>): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: "case-fridman",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "topvisor-yandex",
    region: "RU",
    collectedAt: "2026-09-20T12:00:00.000Z",
    evidenceType: "search_result",
    title: "",
    snippet: "",
    sourceUrl: `https://example.test/${seq}`,
    ...partial,
  } as RawInventoryItem;
}

const subjectVerdict = (quotes: string[]): ObservationVerdict => ({
  tone: "adverse",
  quoted: true,
  subjectMatch: "subject",
  quotes,
});

describe("фраза о третьем лице цитатой темы не бывает", () => {
  it("Т1: «Родители работали на оборонном предприятии» не цитируется", () => {
    const ex = resolveExampleQuote(
      item({ title: "Михаил Фридман — биография", sourceUrl: "https://dzen.ru/a/ZQtKqdqB0HHqD" }),
      SECURITY,
      null,
      {
        subjectNames: NAMES,
        verdict: subjectVerdict([
          "Родители работали на оборонном предприятии.",
          "Активы Фридмана заморожены, в его особняке прошли обыски по делу о нарушении санкционного режима.",
        ]),
      }
    );
    expect(ex?.title ?? "").not.toContain("Родители работали");
    expect(ex?.title).toContain("обыски");
  });

  it("Т2: та же фраза с именем субъекта остаётся цитатой", () => {
    const ex = resolveExampleQuote(
      item({ title: "Михаил Фридман — биография", sourceUrl: "https://dzen.ru/a/x" }),
      SECURITY,
      null,
      {
        subjectNames: NAMES,
        verdict: subjectVerdict([
          "Родители Михаила Фридмана работали на оборонном предприятии Львова.",
        ]),
      }
    );
    expect(ex?.title).toContain("оборонном предприятии");
  });
});

describe("своё слово темы предпочитается слову негатива", () => {
  it("Т3: под криминальной темой цитируется фраза о суде, а не о санкциях", () => {
    const ex = resolveExampleQuote(
      item({ title: "Михаил Фридман", sourceUrl: "https://ko.ru/biography/mikhail-fridman" }),
      CRIMINAL,
      null,
      {
        subjectNames: NAMES,
        verdict: subjectVerdict([
          "После начала спецоперации на Украине в 2022 году Фридман попал в санкционные списки западных стран.",
          "Суд Нидерландов рассматривает дело о финансовых преступлениях с участием Фридмана.",
        ]),
      }
    );
    expect(ex?.title).toContain("Суд Нидерландов");
  });
});

describe("призыв интерфейса не бывает цитатой ни на каком языке", () => {
  it("Т4: текст Getty Images не проходит предикат целой фразы", () => {
    expect(
      looksLikeWholeStatement(
        "Browse 151 mikhail fridman photos and images available, or start a new search to explore more photos and images."
      )
    ).toBe(false);
  });

  it("Т5: обычная английская фраза предикат проходит", () => {
    expect(
      looksLikeWholeStatement(
        "In 2022 the EU imposed sanctions on Fridman in response to the invasion of Ukraine."
      )
    ).toBe(true);
  });
});
