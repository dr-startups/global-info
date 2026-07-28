/**
 * Панель рядом с картинкой не повторяет одно предложение трижды.
 *
 * Замер по отчёту боевого прогона 28.07 (DPA-2026-0005, 50 страниц): на
 * девяти страницах панель печатала уже сказанное ещё раз — всего 23 повтора.
 * Хуже всего выглядела «ОАЭ — изображения в поиске»: одно и то же предложение
 * шло подряд в выводе, в «Что показывает экран» и в «Что это значит».
 *
 * Причина не в шаблоне, а в источниках: `narrative` начинается тем же, что
 * лежит в `whatWasFound`, а заканчивается тем, из чего собран блок «что это
 * значит». Проверяем свойство — блоки панели не повторяются, — а не устройство.
 */

import { describe, expect, it } from "vitest";
import {
  withoutRepeatedSentences,
  normalizeForCompare,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/run-deck-build";

/** Сколько предложений во всех блоках встречается не в первый раз. */
function repeatedSentenceCount(blocks: Array<string | undefined>): number {
  const seen = new Set<string>();
  let repeats = 0;
  for (const block of blocks) {
    for (const sentence of (block ?? "").split(/(?<=[.!?…])\s+/u)) {
      const key = normalizeForCompare(sentence);
      if (!key) continue;
      if (seen.has(key)) repeats += 1;
      seen.add(key);
    }
  }
  return repeats;
}

describe("панель говорит каждое своё один раз", () => {
  it("страница «ОАЭ — изображения в поиске» перестаёт повторяться", () => {
    // Дословно из render-payload.json боевого прогона.
    const A =
      "Показано 6 результатов; из них о субъекте — 0, вероятно о субъекте — 0, негативных заголовков — 0; преобладающие источники: bbc.com, en.wikipedia.org, gulftoday.ae и ещё 1.";
    const B =
      "Визуальная выдача влияет на первое впечатление до чтения статей. Сейчас она не усиливает негативный фон по субъекту, но требует мониторинга на фоне судебных и публичных сюжетов в общем профиле.";
    const status = "Статус: состав страницы описан по строкам таблицы; отдельного тематического вывода нет.";

    expect(repeatedSentenceCount([A, `${A} ${B}`, `${B} ${status}`])).toBe(3);

    const said = new Set<string>();
    const blocks = [A, `${A} ${B}`, `${B} ${status}`].map((b) =>
      withoutRepeatedSentences(b, said)
    );

    expect(repeatedSentenceCount(blocks)).toBe(0);
    // Каждый блок сохраняет то, чего не было выше.
    expect(blocks[0]).toBe(A);
    expect(blocks[1]).toBe(B);
    expect(blocks[2]).toBe(status);
  });

  it("блок, целиком повторяющий сказанное, исчезает вместе со своим заголовком", () => {
    const said = new Set<string>();
    const first = withoutRepeatedSentences("Единственное предложение.", said);
    const second = withoutRepeatedSentences("Единственное предложение.", said);
    expect(first).toBe("Единственное предложение.");
    // Пустая строка оставила бы в вёрстке заголовок без текста под ним.
    expect(second).toBeUndefined();
  });

  it("повтор опознаётся, несмотря на кавычки, тире и регистр", () => {
    const said = new Set<string>();
    withoutRepeatedSentences("«Криминальные / судебные материалы» — критический уровень.", said);
    expect(
      withoutRepeatedSentences("Криминальные / судебные материалы - Критический уровень.", said)
    ).toBeUndefined();
  });

  it("похожие, но разные предложения остаются оба", () => {
    const said = new Set<string>();
    withoutRepeatedSentences("Показано 6 результатов.", said);
    expect(withoutRepeatedSentences("Показано 7 результатов.", said)).toBe(
      "Показано 7 результатов."
    );
  });

  it("пустой и отсутствующий текст не создают блока", () => {
    const said = new Set<string>();
    expect(withoutRepeatedSentences(undefined, said)).toBeUndefined();
    expect(withoutRepeatedSentences("   ", said)).toBeUndefined();
  });
});
