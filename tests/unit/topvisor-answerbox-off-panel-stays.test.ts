/**
 * В режиме `topvisor` готовый ответ Google не читается, а панель знаний — да.
 *
 * Ловушка, ради которой этот тест и написан: обе поверхности приходят из
 * Serper под **одним** видом `knowledgePanel`, и различает их только
 * `rawMetadataSafe.surface`. Фильтр по виду выключил бы панель знаний молча —
 * страница «Панель знаний» опустела бы при зелёном прогоне.
 */

import { describe, expect, it } from "vitest";
import { surfaceItemAllowedInMode } from "@/modules/digital-profile/services/orion-search-profile-service";
import { answerBoxItem } from "@/modules/digital-profile/providers/serper-surfaces";

const ctx = { query: "Кремлёв Умар Назарович", region: "RU" as const, language: "ru", capturedAt: "2026-09-03T00:00:00.000Z" };

const answerBox = answerBoxItem(
  { answer: "Умар Кремлёв — президент IBA.", title: "Умар Кремлёв", link: "https://tass.ru/x" },
  ctx
)!;

const knowledgePanel = {
  ...answerBox,
  title: "Умар Кремлёв",
  rawMetadataSafe: { source: "serper", surface: "knowledgeGraph", capturedAt: ctx.capturedAt },
};

describe("готовый ответ Google и панель знаний — разные поверхности одного вида", () => {
  it("вид у них общий: по виду их различить нельзя", () => {
    expect(answerBox.kind).toBe("knowledgePanel");
    expect(knowledgePanel.kind).toBe("knowledgePanel");
  });

  it("в режиме topvisor готовый ответ не идёт: AI-ответы собирает Topvisor", () => {
    expect(surfaceItemAllowedInMode(answerBox, "topvisor")).toBe(false);
  });

  it("панель знаний остаётся: её Topvisor не заменяет", () => {
    expect(surfaceItemAllowedInMode(knowledgePanel, "topvisor")).toBe(true);
  });

  it("в прежнем режиме идут обе", () => {
    expect(surfaceItemAllowedInMode(answerBox, "legacy")).toBe(true);
    expect(surfaceItemAllowedInMode(knowledgePanel, "legacy")).toBe(true);
  });

  it("подсказки по-прежнему выключены режимом, остальное — нет", () => {
    // Пометку `answerBox` несёт только сам готовый ответ; остальные поверхности
    // приходят со своей — брать её у него значило бы проверять не то.
    const other = (kind: string, surface: string) =>
      ({ kind, rawMetadataSafe: { source: "serper", surface, capturedAt: ctx.capturedAt } }) as never;

    expect(surfaceItemAllowedInMode(other("autocomplete", "autocomplete"), "topvisor")).toBe(false);
    expect(surfaceItemAllowedInMode(other("images", "images"), "topvisor")).toBe(true);
    expect(surfaceItemAllowedInMode(other("relatedQueries", "relatedSearches"), "topvisor")).toBe(true);
  });
});
