/**
 * Карта сайта — страницы реестра и только они.
 *
 * Пока индексация закрыта, карта пуста: иначе она раздавала бы адреса стенда.
 * `lastModified` — дата изменения текста из реестра, а не время сборки: иначе
 * каждая пересборка объявляла бы изменёнными все страницы.
 */

import type { MetadataRoute } from "next";
import { SITE_PAGES } from "@/modules/site/content/pages";
import { siteIndexing } from "./indexing";

export function siteSitemap(env: Record<string, string | undefined> = process.env): MetadataRoute.Sitemap {
  const indexing = siteIndexing(env);
  if (!indexing.open) return [];
  return SITE_PAGES.map((page) => ({
    url: new URL(page.path, indexing.origin).href,
    lastModified: page.updated,
  }));
}
