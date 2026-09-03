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

/**
 * Регионы аудита — один ответ для тика, проекта и пилота.
 *
 * Ключи — из справочника самого Topvisor (пилот T0, `get/system_2/common/
 * regions`): «Москва» у Яндекса и Google — `213`, Дубай у Google — `11499`;
 * с ключами Arsenkin они не совпадают. Глубина Google `2` — это ТОП-20, ровно
 * то, что обещает клиенту таблица выдачи; у Яндекса первая ступень уже глубже
 * двадцати (снимок приходит на 50 при любом `depth_positions`), и ТОП-20
 * режет адаптер.
 *
 * Имя провайдера несёт движок намеренно: `rankInOneScale` и
 * `ENGINE_RANK_SOURCE` узнают «yandex»/«google» подстрокой, и позиционные
 * таблицы берут номера Topvisor без правки этих двух мест.
 */
export type TopvisorAuditRegion = TopvisorRegionAddress & {
  key: "yandex-moscow" | "google-moscow" | "google-dubai";
  region_depth: number;
  engine: "YANDEX" | "GOOGLE";
  region: "RU" | "UAE";
};

export const TOPVISOR_AUDIT_REGIONS: readonly TopvisorAuditRegion[] = [
  { key: "yandex-moscow", searcher_key: 0, region_key: 213, region_lang: "ru", region_device: 0, region_depth: 1, engine: "YANDEX", region: "RU" },
  { key: "google-moscow", searcher_key: 1, region_key: 213, region_lang: "ru", region_device: 0, region_depth: 2, engine: "GOOGLE", region: "RU" },
  { key: "google-dubai", searcher_key: 1, region_key: 11499, region_lang: "en", region_device: 0, region_depth: 2, engine: "GOOGLE", region: "UAE" },
] as const;

export function topvisorProviderName(engine: "YANDEX" | "GOOGLE"): "topvisor-yandex" | "topvisor-google" {
  return engine === "YANDEX" ? "topvisor-yandex" : "topvisor-google";
}
