/**
 * Событие читается в обработчике, а не в обновителе состояния.
 *
 * QA MVP 14.09.2026, вкладка «Комплаенс-базы»: одна буква в поле описания
 * снимка обрушивала страницу дела целиком — `Cannot read properties of null
 * (reading 'value')`. Обработчик передавал в `setState` функцию, а функция
 * читала `e.currentTarget` уже после того, как React закончил раздачу события
 * и обнулил `currentTarget`: в React 19 обновитель выполняется при рендере,
 * исключение в рендере без границы ошибок размонтирует корень.
 *
 * DOM-окружения у батареи нет, поэтому проверяется форма кода: внутри
 * обновителя `setX((prev) => …)` нет чтения `currentTarget` или `target`
 * события. Тот же приём с `e.target` сегодня не падает — но это та же форма,
 * и завтра она падает так же.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT = join(process.cwd(), "src/modules/digital-profile/client");

const UPDATER_HEAD = /\bset[A-Z]\w*\(\s*\(\s*\w+\s*\)\s*=>/gu;

/** Текст обновителя целиком — от `setX(` до закрывающей скобки вызова. */
function updaterBody(source: string, headIndex: number): string {
  const open = source.indexOf("(", headIndex);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function lateEventReads(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(CLIENT).filter((f) => f.endsWith(".tsx"))) {
    const source = readFileSync(join(CLIENT, file), "utf8");
    for (const m of source.matchAll(UPDATER_HEAD)) {
      const body = updaterBody(source, m.index ?? 0);
      if (/\b(currentTarget|target)\.(value|checked|files)\b/u.test(body)) {
        out.push(`${file}:${lineOf(source, m.index ?? 0)}: ${body.replace(/\s+/gu, " ").slice(0, 90)}`);
      }
    }
  }
  return out;
}

describe("событие читается до обновителя состояния", () => {
  it("ни один обновитель setX((prev) => …) в клиенте не читает currentTarget/target события", () => {
    expect(lateEventReads()).toEqual([]);
  });
});
