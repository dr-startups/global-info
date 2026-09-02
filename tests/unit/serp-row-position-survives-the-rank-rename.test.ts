/**
 * Строки, собранные до переименования, не теряют позицию.
 *
 * Позиция серперной строки переехала из `rawMetadata.position` в
 * `rawMetadata.rank`: `position` стал числом провайдера и позицией быть
 * перестал. У всех кейсов, собранных до перехода, `rank` в `rawMetadata` нет —
 * их позицию держит только запасное чтение `meta.rank ?? meta.position` в
 * `rankOf`.
 *
 * Ревью показало мутацией, что запасное чтение сегодня не держит ничто: убери
 * `?? meta.position` — весь прогон зелёный, потому что золотой кейс уже пишет
 * `rank`. Цена «упрощения» тихая и дорогая: материал без позиции
 * `analysis-scope` в анализ не берёт, и на пересборке старого кейса ТОП-20 и
 * матрица рисков молча худеют.
 */

import { describe, expect, it } from "vitest";
import { rankOf } from "@/modules/digital-profile/orion-golden/analytics/analysis-scope";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

function inventoryItem(rawMetadata: Record<string, unknown>): RawInventoryItem {
  return {
    inventoryId: "sr-1",
    caseId: "case-1",
    reportRunId: "run-1",
    source: "search_result",
    provider: "GOOGLE",
    region: "RU",
    collectedAt: "2026-08-28T00:00:00.000Z",
    evidenceType: "search_result",
    title: "Материал",
    rawMetadata,
  };
}

describe("позиция строки выдачи читается и у старых кейсов", () => {
  it("строка нового сбора отдаёт позицию из `rank`", () => {
    expect(rankOf(inventoryItem({ source: "serper", rank: 11, providerPosition: 1 }))).toBe(11);
  });

  it("строка, собранная до переименования, отдаёт позицию из `position`", () => {
    // Так выглядит серперная строка любого кейса, собранного раньше: ключа
    // `rank` в ней нет вовсе, а `position` тогда и был нашей позицией.
    expect(rankOf(inventoryItem({ source: "serper", position: 7 }))).toBe(7);
  });

  it("при обоих ключах побеждает наш `rank`, а не число провайдера", () => {
    // Случай, ради которого переименование и делалось: `providerPosition`
    // нумерует строки своей страницы с единицы.
    expect(rankOf(inventoryItem({ source: "serper", rank: 11, position: 1 }))).toBe(11);
  });
});
