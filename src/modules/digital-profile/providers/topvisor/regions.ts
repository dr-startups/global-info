/**
 * Индекс региона проекта Topvisor.
 *
 * История позиций адресует регионы **индексами проекта** (`regions_indexes`), и
 * индекс — не порядковый номер: у пилота Москва Яндекса — 1, Москва Google — 2,
 * а Дубай Google — **2520**. Чтение по `[1, 2, 3]` молча теряло Дубай вместе с
 * его AI-ответами. Индексы выдаёт сам проект (`get/projects_2/projects` с
 * `show_searchers_and_regions: 1`), и брать их можно только оттуда — по адресу
 * региона, каким он был добавлен.
 */

export type TopvisorRegionAddress = {
  searcher_key: number;
  region_key: number;
  region_lang: string;
  region_device: number;
};

type ProjectRegionRow = { key?: unknown; lang?: unknown; device?: unknown; index?: unknown };
type ProjectSearcherRow = { key?: unknown; regions?: unknown };

/** Индекс региона в проекте или `null`, если такого региона в проекте нет. */
export function projectRegionIndex(project: unknown, region: TopvisorRegionAddress): number | null {
  const searchers = (project as { searchers?: unknown } | null)?.searchers;
  if (!Array.isArray(searchers)) return null;
  for (const searcher of searchers as ProjectSearcherRow[]) {
    if (Number(searcher?.key) !== region.searcher_key) continue;
    if (!Array.isArray(searcher.regions)) continue;
    for (const row of searcher.regions as ProjectRegionRow[]) {
      const same =
        Number(row?.key) === region.region_key &&
        String(row?.lang ?? "") === region.region_lang &&
        Number(row?.device) === region.region_device;
      if (!same) continue;
      const index = Number(row.index);
      return Number.isFinite(index) ? index : null;
    }
  }
  return null;
}
