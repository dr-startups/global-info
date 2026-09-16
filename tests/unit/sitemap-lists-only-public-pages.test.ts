import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_PAGES } from "@/modules/site/content/pages";
import { siteSitemap } from "@/modules/site/seo/sitemap";

/**
 * Карта сайта перечисляет публичные страницы реестра контента — и только их.
 *
 * Мастер проверки несёт имя конкретного человека, админка и API — не страницы для
 * поиска: в карту они не попадают ни при каком режиме. Пока индексация закрыта,
 * карта пуста — иначе она раздавала бы адреса стенда. `lastModified` — дата
 * обновления текста, а не время сборки: иначе каждая пересборка объявляла бы все
 * страницы изменёнными.
 */

const ORIGIN = "https://global-info.example";
const OPEN = { SITE_INDEXING_ENABLED: "true", SITE_PUBLIC_ORIGIN: ORIGIN };

describe("карта сайта", () => {
  it("пуста, пока индексация закрыта", () => {
    expect(siteSitemap({})).toEqual([]);
    expect(siteSitemap({ SITE_INDEXING_ENABLED: "true" })).toEqual([]);
  });

  it("при открытой индексации — ровно страницы реестра, абсолютными адресами сайта", () => {
    const urls = siteSitemap(OPEN).map((entry) => entry.url);
    expect(urls).toEqual(SITE_PAGES.map((page) => new URL(page.path, ORIGIN).href));
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) expect(url.startsWith(`${ORIGIN}/`), url).toBe(true);
  });

  it("мастер проверки, админка и API в карту не попадают", () => {
    for (const url of siteSitemap(OPEN).map((entry) => new URL(entry.url).pathname)) {
      expect(url, url).not.toMatch(/^\/(check|admin|api)(\/|$)/u);
    }
  });

  it("в карте есть все разделы карты страниц ТЗ 5.1", () => {
    const paths = siteSitemap(OPEN).map((entry) => new URL(entry.url).pathname);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/",
        "/uslugi",
        "/uslugi/poisk-negativa",
        "/uslugi/udalenie-iz-poiskovoy-vydachi",
        "/uslugi/pravo-na-zabvenie",
        "/uslugi/udalenie-negativa-iz-interneta",
        "/voprosy",
        "/o-proekte",
        "/kontakty",
        "/blog",
        "/blog/chto-o-vas-est-v-internete",
        "/legal/politika-konfidencialnosti",
        "/legal/soglasie",
        "/legal/usloviya",
      ])
    );
    expect(paths.filter((path) => path.startsWith("/blog/"))).toHaveLength(6);
  });

  it("дата изменения — дата обновления страницы в реестре, и от сборки к сборке она та же", () => {
    const entries = siteSitemap(OPEN);
    entries.forEach((entry, i) => {
      expect(entry.lastModified).toBe(SITE_PAGES[i]!.updated);
      expect(String(entry.lastModified)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    });
    expect(siteSitemap(OPEN)).toEqual(entries);
  });

  it("sitemap.xml отдаёт маршрут Next из корня app, а ответ берёт у сайта", () => {
    const path = join(process.cwd(), "src/app/sitemap.ts");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toMatch(/siteSitemap\(\)/u);
  });
});
