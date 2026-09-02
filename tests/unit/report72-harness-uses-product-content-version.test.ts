/**
 * Эталонный прогон деки собирается под версией содержимого продукта.
 *
 * В `run-orion-deck-sections-report72.ts` версия была записана литералом —
 * `contentVersion: "deck-sections-v14"`, — и не двигалась, пока ключ продукта
 * уехал на v45. Пакеты секций переиспользуются при совпадении версии
 * (`loadPreviousPacks`), поэтому эталон тридцать одну версию подряд собирался
 * из содержимого, построенного в день заморозки.
 *
 * Замер на прежнем коде: журнал сборки давал `REUSED_CACHE 20, REGENERATED 2`
 * при **любой** правке построителей. После правки — `REGENERATED 22`.
 *
 * Последствие было хуже, чем устаревший файл: эталон — это то, чем принимают
 * изменения деки. Пока он собирался из старого содержимого, правка текста в
 * него не доезжала, и проверить её было нечем. Гейт молчал не потому, что всё
 * хорошо, а потому, что смотрел на позавчерашнее.
 *
 * Свойство: на вопрос «какая версия содержимого» отвечает одно место.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DECK_CONTENT_VERSION } from "../../src/modules/digital-profile/orion-golden/deck-sections/content-version";

const HARNESS = join(process.cwd(), "scripts/run-orion-deck-sections-report72.ts");

describe("эталонный прогон деки и версия содержимого", () => {
  const source = readFileSync(HARNESS, "utf8");

  it("версия не записана в прогоне числом", () => {
    // Любой литерал вида "deck-sections-vNN" здесь — второй ответ на вопрос,
    // на который уже отвечает content-version.ts.
    const literals = source.match(/["'`]deck-sections-v\d+["'`]/gu) ?? [];
    expect(literals).toEqual([]);
  });

  it("версия берётся из продукта", () => {
    expect(source).toMatch(/contentVersion:\s*DECK_CONTENT_VERSION/u);
    expect(source).toContain("content-version");
  });

  it("ключ версии продукта существует и непуст", () => {
    // Без этого предыдущая проверка прошла бы и на опечатке в имени.
    expect(DECK_CONTENT_VERSION).toMatch(/^deck-sections-v\d+$/u);
  });
});
