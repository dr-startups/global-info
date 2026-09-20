/**
 * Роль кавычки определяется парой, а не глифом (шаг 0140).
 *
 * Глиф `“` в русском наборе закрывает пару `„…“`, а в английском открывает
 * пару `“…”`. Правило чистки считало его закрывающим всегда и снимало пробел
 * **перед** ним — на стр. 6 отчёта Фридмана это дало «he was“ associated ”with
 * Putin» и «a“ pro-Kremlin oligarch ”.»: наш же инструмент испортил цитату.
 * Ворота инвариантов на том же глифе дали ложное срабатывание на правильном
 * «„переизбрали“ себе».
 *
 * Ответ должен быть один и общий: кто открывает, кто закрывает — решает пара.
 * Им пользуются и чистка разметки, и ворота.
 */

import { describe, expect, it } from "vitest";
import {
  quoteMarkRoles,
  markupSpaceInQuotes,
  withoutSourceMarkup,
} from "@/modules/digital-profile/orion-golden/client/client-quote";

describe("роль кавычки", () => {
  it("Р1: в русской паре „…“ второй знак закрывает", () => {
    const roles = quoteMarkRoles("и „переизбрали“ себе");
    expect(roles.map((r) => r.role)).toEqual(["open", "close"]);
  });

  it("Р2: в английской паре “…” первый знак открывает", () => {
    const roles = quoteMarkRoles("he was “associated” with Putin");
    expect(roles.map((r) => r.role)).toEqual(["open", "close"]);
  });

  it("Р3: ёлочки не зависят от соседей", () => {
    expect(quoteMarkRoles("клуб «Краснодар» играет").map((r) => r.role)).toEqual([
      "open",
      "close",
    ]);
  });
});

describe("пробел разметки внутри кавычек", () => {
  it("Р4: правильная русская пара пробелом не считается", () => {
    expect(markupSpaceInQuotes("и „переизбрали“ себе в 1996-м")).toBe(false);
  });

  it("Р5: пробелы внутри английской пары ловятся", () => {
    expect(markupSpaceInQuotes("he was “ associated ” with Putin")).toBe(true);
  });

  it("Р6: пробелы внутри ёлочек ловятся", () => {
    expect(markupSpaceInQuotes("клуб « Краснодар » играет")).toBe(true);
  });
});

describe("чистка не портит английские кавычки", () => {
  it("Р7: «was “ associated ” with» становится «was “associated” with»", () => {
    expect(withoutSourceMarkup("he was “ associated ” with Putin")).toBe(
      "he was “associated” with Putin"
    );
  });

  it("Р8: русская пара с пробелами разметки чистится как прежде", () => {
    expect(withoutSourceMarkup("партия « Единая Россия » в 2009 году")).toBe(
      "партия «Единая Россия» в 2009 году"
    );
  });

  it("Р9: правильная русская пара остаётся нетронутой", () => {
    expect(withoutSourceMarkup("и „переизбрали“ себе в 1996-м")).toBe(
      "и „переизбрали“ себе в 1996-м"
    );
  });
});
