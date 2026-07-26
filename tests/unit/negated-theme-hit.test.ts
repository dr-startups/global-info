import { describe, expect, it } from "vitest";
import { themeHitIsNegated } from "../../src/modules/digital-profile/orion-golden/analytics/negated-theme-hit";

/**
 * Шаг 15, J1.
 *
 * На финальном прогоне в отчёт попала тема «Финансовые претензии / долговые
 * споры», подпёртая материалом, который утверждает **отсутствие** претензий:
 * «…не было выставленных претензий от партнёров и клиентов». Тематизатор
 * поймал слово «претензий» и не заметил отрицания.
 *
 * Косноязычие читатель простит; утверждение, противоположное источнику, он
 * покажет банку.
 */

const CLAIMS = /банкрот|bankrupt|долг\w*|debt|взыскан|неисполнен|lawsuit|претенз|неплатеж/iu;
const CRIMINAL = /уголов|criminal|арест|arrest|суд(?!острое)|court/iu;

describe("отрицание перед словом темы", () => {
  it("ловит ровно тот случай из прогона", () => {
    expect(
      themeHitIsNegated(
        "По компаниям, которыми руководит или руководил ДУРОВ ПАВЕЛ ВАЛЕРЬЕВИЧ " +
          "не было выставленных претензий от партнёров и клиентов на 07.07.2026.",
        CLAIMS
      )
    ).toBe(true);
  });

  it("узнаёт другие обороты отрицания", () => {
    expect(themeHitIsNegated("Признаков банкротства не выявлено", CLAIMS)).toBe(false);
    expect(themeHitIsNegated("Не выявлено признаков банкротства", CLAIMS)).toBe(true);
    expect(themeHitIsNegated("Отсутствуют долги перед бюджетом", CLAIMS)).toBe(true);
    expect(themeHitIsNegated("Нет претензий", CLAIMS)).toBe(true);
  });

  it("утверждение о наличии темой остаётся", () => {
    expect(themeHitIsNegated("Выставлены претензии на 40 млн", CLAIMS)).toBe(false);
    expect(themeHitIsNegated("Компания признана банкротом", CLAIMS)).toBe(false);
  });

  it("отрицание, относящееся к другому, тему не снимает", () => {
    // «не смог оспорить претензии» — претензии есть.
    expect(themeHitIsNegated("Не смог оспорить выставленные претензии", CLAIMS)).toBe(false);
    // «дело не закрыто» — дело есть.
    expect(themeHitIsNegated("Уголовное дело не закрыто", CRIMINAL)).toBe(false);
  });

  it("одно неотрицаемое вхождение оставляет тему", () => {
    // Осторожность в правильную сторону: пропущенный риск виден аналитику,
    // выдуманный — нет.
    expect(
      themeHitIsNegated("Претензий не было, но долг взыскан в суде", CLAIMS)
    ).toBe(false);
  });

  it("текст без слова темы отрицанием не считается", () => {
    expect(themeHitIsNegated("Обычный деловой профиль", CLAIMS)).toBe(false);
    expect(themeHitIsNegated("", CLAIMS)).toBe(false);
  });

  it("далёкое отрицание не дотягивается", () => {
    expect(
      themeHitIsNegated(
        "Не было ни одного повода для беспокойства у партнёров и клиентов, однако претензии выставлены",
        CLAIMS
      )
    ).toBe(false);
  });
});
