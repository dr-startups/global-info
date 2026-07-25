import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Шаг 09 плана (docs/rework/09-test-and-ci-foundation.md).
 *
 * Пять файлов были написаны под встроенный раннер `node:test`. Vitest такие
 * сьюты не собирает и сообщает «No test suite found» — то есть 16 проверок
 * не исполнялись неизвестно сколько времени, при том что покрывали маппинг
 * региона UAE, лечение composite-merge и ремап sibling-прогонов, вокруг
 * которых крутились последние коммиты ветки.
 *
 * Этот тест не даёт появиться шестому такому файлу.
 */

const UNIT_DIR = join(process.cwd(), "tests/unit");

describe("единый раннер тестов", () => {
  it("ни один тест не импортирует node:test", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(UNIT_DIR)) {
      if (!file.endsWith(".test.ts")) continue;
      const text = readFileSync(join(UNIT_DIR, file), "utf8");
      if (/from\s+["']node:test["']/u.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("каждый файл с тестами объявляет хотя бы один describe", () => {
    const empty: string[] = [];
    for (const file of readdirSync(UNIT_DIR)) {
      if (!file.endsWith(".test.ts")) continue;
      const text = readFileSync(join(UNIT_DIR, file), "utf8");
      if (!/\bdescribe\s*\(/u.test(text)) empty.push(file);
    }
    expect(empty).toEqual([]);
  });
});
