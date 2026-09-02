/**
 * Блок резюме укладывается в бюджет, иначе отчёта не будет вовсе.
 *
 * Боевой прогон 28.07: тема резюме вышла в 916 знаков при бюджете 900,
 * проверка секций дала `bullet over budget on p03_executive: 916>900`,
 * обязательная секция EXECUTIVE_SUMMARY получила FAILED, и сборка деки
 * остановилась целиком. Шестнадцать лишних знаков — и клиент не получает
 * ничего.
 *
 * Проверяем свойство: ни один блок не превышает бюджет, и при этом ни одно
 * слово не теряется. Переносить — можно, обрезать — нельзя.
 */

import { describe, expect, it } from "vitest";
import {
  packSentencesNoTruncate,
  splitOverlongSentence,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";

/** Все слова исходника присутствуют в результате, в том же порядке. */
function wordsOf(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

describe("длинное предложение раскладывается, а не роняет сборку", () => {
  it("одно предложение длиннее бюджета не остаётся целым", () => {
    const long =
      "Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами; " +
      "материалы по теме видны на крупных площадках, включая деловые и новостные издания; " +
      "для банка или партнёра такие сюжеты обычно становятся первым поводом для расширенной проверки; " +
      "проверить актуальные статусы дел по картотекам судов и официальным источникам.";
    expect(long.length).toBeGreaterThan(200);

    const chunks = packSentencesNoTruncate(long, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });

  it("ни одно слово не теряется при переносе", () => {
    const long =
      "Первая часть довольно длинного предложения, вторая часть того же предложения, " +
      "третья часть, четвёртая часть, пятая часть и наконец шестая часть.";
    const chunks = packSentencesNoTruncate(long, 60);
    expect(chunks.join(" ").length).toBeGreaterThan(0);
    // Порядок и состав слов сохранены — перенос, а не обрезка.
    expect(wordsOf(chunks.join(" "))).toEqual(wordsOf(long));
  });

  it("предложение без знаков препинания режется по границе слова", () => {
    const long = Array.from({ length: 40 }, (_, i) => `слово${i}`).join(" ");
    const chunks = splitOverlongSentence(long, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50);
    expect(wordsOf(chunks.join(" "))).toEqual(wordsOf(long));
  });

  it("предложение в пределах бюджета не трогается", () => {
    const short = "Короткое предложение.";
    expect(splitOverlongSentence(short, 900)).toEqual([short]);
    expect(packSentencesNoTruncate(short, 900)).toEqual([short]);
  });

  it("пустой текст не порождает блоков", () => {
    expect(packSentencesNoTruncate("", 900)).toEqual([]);
    expect(packSentencesNoTruncate("   ", 900)).toEqual([]);
    expect(splitOverlongSentence("   ", 900)).toEqual([]);
  });

  it("наблюдавшийся случай: 916 знаков при бюджете 900", () => {
    // Форма ровно та, что пришла из резюме: одно предложение с точками с
    // запятой, чуть длиннее бюджета.
    const body =
      "Найдены материалы о семейных и деловых связях субъекта" +
      "; ".padEnd(2, " ") +
      "x".repeat(500) +
      "; " +
      "y".repeat(380);
    expect(body.length).toBeGreaterThan(900);
    for (const c of packSentencesNoTruncate(body, 900)) {
      expect(c.length).toBeLessThanOrEqual(900);
    }
  });
});
