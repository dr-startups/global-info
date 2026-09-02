/**
 * Одна публикация одного издания цитируется один раз.
 *
 * Боевой отчёт 28.07 (Тиньков), страница 5, «Семейные и личные связи»:
 *
 *     «Oleg Tinkov Net Worth, Biography, Age, Spouse, Children & More»
 *         — источник goodreturns.in
 *     «Oleg Tinkov: Oleg Tinkov Net Worth, Biography, Age, Spouse, Children
 *      & More - Goodreturns» — источник goodreturns.in
 *
 * Это одна и та же статья одного издания: во втором заголовке к тому же тексту
 * приписаны имя рубрики спереди и имя площадки сзади. Читатель видит одно
 * предложение дважды подряд, а отчёт предъявляет одну публикацию как два
 * свидетельства.
 *
 * Дедупликация сюжетов в проекте уже есть (e4aede3), но её звал только
 * построитель региональных резюме. Здесь работает другой участник —
 * `finding-synthesizer`, и он брал просто два первых примера
 * (`examples.slice(0, 2)`). Тот же вопрос — «разные ли это сюжеты» — и снова
 * без ответа.
 *
 * Прежнего правила для этой пары мало: второй заголовок не начинается с
 * первого, он его **содержит**. Поэтому у одного издания заголовок-надмножество
 * считается тем же сюжетом. Условие «одно издание» намеренно: у разных
 * издателей похожие заголовки могут быть разными материалами.
 */

import { describe, expect, it } from "vitest";
import { pickDistinctTitles } from "../../src/modules/digital-profile/orion-golden/analytics/distinct-stories";

const SHORT = "Oleg Tinkov Net Worth, Biography, Age, Spouse, Children & More";
const LONG =
  "Oleg Tinkov: Oleg Tinkov Net Worth, Biography, Age, Spouse, Children & More - Goodreturns";

describe("одна публикация одного издания", () => {
  it("наблюдавшийся случай: заголовок-надмножество того же издания — один сюжет", () => {
    const picked = pickDistinctTitles(
      [
        { title: SHORT, domain: "goodreturns.in" },
        { title: LONG, domain: "goodreturns.in" },
      ],
      2
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]!.title).toBe(SHORT);
  });

  it("похожие заголовки разных изданий остаются оба", () => {
    // У разных издателей это может быть перепечатка с добавленным контекстом
    // или самостоятельный материал — решать за них по вхождению нельзя.
    const picked = pickDistinctTitles(
      [
        { title: SHORT, domain: "goodreturns.in" },
        { title: LONG, domain: "forbes.com" },
      ],
      2
    );
    expect(picked).toHaveLength(2);
  });

  it("дословный повтор снимается и без домена", () => {
    // Прежнее правило: тот же сюжет с хвостом площадки.
    const head = "Российский бизнесмен Сергей Глинка пытается овладеть заводом Popeci";
    const picked = pickDistinctTitles(
      [
        { title: `${head} • Портал РЕПОСТ`, domain: "repost.news" },
        { title: `${head} • Портал РуМафия`, domain: "rumafia.io" },
      ],
      2
    );
    expect(picked).toHaveLength(1);
  });

  it("разные сюжеты одного издания остаются оба", () => {
    const picked = pickDistinctTitles(
      [
        { title: "Олег Тиньков продал долю в банке", domain: "rbc.ru" },
        { title: "Суд отказал в иске о защите деловой репутации", domain: "rbc.ru" },
      ],
      2
    );
    expect(picked).toHaveLength(2);
  });

  it("короткое вхождение сюжетом не считается", () => {
    // «Олег Тиньков» содержится почти во всех заголовках темы — по такому
    // совпадению склеивать материалы нельзя.
    const picked = pickDistinctTitles(
      [
        { title: "Олег Тиньков", domain: "rbc.ru" },
        { title: "Олег Тиньков продал долю в банке и уехал", domain: "rbc.ru" },
      ],
      2
    );
    expect(picked).toHaveLength(2);
  });
});
