/**
 * Присказку темы узнают по объявленному списку, а не по началу строки (шаг 0145).
 *
 * `fitStructuredBullet` сбрасывает строки блока в известном порядке, и первой
 * уходит присказка «почему это важно». Кто она — определялось перечнем начал
 * («Для банка|Банки |Это усиливает|Риск в том|Деловой фон|Что делать:»), тогда
 * как сами присказки объявлены таблицей `CLIENT_THEME_WHY`. Под перечень не
 * подходят три записи из десяти, и для этих тем присказка переживала все сбросы
 * и съедала бюджет: на стр. 5 отчёта Алекперова 21.09.2026 четыре блока встали
 * без строки счёта, потому что вместо присказки уходили числа.
 *
 * Тот же дефект в том же файле уже лечили один раз (см. комментарий к
 * `clientThemeWhy`): это третий ответ на вопрос «какая строка — присказка».
 */

import { describe, expect, it } from "vitest";
import {
  CLIENT_THEME_WHY,
  clientThemeWhy,
} from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { fitStructuredBullet } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const QUOTE_1 =
  "«О „хороших манерах“ владельцев крупного бизнеса мы разговариваем с главой компании „ЛУКОЙЛ“ Вагитом Алекперовым, который ещё 20 лет назад создал один из первых корпоративных благотворительных фондов.» — источник (nb-forum.ru/interview/experts/vagit-alekperov)";
const QUOTE_2 =
  "«Бизнес-партнёром Вагита Алекперова является Леонид Федун, один из крупнейших акционеров компании ПАО „Лукойл“, до августа 2022 года владел 30,5 % акций и был президентом футбольного клуба „Спартак“ (Москва).» — источник (ru.wikipedia.org/wiki/Алекперов,_Вагит_Юсуфович)";
const SCALE = "Всего по теме: 10 материалов по отчёту, с негативным контекстом — 6.";

const blockWith = (why: string): string =>
  [
    "«Корпоративное владение»",
    "Найдены материалы о владении компаниями и структуре собственности:",
    QUOTE_1,
    QUOTE_2,
    SCALE,
    "Где видно: nb-forum.ru, ru.wikipedia.org.",
    why,
  ].join("\n");

/** Бюджет тематического блока обзора профиля — стр. 5, `executive.ts`. */
const OVERVIEW_BUDGET = 520;

describe("сброс присказки темы", () => {
  const whys = [...Object.entries(CLIENT_THEME_WHY), ["<по умолчанию>", clientThemeWhy(undefined)]];

  for (const [themeId, why] of whys) {
    it(`П1 ${themeId}: присказка уходит раньше чисел`, () => {
      const out = fitStructuredBullet(blockWith(why as string), OVERVIEW_BUDGET);
      expect(out).not.toContain(why as string);
      expect(out).toContain(SCALE);
    });
  }

  it("П2: живой блок Алекперова оставляет числа при бюджете 520", () => {
    const out = fitStructuredBullet(
      blockWith(CLIENT_THEME_WHY.corporate_ownership!),
      OVERVIEW_BUDGET
    );
    expect(out).toContain("Всего по теме: 10 материалов");
    expect(out).toContain("хороших манерах");
    expect(out).not.toContain("Бизнес-партнёром");
  });
});
