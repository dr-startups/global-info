/**
 * Подпись служебного блока выдачи не цитируется как материал.
 *
 * «Картинки по запросу "Тимати биография"» — надпись, которую поисковик рисует
 * над плиткой изображений: у неё нет ни автора, ни содержания, она лишь
 * повторяет запрос. На прогоне 14.08 такая строка стояла доказательством в
 * пяти блоках отчёта, включая резюме для руководства и матрицу рисков.
 */

import { describe, expect, it } from "vitest";
import {
  looksLikeMachineDump,
  looksLikeSurfaceBlockHeading,
  pageQuoteForClient,
} from "@/modules/digital-profile/orion-golden/analytics/client-quote-hygiene";
import { findInternalCodes } from "@/modules/digital-profile/orion-golden/deck-sections/internal-code-scan";
import {
  isWeakExampleTitle,
  quoteForClaim,
} from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";

describe("подписи блоков выдачи", () => {
  const headings = [
    'Картинки по запросу "Тимати биография"',
    'Картинки по запросу "тимур ильдарович юнусов дети"',
    "Изображения по запросу Юнусов",
    "Видео по запросу Тимати суд",
    "Новости по запросу Юнусов Тимур",
    "Похожие запросы",
    "Связанные запросы",
    'Images for "Timati biography"',
    "People also ask",
    "People also search for",
    "Related searches",
    "Searches related to Timati",
  ];

  it("узнаются во всех формах, что отдают поверхности", () => {
    for (const h of headings) {
      expect(looksLikeSurfaceBlockHeading(h), h).toBe(true);
      expect(isWeakExampleTitle(h), h).toBe(true);
    }
  });

  it("настоящие заголовки публикаций не задевает", () => {
    const real = [
      "Ukraine issues arrest warrant for pro-Putin Russian rapper Timati",
      "Тимати, биография и музыкальное творчество",
      "ИП Юнусов Тимур Ильдарович зарегистрирован 25.12.2008",
      "Timati has been suspected in Ukraine",
      "Как запросы к банку меняют профиль риска",
    ];
    for (const t of real) expect(looksLikeSurfaceBlockHeading(t), t).toBe(false);
  });

  it("слово «картинки» само по себе материал не отменяет", () => {
    // Отсеивается именно подпись блока, а не любое упоминание изображений.
    expect(looksLikeSurfaceBlockHeading("Картинки с суда над Тимати опубликованы")).toBe(false);
    expect(looksLikeSurfaceBlockHeading("Новости о запросе прокуратуры")).toBe(false);
  });
});

describe("машинные имена наборов данных", () => {
  /**
   * Отчёт 72, приложение, трижды: «Темы: судебные и правовые материалы…
   * источники: ext_gb_coh_psc, us_trade_csl, eu_fsf, ru_billionaires_2021,
   * ru_navalny35» — идентификаторы наборов, поданные клиенту в кавычках как
   * слова источника. Читателю они не сообщают ничего.
   */
  const dump =
    "Темы: судебные и правовые материалы, санкционные списки; должность: chairperson; источники: ext_gb_coh_psc, us_trade_csl, eu_fsf, ru_billionaires_2021, ru_navalny35";

  it("узнаются по подчёркиванию: в прозе его не бывает", () => {
    expect(looksLikeMachineDump(dump)).toBe(true);
    expect(looksLikeMachineDump("источники: us_ofac_sdn")).toBe(true);
  });

  it("в цитату не проходят ни одним путём", () => {
    expect(pageQuoteForClient(dump)).toBe("");
    expect(quoteForClaim(dump, 400)).toBe("");
  });

  it("обычный текст не задевает", () => {
    expect(looksLikeMachineDump("Санкции ЕС и США против предпринимателя")).toBe(false);
    expect(looksLikeMachineDump("Проверка PEP / RCA по спискам наблюдения")).toBe(false);
  });

  it("внутренние коды ловятся проверкой деки в любом регистре", () => {
    expect(findInternalCodes("сбой VISUAL_ASSET_UNAVAILABLE на странице")).toEqual([
      "VISUAL_ASSET_UNAVAILABLE",
    ]);
    expect(findInternalCodes("источники: ext_gb_coh_psc, us_trade_csl")).toEqual([
      "ext_gb_coh_psc",
      "us_trade_csl",
    ]);
  });

  it("маркер находки кодом не считается: до бумаги он не доходит", () => {
    expect(
      findInternalCodes("Всего по теме: 1 материал. [finding-criminal_legal-subject_match-ae9b4bfe]")
    ).toEqual([]);
    expect(findInternalCodes("finding-pep_rca_watchlist-subject_match-dfa7da39")).toEqual([]);
  });
});
