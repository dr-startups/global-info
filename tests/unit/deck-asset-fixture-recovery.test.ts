import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  buildFixtureFromBindings,
  readRecordedAssetBindings,
} from "../../scripts/rebuild-deck-asset-fixture-from-baseline";
import { DECK_ASSET_FIXTURE_PATH } from "../../scripts/deck-asset-fixture-path";

/**
 * Шаг 16, E11.
 *
 * `smoke:orion-deck-sections` пропускал семь проверок: метаданные визуальных
 * ассетов report-72 лежали под `/storage/` и утрачены, а подкладывать ассеты
 * другого субъекта нельзя — смок проверял бы одно на данных другого.
 *
 * Утрачены байты, но привязка записана: пакеты секций в `baselines/` собраны тем
 * самым прогоном. Вход восстанавливается из них, а проверяется записанным
 * выходом — объяснениями рамок и колонтитулом, которые сборка обязана повторить.
 */

describe("привязка ассетов восстанавливается из собственных пакетов report-72", () => {
  const bindings = readRecordedAssetBindings();

  it("записаны все шестнадцать слотов со снимками", () => {
    expect(bindings.size).toBe(16);
    expect([...bindings.keys()]).toContain("p10_ru_serp_visual");
    expect([...bindings.keys()]).toContain("p31_uae_knowledge");
  });

  it("у страницы снимка записаны два ассета и её доказательства", () => {
    const slide = bindings.get("p10_ru_serp_visual");
    expect(slide?.visualAssetRefs).toHaveLength(2);
    expect((slide?.evidenceRefs ?? []).length).toBeGreaterThan(20);
  });

  it("фикстура повторяет записанные ссылки, ничего не выдумывая", () => {
    const fixture = buildFixtureFromBindings(bindings);
    const recorded = new Set(
      [...bindings.values()].flatMap((s) => s.visualAssetRefs ?? [])
    );
    expect(new Set(fixture.map((f) => f.assetRef))).toEqual(recorded);
    // Каждому ассету достались доказательства слайда — иначе проверки «плитки»
    // молчали бы по внутреннему условию.
    expect(fixture.every((f) => (f.evidenceRefs ?? []).length > 0)).toBe(true);
    expect(fixture.every((f) => f.hasImage)).toBe(true);
  });

  it("восстановленная фикстура лежит в репозитории и совпадает с построенной", () => {
    // Если файл разойдётся с построителем, смок будет проверять не то, что мы
    // думаем. Пересобрать: npm run fixture:deck-assets:rebuild
    expect(existsSync(DECK_ASSET_FIXTURE_PATH)).toBe(true);
    const onDisk = JSON.parse(readFileSync(DECK_ASSET_FIXTURE_PATH, "utf8"));
    expect(onDisk).toEqual(buildFixtureFromBindings(bindings));
  });

  it("байты изображений в фикстуру не попадают", () => {
    // Единственное, что действительно нельзя коммитить.
    const raw = readFileSync(DECK_ASSET_FIXTURE_PATH, "utf8");
    expect(raw).not.toMatch(/imageData|storageKey|base64/u);
  });
});
