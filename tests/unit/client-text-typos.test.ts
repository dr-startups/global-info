import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
