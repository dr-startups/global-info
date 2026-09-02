/**
 * Офлайн-контур не требует Python.
 *
 * `CLAUDE.md`: «`npm run ci` **обязан** проходить на чистой машине: без сети,
 * без базы, без рендерера». Прогон под `PATH` без Python это опровергал: смоки
 * `client-text-contract` и `orion-deck-sections` звали интерпретатор
 * безусловно и падали вместе со всем контуром (пункт BR бэклога).
 *
 * Проверка статическая, потому что настоящую машину без Python в юните не
 * изобразить: `findPythonInterpreter` спрашивает `$PYTHON`, `python3` и
 * `python`, и подменить их изнутри процесса значило бы проверять подмену.
 * Зато форма обращения проверяется надёжно: бросающий вариант и зашитое имя
 * интерпретатора — это и есть два способа уронить контур.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SMOKES } from "../../scripts/run-smokes";

/**
 * Код без комментариев: проверка смотрит на вызовы, а не на прозу. Иначе
 * объяснение «раньше звали бросающий вариант» само роняло бы проверку.
 */
function codeOf(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

/** Смоки уровня offline, которые запускаются node/tsx, а не самим Python. */
const OFFLINE_TS_SMOKES = SMOKES.filter((s) => s.tier === "offline" && s.argv[0] === "tsx");

describe("офлайн-смоки на машине без Python", () => {
  it("список смоков берётся из раннера, а не переписан рядом", () => {
    // Копия списка разошлась бы с настоящим на первом же новом смоке.
    expect(OFFLINE_TS_SMOKES.length).toBeGreaterThan(0);
    expect(OFFLINE_TS_SMOKES.map((s) => s.name)).toContain("client-text-contract");
    expect(OFFLINE_TS_SMOKES.map((s) => s.name)).toContain("orion-deck-sections");
  });

  it.each(OFFLINE_TS_SMOKES.map((s) => [s.name, s.argv[s.argv.length - 1]!] as const))(
    "%s не роняет контур из-за интерпретатора",
    (_name, script) => {
      const src = codeOf(script);
      // Бросающий вариант: отсутствие Python становится падением смока.
      expect(src).not.toMatch(/\bpythonInterpreter\s*\(/u);
      // Зашитое имя: третий ответ на вопрос «где Python», мимо общего поиска.
      expect(src).not.toMatch(/["']python3?["']/u);
      expect(src).not.toMatch(/process\.env\.PYTHON\s*\|\|/u);
    }
  );

  it("смок, которому Python нужен, объявляет пропуск словами", () => {
    for (const smoke of OFFLINE_TS_SMOKES) {
      const script = smoke.argv[smoke.argv.length - 1]!;
      const src = codeOf(script);
      if (!src.includes("findPythonInterpreter")) continue;
      const withComments = readFileSync(join(process.cwd(), script), "utf8");
      // Пропуск обязан попасть в сводку раннера — иначе «не проверяли»
      // неотличимо от «проверено».
      expect(withComments).toMatch(/# SKIP|skippedForAssets/u);
      expect(withComments).toMatch(/интерпретатор/iu);
    }
  });
});
