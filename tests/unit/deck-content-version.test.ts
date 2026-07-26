import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DECK_BUILDER_FINGERPRINT,
  DECK_CONTENT_VERSION,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/content-version";

/**
 * Шаг 15, E13.
 *
 * Секции деки кэшируются, и ключ кэша включает `DECK_CONTENT_VERSION`. Механизм
 * рабочий, но версия задаётся руками: изменив построитель и забыв поднять
 * строку, разработчик получает деку со старым текстом. Хуже того, это же
 * получает оператор, нажавший «Пересобрать отчёт» после исправления, — и решает,
 * что исправление не работает.
 *
 * Этот тест делает забывчивость невозможной: он сверяет отпечаток исходников
 * построителей с записанным. Разошлись — значит, построители изменились и
 * версию надо поднять.
 */

const BUILDERS_DIR = join(
  process.cwd(),
  "src/modules/digital-profile/orion-golden/deck-sections/fragment-builders"
);

/** Отпечаток исходников построителей: имя файла + содержимое, в порядке имён. */
function fingerprintBuilders(): string {
  const h = createHash("sha256");
  for (const name of readdirSync(BUILDERS_DIR).filter((f) => f.endsWith(".ts")).sort()) {
    h.update(name);
    h.update(readFileSync(join(BUILDERS_DIR, name)));
  }
  return h.digest("hex").slice(0, 16);
}

describe("версия содержимого деки не отстаёт от построителей", () => {
  it("отпечаток совпадает с записанным", () => {
    const actual = fingerprintBuilders();
    expect(
      actual,
      [
        "Построители секций изменились, а версия содержимого — нет.",
        "Кэш секций держится на этой строке: без подъёма правка не дойдёт",
        "ни до новой деки, ни до кнопки «Пересобрать отчёт».",
        "",
        `Сделайте два шага в content-version.ts:`,
        `  DECK_CONTENT_VERSION   = "${bumped(DECK_CONTENT_VERSION)}"`,
        `  DECK_BUILDER_FINGERPRINT = "${actual}"`,
      ].join("\n")
    ).toBe(DECK_BUILDER_FINGERPRINT);
  });

  it("версия названа так, как её ждёт кэш", () => {
    expect(DECK_CONTENT_VERSION).toMatch(/^deck-sections-v\d+$/u);
  });

  it("подсказка о следующей версии считается верно", () => {
    expect(bumped("deck-sections-v39")).toBe("deck-sections-v40");
    expect(bumped("deck-sections-v9")).toBe("deck-sections-v10");
  });
});

/** Следующий номер версии — чтобы подсказка была готовой к вставке. */
function bumped(version: string): string {
  return version.replace(/(\d+)$/u, (n) => String(Number(n) + 1));
}
