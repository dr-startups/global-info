/**
 * Таблица выдачи называет, что она показывает.
 *
 * На эталоне-72 абзац страницы «Россия — Google» состоял из одной фразы —
 * «„Деловой профиль“ — низкий уровень внимания (строки 9, 11).» Ни запроса, ни
 * движка, ни даты, ни объяснения, что «№» — это порядок нашей сводки по трём
 * запросам, а не место в выдаче. Именно это и прочиталось владельцем как
 * «ТОП-20»: 0 наблюдений из 70 несут `rank`, 0 несут `query`, и таблица честно
 * идёт непозиционной веткой — но молча.
 *
 * Свойство: лид собирается из трёх независимых кусков, каждый печатается
 * только когда его факт известен, а кусок про номера — известен всегда, и он
 * **разный** у позиционной и непозиционной таблицы. Одна общая формулировка
 * обещала бы позиции там, где их нет.
 */

import { describe, expect, it } from "vitest";
import { serpTablePageProse } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";

const POSITIONAL = "Позиции — как их вернул поисковик; спецблоки (картинки, видео, новости) в нумерацию не входят.";
const COLLECTED = "Номера строк — порядок в собранной сводке, а не места в выдаче.";
/**
 * Первая фраза непозиционной таблицы: чья это выдача и почему у неё нет
 * запроса. Без неё тело страницы не называет поисковик вовсе, и два листа
 * разных поисковиков печатали дословно один текст.
 */
const WITHOUT_QUERY =
  "Показана выдача Google; запрос, по которому она собрана, в наборе не записан.";

describe("лид позиционной таблицы", () => {
  it("называет выдачу, запрос и оговорку про спецблоки", () => {
    const prose = serpTablePageProse({
      engineLabel: "Яндекса",
      query: "Anders Holmström",
      collectedRanks: [1, 2, 3],
      positional: true,
    });
    expect(prose.head).toContain("Показана выдача Яндекса по запросу «Anders Holmström».");
    expect(prose.head).toContain(POSITIONAL);
    expect(prose.head).not.toContain(COLLECTED);
  });
});

describe("лид непозиционной таблицы", () => {
  it("без запроса и без даты называет поисковик и порядок сводки", () => {
    const prose = serpTablePageProse({
      engineLabel: "Google",
      query: null,
      collectedRanks: [1, 2, 3],
      positional: false,
    });
    expect(prose.head).toBe(`${WITHOUT_QUERY} ${COLLECTED}`);
  });

  it("ни одна ветка не обещает позиций там, где их нет", () => {
    for (const query of [null, "Глинка Сергей Михайлович"]) {
      const prose = serpTablePageProse({
        engineLabel: "Google",
        query,
        collectedRanks: [1, 2, 3],
        positional: false,
      });
      expect(prose.head).toContain(COLLECTED);
      expect(prose.head).not.toContain("ТОП-20");
      expect(prose.head).not.toContain("вернул поисковик");
    }
  });
});

describe("дата съёмки", () => {
  it("печатается при пригодной дате", () => {
    const prose = serpTablePageProse({
      engineLabel: "Google",
      query: null,
      collectedRanks: [1, 2, 3],
      positional: false,
      freshness: { earliestAt: "2026-08-20T10:00:00.000Z", latestAt: "2026-08-20T10:00:00.000Z" },
    });
    expect(prose.head).toContain("20.08.2026");
  });

  it("эпоха-заглушка датой не считается", () => {
    // `canonical-report-prepare` пишет `new Date(0)` там, где даты нет. Строка
    // «данные собраны 01.01.1970» — выдуманный факт, а не пустое состояние.
    const prose = serpTablePageProse({
      engineLabel: "Google",
      query: null,
      collectedRanks: [1, 2, 3],
      positional: false,
      freshness: { earliestAt: "1970-01-01T00:00:00.000Z", latestAt: "1970-01-01T00:00:00.000Z" },
    });
    expect(prose.head).toBe(`${WITHOUT_QUERY} ${COLLECTED}`);
    expect(prose.head).not.toContain("1970");
  });
});

describe("лид не выталкивает абзац за бюджет", () => {
  it("самый длинный лид укладывается в объявленный бюджет абзаца", () => {
    // Бюджет объявлен реестром шаблонов; второго числа здесь нет. Лид — часть
    // того же абзаца, что и вывод построителя, и вытеснить его не должен.
    const budget = DECK_TEMPLATE_REGISTRY["serp-table"].layout.narrativeCharBudget;
    const prose = serpTablePageProse({
      engineLabel: "Яндекса",
      query: "Глинка Сергей Михайлович Трансмашхолдинг",
      // Самый длинный лид: запрос не основной для раздела, даты съёмки названы
      // и источник вернул меньше двадцати — все три оговорки сразу.
      regionMainQuery: "Глинка Сергей Михайлович",
      collectedRanks: [1, 2, 3],
      positional: true,
      freshness: { earliestAt: "2026-01-02T10:00:00.000Z", latestAt: "2026-08-20T10:00:00.000Z" },
    });
    expect(prose.head.length).toBeLessThan(Number(budget));
  });
});
