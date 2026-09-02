/**
 * Доли пятиколоночной таблицы выдачи в рендерере и колонки построителя — одно
 * и то же, и связывает их только эта проверка.
 *
 * Ширины живут в `visual.py`, заголовки — в `serp.ts`, и типы между ними не
 * ходят. Прежняя пятиколоночная ветка несла доли той самой выдачи, у которой
 * адрес не открывался (`[0.05, 0.22, 0.44, 0.15, 0.14]`): 22 % — это 229 px
 * полезных, куда входит 62 знака. Пятиколоночный вход с такими долями
 * нарисовался бы без единой жалобы, поэтому доли проверяются числами, а не
 * подразумеваются.
 *
 * Числа померены `_wrapped_line_count` на корпусе эталона-72: при 0.34 адрес
 * ложится в 1…3 строки у 45 строк из 46, при 0.27 заголовок предельной длины —
 * не больше пяти строк, «Энциклопедия / справочник» при 0.20 и
 * «● Нежелательный» при 0.14 занимают по одной строке.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SERP_EXTRA_TABLE_HEADERS,
  SERP_TABLE_HEADERS,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";

const VISUAL_PY = join(process.cwd(), "renderer/orion_golden_render/visual.py");

/** Доли ветки первой таблицы — из самого рендерера, а не копией здесь. */
function fiveColumnShares(): number[] {
  const source = readFileSync(VISUAL_PY, "utf8");
  const branch = /elif cols == 5 and re\.search\(\s*r"([^"]+)",\s*str\(headers\[0\]\)[\s\S]*?prop = \[([^\]]+)\]/u.exec(
    source
  );
  if (!branch) {
    throw new Error(
      `в ${VISUAL_PY} не найдена ветка ширин первой таблицы выдачи — ` +
        "таблица пятиколоночная, и без этой ветки её рисовать нечем"
    );
  }
  return branch[2]!.split(",").map((x) => Number(x.trim()));
}

/** Признак, по которому рендерер отличает первую таблицу выдачи от второй. */
function firstTablePattern(): RegExp {
  const source = readFileSync(VISUAL_PY, "utf8");
  const branch = /elif cols == 5 and re\.search\(\s*r"([^"]+)",\s*str\(headers\[0\]\)/u.exec(source);
  if (!branch) throw new Error(`в ${VISUAL_PY} не найден признак ветки первой таблицы выдачи`);
  return new RegExp(branch[1]!, "iu");
}

/** Доли второй таблицы — общая ветка на пять колонок, идущая следом. */
function extraTableShares(): number[] {
  const source = readFileSync(VISUAL_PY, "utf8");
  const branch = /elif cols == 5:[\s\S]*?prop = \[([^\]]+)\]/u.exec(source);
  if (!branch) {
    throw new Error(
      `в ${VISUAL_PY} не найдена ветка ширин второй таблицы выдачи — ` +
        "без неё она молча получила бы ширины первой"
    );
  }
  return branch[1]!.split(",").map((x) => Number(x.trim()));
}

describe("ветка пяти колонок в рендерере", () => {
  it("столько долей, сколько колонок печатает построитель", () => {
    expect(SERP_TABLE_HEADERS).toHaveLength(5);
    expect(fiveColumnShares()).toHaveLength(SERP_TABLE_HEADERS.length);
  });

  it("доли в сумме дают ширину контента, а не её часть", () => {
    const sum = fiveColumnShares().reduce((a, b) => a + b, 0);
    expect(Number(sum.toFixed(6))).toBe(1);
  });

  it("колонке адреса отдана выведенная замером доля, а не прежние 22 %", () => {
    const shares = fiveColumnShares();
    expect(shares[SERP_TABLE_HEADERS.indexOf("Ссылка")]).toBe(0.34);
    expect(shares).toEqual([0.05, 0.34, 0.27, 0.2, 0.14]);
  });
});

describe("вторая таблица выдачи получает свои ширины, а не ширины первой", () => {
  it("рендерер отличает таблицы по колонке, которой у второй нет вовсе", () => {
    // Признак завязан на «№»: у второй таблицы колонки позиции нет по решению
    // владельца, и это самый устойчивый признак в партии.
    expect(firstTablePattern().test(SERP_TABLE_HEADERS[0]!)).toBe(true);
    expect(firstTablePattern().test(SERP_EXTRA_TABLE_HEADERS[0]!)).toBe(false);
    expect(SERP_EXTRA_TABLE_HEADERS).not.toContain("№");
  });

  it("столько долей, сколько колонок, и в сумме — ширина контента", () => {
    const shares = extraTableShares();
    expect(shares).toHaveLength(SERP_EXTRA_TABLE_HEADERS.length);
    expect(Number(shares.reduce((a, b) => a + b, 0).toFixed(6))).toBe(1);
  });

  it("колонка запроса шире плановых 14 %: при них лист теряет строку", () => {
    const shares = extraTableShares();
    expect(shares[SERP_EXTRA_TABLE_HEADERS.indexOf("Найдено по запросу")]).toBe(0.16);
    expect(shares[SERP_EXTRA_TABLE_HEADERS.indexOf("Ссылка")]).toBe(0.3);
    expect(shares).toEqual([0.3, 0.2, 0.16, 0.2, 0.14]);
  });
});
