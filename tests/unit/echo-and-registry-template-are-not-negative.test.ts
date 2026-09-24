import { describe, expect, it } from "vitest";
import { resolveRowAdverse } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import { lightVerdict } from "@/modules/self-check/verdict";
import { subjectIdentityFromProfile } from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { ALL_ANSWERED, SCREENED, observation, serpItems } from "../support/light-run-fixtures";

/**
 * Эхо запроса и шаблон карточки реестра компаний — не негатив.
 *
 * Живой прогон 23.09.2026: непубличный предприниматель получил тему «Санкционные
 * и PEP-списки» высокого уровня из четырёх строк, в которых о нём нет ничего, —
 * карточки Контур.Фокуса («Проверка по 40+ санкционным спискам» — реклама на
 * каждой карточке), две карточки «Моего дела» (меню «Риски и санкции;
 * Банкротство») и ссылка Яндекса на свою же страницу картинок «Картинки по
 * запросу "… санкции"»: слово нашей пробы в заголовке. OpenSanctions совпадений
 * не нашёл. Решение владельца 24.09.2026 — такие строки материалами не считать.
 */

const NAME = "Иванов Иван Иванович";

const ECHO_COURT = {
  title: `Картинки по запросу "${NAME} суд"`,
  snippet: `Картинки по запросу "${NAME} суд"`,
  url: "https://yandex.ru/images/search?text=%D0%B8%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2+%D1%81%D1%83%D0%B4",
};

const ECHO_SANCTIONS = {
  title: `Картинки по запросу "${NAME} санкции"`,
  snippet: `Картинки по запросу "${NAME} санкции"`,
  url: "https://yandex.ru/images/search?text=%D0%B8%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2+%D1%81%D0%B0%D0%BD%D0%BA%D1%86%D0%B8%D0%B8",
};

const KONTUR_CARD = {
  title: `ИП ${NAME}, ИНН 772500000000 — Контур.Фокус`,
  snippet:
    "Санкционные списки. Проверка по 40+ санкционным спискам разных стран. Выявление фигурантов санкций и связанных с ними лиц и компаний. Узнать больше.",
  url: "https://focus.kontur.ru/entity?query=310000000000000",
};

const MOEDELO_CARD = {
  title: `ИП ${NAME} ИНН 772500000000`,
  snippet:
    "Риски и санкции ; Банкротство Дела и намерения о банкротстве ; Банковские счета Блокировки и приостановления ФНС ; Меры господдержки Доступные льготы от ...",
  url: "https://www.moedelo.org/kontragenty/ogrn/310000000000000",
};

describe("строка без сведений о человеке — не негатив", () => {
  it("подпись служебного блока выдачи («Картинки по запросу …») повторяет пробу и ничего не утверждает", () => {
    expect(resolveRowAdverse(ECHO_COURT)).toBe(false);
  });

  it("реклама санкционной проверки на карточке Контур.Фокуса — не сведения о человеке", () => {
    expect(resolveRowAdverse(KONTUR_CARD)).toBe(false);
  });

  it("меню «Риски и санкции; Банкротство» карточки «Моего дела» — не сведения о человеке", () => {
    expect(resolveRowAdverse(MOEDELO_CARD)).toBe(false);
  });

  it("происшествие на карточке реестра краснит её, как любой справочник", () => {
    expect(
      resolveRowAdverse({ ...KONTUR_CARD, snippet: `Учредитель ${NAME} арестован по делу о мошенничестве` })
    ).toBe(true);
  });

  it("решение аналитика «нежелательный» на карточке реестра сильнее шаблона — человек видел страницу", () => {
    expect(resolveRowAdverse({ ...KONTUR_CARD, analystDecision: "ADVERSE" })).toBe(true);
  });

  it("обычная новость о приговоре — негатив, как прежде", () => {
    expect(
      resolveRowAdverse({
        title: `${NAME} осуждён по делу о мошенничестве`,
        snippet: "Суд приговорил предпринимателя к четырём годам колонии",
        url: "https://kommersant.ru/doc/7000001",
      })
    ).toBe(true);
  });
});

describe("лёгкий вердикт предпринимателя без негатива", () => {
  it("эхо и шаблоны реестров не дают ни темы санкций, ни темы суда", () => {
    const items = serpItems(
      ...[ECHO_COURT, ECHO_SANCTIONS, KONTUR_CARD, MOEDELO_CARD].map((row) =>
        observation(row.title, row.url, { snippet: row.snippet })
      )
    );
    const v = lightVerdict({
      items,
      providers: ALL_ANSWERED,
      screenings: SCREENED,
      subject: subjectIdentityFromProfile({
        displayName: NAME,
        fullNameRu: { lastName: "Иванов", firstName: "Иван", patronymic: "Иванович" },
      }),
    });
    expect(v.themes.map((t) => t.id)).toEqual([]);
    expect(v.verdict).toBe("CLEAN");
  });
});
