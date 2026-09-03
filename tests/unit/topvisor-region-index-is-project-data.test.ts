/**
 * Индекс региона Topvisor — данные проекта, а не порядковый номер.
 *
 * Пилот T0 читал историю позиций по `regions_indexes: [1, 2, 3]` и не получал
 * Дубай: у него индекс **2520**. Индексы выдаёт сам проект
 * (`get/projects_2/projects` с `show_searchers_and_regions: 1`), и брать их
 * можно только оттуда — по адресу региона, каким он был добавлен.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectRegionIndex } from "@/modules/digital-profile/providers/topvisor/regions";

const FIXTURE = join(
  process.cwd(),
  "src/modules/digital-profile/providers/topvisor/fixtures/probe-project-regions-indexes.json"
);

function project(): unknown {
  const body = JSON.parse(readFileSync(FIXTURE, "utf8")) as { result?: unknown[] };
  return body.result?.[0];
}

describe("индекс региона проекта Topvisor", () => {
  it("берётся из проекта по адресу региона", () => {
    const row = project();

    expect(projectRegionIndex(row, { searcher_key: 0, region_key: 213, region_lang: "ru", region_device: 0 })).toBe(1);
    expect(projectRegionIndex(row, { searcher_key: 1, region_key: 213, region_lang: "ru", region_device: 0 })).toBe(2);
    // Дубай — не третий: порядковый номер здесь ничего не значит.
    expect(projectRegionIndex(row, { searcher_key: 1, region_key: 11499, region_lang: "en", region_device: 0 })).toBe(2520);
  });

  it("незнакомый регион — null, а не «следующий по порядку»", () => {
    expect(projectRegionIndex(project(), { searcher_key: 1, region_key: 1, region_lang: "en", region_device: 0 })).toBeNull();
  });
});
