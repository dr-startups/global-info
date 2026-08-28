/**
 * Перепечатка с приписанной рубрикой — тот же сюжет, а не второе свидетельство.
 *
 * Правило «два примера — про разные сюжеты» уже ловит дословную перепечатку и
 * обрезанный площадкой заголовок. Рубрику перед заголовком («Хроника: …»,
 * «Подробности: …») оно пропускало: отпечатки не равны, и `startsWith` не
 * срабатывает, потому что лишнее стоит **слева**. В исполнительной сводке
 * золотого кейса так вышло — одна фраза процитирована дважды подряд, ровно то,
 * на что владелец указал замечанием о дублировании текста на слайде.
 */

import { describe, expect, it } from "vitest";
import { pickDistinctTitles } from "@/modules/digital-profile/orion-golden/analytics/distinct-stories";

const HEADLINE = "Anders Holmström flagged during sanctions screening watchlist review";

describe("рубрика перед заголовком не делает из перепечатки второй сюжет", () => {
  it("«Хроника: X» и «X» с разных площадок — один сюжет", () => {
    const picked = pickDistinctTitles(
      [
        { title: HEADLINE, domain: "stockholm-kuriren.se" },
        { title: `Хроника: ${HEADLINE}`, domain: "bizdaily-nordic.se" },
      ],
      2
    );
    expect(picked.map((p) => p.domain)).toEqual(["stockholm-kuriren.se"]);
  });

  it("разные сюжеты одной темы остаются двумя примерами", () => {
    const picked = pickDistinctTitles(
      [
        { title: HEADLINE, domain: "stockholm-kuriren.se" },
        {
          title: "Nordkap Capital board appoints independent compliance advisor",
          domain: "reestr-novosti.ru",
        },
      ],
      2
    );
    expect(picked).toHaveLength(2);
  });

  it("короткий заголовок с приставкой вторым сюжетом остаётся", () => {
    // Порог совпадения не опускается: имя субъекта стоит почти в каждом
    // заголовке темы, и склеивать по нему нельзя.
    const picked = pickDistinctTitles(
      [
        { title: "Суд отказал в иске", domain: "a.example" },
        { title: "Хроника: Суд отказал в иске", domain: "b.example" },
      ],
      2
    );
    expect(picked).toHaveLength(2);
  });
});
