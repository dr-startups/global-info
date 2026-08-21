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
import {
  findInternalCodes,
  findLowercaseCodeLikeTokens,
} from "@/modules/digital-profile/orion-golden/deck-sections/internal-code-scan";
import { localizedThemedClaim } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
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

  it("наши коды ловятся проверкой деки и останавливают сборку", () => {
    expect(findInternalCodes("сбой VISUAL_ASSET_UNAVAILABLE на странице")).toEqual([
      "VISUAL_ASSET_UNAVAILABLE",
    ]);
  });

  it("имя набора остаётся видимым, но сборку не останавливает", () => {
    /*
     * До живого прогона 21.08 имена наборов ловились тем же правилом, что и
     * наши коды, и блокировали сборку. По форме они неотличимы от ников в
     * соцсетях (`umar_kremlev`, `shara_bullet77`), и на кейсе Кремлёва ворота
     * остановили оплаченный отчёт на последнем шаге из-за чужой подписи.
     * Решение владельца 21.08: нижний регистр — замечание, не приговор.
     */
    expect(findInternalCodes("источники: ext_gb_coh_psc, us_trade_csl")).toEqual([]);
    expect(findLowercaseCodeLikeTokens("источники: ext_gb_coh_psc, us_trade_csl")).toEqual([
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

describe("адрес в клиентском тексте кодом не считается", () => {
  /**
   * Прогон 73: проверка сборки объявила `leonid_mihelson` внутренним кодом. Это
   * часть адреса `banki.ru/news/story/person/leonid_mihelson` в колонке ссылок
   * таблицы выдачи — подчёркивание там законно, это путь к материалу.
   */
  it("подчёркивание в пути адреса законно", () => {
    expect(findInternalCodes("banki.ru/news/story/person/leonid_mihelson")).toEqual([]);
    expect(
      findInternalCodes("https://sanctions.lursoft.lv/person/leonid_viktorovich_mikhelson")
    ).toEqual([]);
  });

  it("имя набора рядом с адресом всё равно видно — замечанием", () => {
    expect(
      findLowercaseCodeLikeTokens("источники: ext_gb_coh_psc — см. opensanctions.org/entities/Q1")
    ).toEqual(["ext_gb_coh_psc"]);
    // Сам адрес по-прежнему не токен: подчёркивание в пути законно.
    expect(
      findLowercaseCodeLikeTokens("banki.ru/news/story/person/leonid_mihelson")
    ).toEqual([]);
  });
});

describe("проверка Википедии — не публикация", () => {
  /**
   * Прогон 73: «Wikipedia (en): статья не найдена» стояло в кавычках
   * доказательством темы «Деловой профиль». Заголовок у такой записи собираем
   * мы сами, и отсутствие статьи было предъявлено как найденный материал.
   */
  it("запись проверки не попадает в цитаты темы", () => {
    const finding = {
      findingId: "finding-business_profile-ambiguous-test",
      theme: "Деловой профиль",
      claim: "Найдены материалы делового и биографического профиля:\nВсего по теме: 1 материал.",
      riskLevel: "low",
      regions: ["RU", "UAE"],
      evidenceRefs: ["inventory:wiki"],
      sourceDomains: ["en.wikipedia.org"],
    } as unknown as Parameters<typeof localizedThemedClaim>[0];
    const scoped = {
      findings: [finding],
      surfaceUnits: [],
      evidenceIndex: {
        "inventory:wiki": {
          title: "Wikipedia (en): статья не найдена",
          domain: "en.wikipedia.org",
          region: "RU",
          kind: "wikipedia_check",
        },
      },
      scope: { regions: ["RU"] },
      metricSnapshot: {},
    } as unknown as Parameters<typeof localizedThemedClaim>[1];
    expect(localizedThemedClaim(finding, scoped)).not.toContain("статья не найдена");
  });
});
