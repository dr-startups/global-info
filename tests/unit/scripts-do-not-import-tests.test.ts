/**
 * Смоки живут в `scripts/` и едут в образ — а `tests/` в образ не едет.
 *
 * `.dockerignore` исключает `tests` намеренно: правки эталонов иначе
 * инвалидировали бы `COPY . .`, а с ним `prisma generate` и `next build`.
 * Поэтому импорт из `tests/` в `scripts/` ломает **только** сборку на Railway:
 * локально каталог на месте, и `npm run build` проходит зелёным.
 *
 * Так и случилось 03.09.2026: смок объединённого сбора взял помощник
 * `tests/support/topvisor-fixture-call`, локальная батарея этого не увидела, а
 * деплой упал на `Cannot find module '../tests/support/topvisor-fixture-call'`.
 * Прибор дешевле, чем ещё один упавший деплой.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPTS = join(process.cwd(), "scripts");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Ссылки на `tests/` в любом виде: относительной, из корня, через алиас. */
const TESTS_IMPORT = /from\s+["'][^"']*(?:^|\/|\.\.\/)tests\//;

describe("scripts не зависят от tests", () => {
  const files = tsFiles(SCRIPTS);

  it("файлы находятся", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.replace(`${process.cwd()}/`, "")]))(
    "%s не импортирует из tests/",
    (relative) => {
      const text = readFileSync(join(process.cwd(), relative), "utf8");
      const offenders = text
        .split("\n")
        .filter((line) => TESTS_IMPORT.test(line))
        .map((line) => line.trim());

      expect(offenders).toEqual([]);
    }
  );
});
