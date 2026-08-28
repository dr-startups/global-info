/**
 * Решение по прочитанной странице принадлежит материалу, а не наблюдению.
 *
 * Читаем мы страницы, а не строки: `linksToRead` дедуплицирует ссылки по
 * адресу и оставляет первую, поэтому у страницы, найденной двумя запросами или
 * двумя движками, решение ровно одно — на первой ссылке. Дека это правило
 * знает (`applyLinkVerdictsToEvidence`), и без него на прогоне Кремлёва строка
 * таблицы ОАЭ печаталась «Нейтральной» при красной рамке на том же адресе двумя
 * листами дальше.
 *
 * Аналитика обязана считать так же, иначе таблица метрик региона печатает
 * «негативных: 1» ровно там, где таблица выдачи печатает строку чистой.
 */

import { describe, expect, it } from "vitest";
import {
  resolveItemAdverse,
  spreadVerdictsOverMaterials,
} from "@/modules/digital-profile/orion-golden/analytics/item-adverse";
import type { ObservationVerdictByRef } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const TITLE = "Суд рассмотрел иск Anders Holmström к изданию";
const URL = "https://kapitalnytt.se/holmstrom-court";

function item(partial: Partial<RawInventoryItem> & { inventoryId: string }): RawInventoryItem {
  return {
    caseId: "case-material-verdict",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-08-28T00:00:00.000Z",
    evidenceType: "search_result",
    title: TITLE,
    snippet: "",
    sourceUrl: URL,
    rawMetadata: { surface: "organic" },
    ...partial,
  };
}

describe("решение прочитанной страницы разложено по материалу", () => {
  it("второе наблюдение того же адреса получает то же решение", () => {
    const yandexRow = item({ inventoryId: "obs-ru" });
    const googleRow = item({ inventoryId: "obs-google", provider: "serper" });
    const read: ObservationVerdictByRef = {
      "inventory:obs-ru": { tone: "supportive", quoted: true, subjectMatch: "subject" },
    };

    // Без раскладки словарь красит вторую строку: «суд» в заголовке.
    expect(resolveItemAdverse(googleRow, read)).toBe(true);

    const spread = spreadVerdictsOverMaterials([yandexRow, googleRow], read);
    expect(resolveItemAdverse(yandexRow, spread)).toBe(false);
    expect(resolveItemAdverse(googleRow, spread)).toBe(false);
  });

  it("у материала одно решение, и оно сильнейшее", () => {
    const first = item({ inventoryId: "obs-1" });
    const second = item({ inventoryId: "obs-2" });
    const read: ObservationVerdictByRef = {
      "inventory:obs-1": { tone: "neutral", quoted: false, subjectMatch: "subject" },
      "inventory:obs-2": { tone: "adverse", quoted: true, subjectMatch: "subject" },
    };

    const spread = spreadVerdictsOverMaterials([first, second], read);
    expect(resolveItemAdverse(first, spread)).toBe(true);
    expect(resolveItemAdverse(second, spread)).toBe(true);
  });

  it("запись без адреса решением ни с кем не делится", () => {
    // Записи комплаенс-баз: адреса нет, а заголовок — имя субъекта, одинаковое
    // у всех баз. Одно решение сняло бы совпадение сразу у трёх.
    const dowJones = item({
      inventoryId: "cmp-1",
      sourceUrl: undefined,
      title: "Anders Holmström",
      snippet: "Санкционный список: совпадение по имени.",
      evidenceType: "compliance_hit",
    });
    const lexis = { ...dowJones, inventoryId: "cmp-2" };
    const read: ObservationVerdictByRef = {
      "inventory:cmp-1": { tone: "supportive", quoted: true, subjectMatch: "subject" },
    };

    const spread = spreadVerdictsOverMaterials([dowJones, lexis], read);
    expect(resolveItemAdverse(dowJones, spread)).toBe(false);
    expect(resolveItemAdverse(lexis, spread)).toBe(true);
  });
});
