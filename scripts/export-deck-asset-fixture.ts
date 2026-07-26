/**
 * Экспорт фикстуры визуальных ассетов для `smoke:orion-deck-sections`.
 *
 * Смок проверяет самое ценное в сборке деки: доказательства слайда обязаны
 * лежать на видимых плитках снимка, а домены в тексте — присутствовать на
 * сетке. Для этого ему нужен `report-assets.json` канареечного прогона.
 *
 * Файл лежит под `/storage/`, а это приватные доказательства — в git им не
 * место. Поэтому смок молча зависел от диска одного разработчика и падал у
 * всех остальных с ENOENT.
 *
 * Здесь из прогона извлекается ровно то, что смоку нужно: связь ассета с
 * доказательствами и признак наличия изображения. **Байты изображений
 * отбрасываются** — они и есть та часть, которую нельзя коммитить, и смоку
 * они не нужны: он проверяет только `hasImage`.
 *
 * Запуск: npm run fixture:deck-assets -- <путь к report-assets.json>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DECK_ASSET_FIXTURE_PATH } from "./deck-asset-fixture-path";

/** Поля, которые смок читает; всё остальное в фикстуру не попадает. */
type FixtureEntry = {
  assetRef: string;
  kind: string;
  title: string;
  hasImage: boolean;
  evidenceRefs?: string[];
};

function main(): void {
  const source = process.argv[2];
  if (!source) {
    console.error(
      "Укажите путь к report-assets.json канареечного прогона.\n" +
        "Пример: npm run fixture:deck-assets -- storage/digital-profile/<case>/<run>/report-assets.json"
    );
    process.exit(2);
  }
  if (!existsSync(source)) {
    console.error(`Файл не найден: ${source}`);
    process.exit(2);
  }

  const parsed = JSON.parse(readFileSync(source, "utf8")) as
    | Array<Record<string, unknown>>
    | { assets: Array<Record<string, unknown>> };
  const assets = Array.isArray(parsed) ? parsed : parsed.assets;
  if (!Array.isArray(assets)) {
    console.error("Ожидался список ассетов или { assets: [...] }.");
    process.exit(2);
  }

  const fixture: FixtureEntry[] = assets.map((a) => {
    const entry: FixtureEntry = {
      assetRef: String(a.assetRef ?? ""),
      kind: String(a.kind ?? "visual"),
      title: String(a.title ?? a.assetRef ?? ""),
      // Байты не сохраняются: смоку нужен только факт наличия изображения.
      hasImage: Boolean(a.imageData) || Boolean(a.storageKey),
    };
    if (Array.isArray(a.evidenceRefs)) {
      entry.evidenceRefs = a.evidenceRefs.map((r) => String(r));
    }
    return entry;
  });

  const withoutRefs = fixture.filter((f) => !f.evidenceRefs?.length).length;
  mkdirSync(dirname(DECK_ASSET_FIXTURE_PATH), { recursive: true });
  writeFileSync(DECK_ASSET_FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

  console.log(`Записано ассетов: ${fixture.length} → ${DECK_ASSET_FIXTURE_PATH}`);
  if (withoutRefs > 0) {
    // Без evidenceRefs проверка «доказательства лежат на видимых плитках»
    // пропускается по своему же условию, то есть смок зеленеет впустую.
    console.warn(
      `ВНИМАНИЕ: у ${withoutRefs} ассетов нет evidenceRefs — соответствующие проверки смока не выполнятся.`
    );
  }
}

main();

export { join };
