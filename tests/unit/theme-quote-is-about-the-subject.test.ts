/**
 * Цитата под темой — фраза о проверяемом лице (шаг 0125).
 *
 * Отчёт Абрамовича 20.09.2026 печатал под темой «Политические связи /
 * публичная экспозиция»:
 *   * стр. 6 — «Абрамович Роман Аркадьевич» (1sn.ru): голое имя вместо фразы;
 *   * стр. 6 — «Roman Arkadyevich Abramovich (born 24 October 1966) is a
 *     Russian businessman and politician.» (kids.kiddle.co): лид
 *     принадлежности, то есть анкета материала, а не факт, из-за которого он
 *     в теме;
 *   * стр. 67 и 68 — «В основном крупные современные политики и бизнесмены –
 *     дети советских партийных и хозяйственных функционеров.» (eg.ru):
 *     обобщение о классе лиц, субъект в нём не назван;
 *   * стр. 69 — «Новости · Франция добивается снятия санкций ЕС с Алишера
 *     Усманова · Суд ЕС отклонил третий иск Абрамовича против санкций.»
 *     (dw.com): полоса тизеров, и первый сюжет — о другом человеке.
 *
 * Правило шага: под темой стоит фраза **о субъекте**. Лид принадлежности
 * показывает тему только там, где предмет темы — сама биография; обобщение о
 * классе лиц и полоса из нескольких заголовков цитатой не бывают вовсе.
 */

import { describe, expect, it } from "vitest";
import { resolveExampleQuote } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { getFindingThemes } from "@/modules/digital-profile/config/finding-themes";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { ObservationVerdict } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";

const POLITICAL = getFindingThemes().find((t) => t.themeId === "political_exposure")!;
const BUSINESS = getFindingThemes().find((t) => t.themeId === "business_profile")!;
const PEP = getFindingThemes().find((t) => t.themeId === "pep_rca_watchlist")!;

const NAMES = ["Абрамович Роман Аркадьевич", "Roman Abramovich"];

let seq = 0;
function item(partial: Partial<RawInventoryItem>): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: "case-abramovich",
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

function subjectVerdict(quotes: string[]): ObservationVerdict {
  return { tone: "neutral", quoted: true, subjectMatch: "subject", quotes };
}

/** Стр. 6: лид англоязычной карточки. Слово темы в нём — перечень занятий. */
const IDENTITY_LEAD =
  "Roman Arkadyevich Abramovich (born 24 October 1966) is a Russian businessman and politician.";

/** Стр. 67–68: обобщение о классе лиц, субъект не назван. */
const GENERALIZATION =
  "В основном крупные современные политики и бизнесмены – дети советских партийных и хозяйственных функционеров.";

/** Стр. 69: полоса тизеров площадки, первый сюжет о другом человеке. */
const HEADLINE_STRIP =
  "Новости · Франция добивается снятия санкций ЕС с Алишера Усманова · " +
  "Суд ЕС отклонил третий иск Абрамовича против санкций.";

describe("лид принадлежности показывает биографию, а не политическую тему", () => {
  it("Ц1: лид не становится цитатой политической темы", () => {
    const ex = resolveExampleQuote(
      item({ title: "Roman Abramovich Facts for Kids", sourceUrl: "https://kids.kiddle.co/Roman_Abramovich" }),
      POLITICAL,
      null,
      { subjectNames: NAMES, verdict: subjectVerdict([IDENTITY_LEAD]) }
    );
    expect(ex?.title ?? "").not.toContain("born 24 October 1966");
  });

  it("Ц2: тот же лид под «Деловым профилем» цитируется — там он и есть предмет темы", () => {
    const ex = resolveExampleQuote(
      item({ title: "Roman Abramovich Facts for Kids", sourceUrl: "https://kids.kiddle.co/Roman_Abramovich" }),
      BUSINESS,
      null,
      { subjectNames: NAMES, verdict: subjectVerdict([IDENTITY_LEAD]) }
    );
    expect(ex?.title).toContain("born 24 October 1966");
  });

  it("Ц3: у страницы с лидом и фразой о теме цитируется фраза о теме", () => {
    const ex = resolveExampleQuote(
      item({ title: "Абрамович — биография", sourceUrl: "https://1sn.ru/peoples/152" }),
      POLITICAL,
      null,
      {
        subjectNames: NAMES,
        verdict: subjectVerdict([
          "Роман Аркадьевич Абрамович (род. 24 октября 1966) — российский предприниматель и политик.",
          "В 1999 году Абрамович был избран депутатом Государственной думы по Чукотскому округу.",
        ]),
      }
    );
    expect(ex?.title).toContain("избран депутатом");
  });
});

describe("обобщение о классе лиц — не цитата темы", () => {
  it("Ц4: фраза о «политиках и бизнесменах» без имени субъекта не цитируется", () => {
    const ex = resolveExampleQuote(
      item({ title: "Дети советской элиты", snippet: GENERALIZATION, sourceUrl: "https://eg.ru/politics/67254" }),
      POLITICAL,
      null,
      { subjectNames: NAMES }
    );
    expect(ex?.title ?? "").not.toContain("дети советских");
  });

  it("Ц5: тот же оборот с именем субъекта цитатой остаётся", () => {
    const about = "Как правило, Абрамович поддерживал партию власти в Государственной думе.";
    const ex = resolveExampleQuote(
      item({ title: "Абрамович в Думе", snippet: about, sourceUrl: "https://eg.ru/politics/1" }),
      POLITICAL,
      null,
      { subjectNames: NAMES }
    );
    expect(ex?.title).toContain("Абрамович поддерживал партию");
  });
});

describe("полоса из нескольких заголовков — не цитата", () => {
  it("Ц6: полоса тизеров с сюжетом о другом человеке не цитируется", () => {
    const ex = resolveExampleQuote(
      item({ title: HEADLINE_STRIP, sourceUrl: "https://dw.com/ru/sanctions" }),
      PEP,
      null,
      { subjectNames: NAMES }
    );
    expect(ex?.title ?? "").not.toContain("Усманова");
  });

  it("Ц7: заголовок с подписью издания через «·» цитатой остаётся (регрессия 0121)", () => {
    const ex = resolveExampleQuote(
      item({
        title: "Суд ЕС в третий раз отказался снять санкции с Абрамовича · ТАСС",
        sourceUrl: "https://tass.ru/tag/abramovich-roman-arkadevich",
      }),
      PEP,
      null,
      { subjectNames: NAMES }
    );
    expect(ex?.title).toContain("отказался снять санкции");
    expect(ex?.title ?? "").not.toContain("ТАСС");
  });
});
