import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  sourceLine,
  clientReadableUrl,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

/**
 * Клиентский текст читают банки и контрагенты; склеенные слова в нём
 * обесценивают документ. «наличиеждение» (склейка «наличие» + «подтверждение»)
 * доехало до PDF и обнаружилось только чтением готового отчёта.
 *
 * Тест дешёвый и ловит целый класс опечаток в шаблонах.
 */

const ROOT = join(process.cwd(), "src/modules/digital-profile");

/** Склейки, уже встречавшиеся в отчётах, плюс типовые кандидаты. */
const KNOWN_TYPOS = [
  "наличиеждение",
  "требуетсяние",
  "подтверждениеие",
  "материалыы",
  "источникик",
];

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* tsFiles(full);
      continue;
    }
    if (full.endsWith(".ts") || full.endsWith(".tsx")) yield full;
  }
}

describe("клиентские текстовые шаблоны", () => {
  it("не содержат известных склеек слов", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const typo of KNOWN_TYPOS) {
        if (text.includes(typo)) {
          offenders.push(`${file.replace(process.cwd() + "/", "")}: ${typo}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("строка источников заканчивается ровно одной точкой", () => {
    /*
     * В отчёте боевого прогона 28.07 на трёх страницах стояло
     * «…и ещё 2.. Данные собраны 28.07.2026»: точку приписывали к строке,
     * которая ей уже заканчивалась, а следующее предложение оставляли без
     * точки вовсе. Проверяем результат склейки, а не способ.
     */
    const freshness = { earliestAt: "2026-07-28T06:00:00.000Z", latestAt: "2026-07-28T06:00:00.000Z" };
    const line = sourceLine(
      { findings: [], evidenceIndex: {} } as never,
      { materialFreshness: freshness } as never
    );
    expect(line).not.toMatch(/\.\.(?!\.)/u);
    expect(line.trim()).toMatch(/[.!?…»)]$/u);
    expect(line).toContain("Данные собраны");
  });

  it("ссылка в клиентском тексте читается человеком, а не машиной", () => {
    /*
     * В отчёте боевого прогона стояло «статья найдена —
     * https://ru.wikipedia.org/wiki/%D0%94%D1%83%D1%80%D0%BE%D0%B2».
     */
    expect(clientReadableUrl("https://ru.wikipedia.org/wiki/%D0%94%D1%83%D1%80%D0%BE%D0%B2")).toBe(
      "https://ru.wikipedia.org/wiki/Дуров"
    );
    // Уже читаемый адрес не портится.
    expect(clientReadableUrl("https://bbc.com/news/article")).toBe("https://bbc.com/news/article");
    // Битую последовательность показываем как есть, а не теряем ссылку.
    expect(clientReadableUrl("https://example.com/%E0%A4%A")).toBe("https://example.com/%E0%A4%A");
  });

  it("не содержат удвоенных пробелов внутри русских строковых шаблонов", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(ROOT)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        // Только строки с кириллицей внутри кавычек/бэктиков.
        if (!/["'`][^"'`]*[А-Яа-яЁё][^"'`]*["'`]/u.test(line)) continue;
        if (/[А-Яа-яЁё]  +[А-Яа-яЁё]/u.test(line)) {
          offenders.push(`${file.replace(process.cwd() + "/", "")}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
