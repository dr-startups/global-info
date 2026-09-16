import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTICLES } from "@/modules/site/content/articles";
import { SITE_PAGES, sitePage } from "@/modules/site/content/pages";
import { SERVICES } from "@/modules/site/content/services";
import { SITE_SHARE_IMAGE, pageMetadata, siteMetadata } from "@/modules/site/seo/metadata";

/**
 * У каждой страницы сайта свои `title` и `description`, canonical и превью для
 * соцсетей — из реестра контента, а не строкой в файле страницы.
 *
 * Файл страницы только называет свой адрес: `pageMetadata("/адрес")`. Так
 * заголовок, h1 и описание живут в одном месте с картой сайта, а тест сверяет
 * оба направления — страница без записи реестра и запись без страницы.
 * Ограничения длины — ТЗ 5.2: заголовок без «— Global Info» до 60 знаков,
 * описание до 160.
 */

const root = process.cwd();
const SITE_APP = join(root, "src/app/(site)");

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pageFiles(path);
    return name === "page.tsx" ? [path] : [];
  });
}

/** `(site)/uslugi/[slug]/page.tsx` → `/uslugi/[slug]`. Мастер проверки — не страница реестра. */
const routeOf = (file: string) => {
  const route = `/${relative(SITE_APP, file).replace(/\\/gu, "/").replace(/\/?page\.tsx$/u, "")}`;
  return route === "/" ? "/" : route.replace(/\/$/u, "");
};
const files = pageFiles(SITE_APP).filter((file) => !routeOf(file).startsWith("/check"));
const read = (file: string) => readFileSync(file, "utf8");

const DYNAMIC: Record<string, readonly string[]> = {
  "/uslugi/[slug]": SERVICES.map((s) => s.path),
  "/blog/[slug]": ARTICLES.map((a) => a.path),
};

describe("страницы сайта и реестр", () => {
  it("каждая страница — запись реестра, и у каждой записи есть страница", () => {
    const routes = files.flatMap((file) => DYNAMIC[routeOf(file)] ?? [routeOf(file)]);
    expect([...routes].sort()).toEqual(SITE_PAGES.map((page) => page.path).sort());
  });

  it("статическая страница берёт метаданные у реестра по своему адресу", () => {
    for (const file of files) {
      const route = routeOf(file);
      if (DYNAMIC[route]) continue;
      expect(read(file), route).toContain(`export const metadata: Metadata = pageMetadata("${route}");`);
    }
  });

  it("страница с параметром перечисляет адреса при сборке, чужие отдают 404 и метаданные — из реестра", () => {
    for (const file of files) {
      const route = routeOf(file);
      if (!DYNAMIC[route]) continue;
      const text = read(file);
      expect(text, route).toMatch(/export (async )?function generateStaticParams\(/u);
      // 404 чужого адреса — notFound(), а не dynamicParams = false: с ним Next 15.5 пишет
      // в лог «Error: Internal: NoFallbackError» со стеком на каждый такой запрос.
      expect(text, route).not.toMatch(/export const dynamicParams/u);
      expect((text.match(/notFound\(\);/gu) ?? []).length, route).toBe(2);
      expect(text, route).toMatch(/export async function generateMetadata\([\s\S]*pageMetadata\(/u);
    }
  });
});

describe("метаданные", () => {
  it("заголовок до 60 знаков, описание до 160, без плейсхолдеров", () => {
    for (const page of SITE_PAGES) {
      expect(page.title.length, page.path).toBeLessThanOrEqual(60);
      expect(page.description.length, page.path).toBeLessThanOrEqual(160);
      expect(page.description.length, page.path).toBeGreaterThanOrEqual(50);
      expect(`${page.title} ${page.description}`, page.path).not.toMatch(/\{\{/u);
    }
  });

  it("заголовки и описания не повторяются между страницами", () => {
    expect(new Set(SITE_PAGES.map((p) => p.title)).size).toBe(SITE_PAGES.length);
    expect(new Set(SITE_PAGES.map((p) => p.description)).size).toBe(SITE_PAGES.length);
  });

  it("canonical, Open Graph и карточка соцсетей — из той же записи", () => {
    for (const page of SITE_PAGES) {
      const meta = pageMetadata(page.path);
      const title = page.absoluteTitle ? { absolute: page.title } : page.title;
      expect(meta.title, page.path).toEqual(title);
      expect(meta.description, page.path).toBe(page.description);
      expect(meta.alternates?.canonical, page.path).toBe(page.path);
      expect(meta.openGraph, page.path).toMatchObject({
        url: page.path,
        title: page.title,
        description: page.description,
        siteName: "Global Info",
        locale: "ru_RU",
      });
      expect(meta.twitter, page.path).toMatchObject({ card: "summary_large_image", title: page.title });
    }
  });

  it("статья в Open Graph — article с датами публикации и обновления", () => {
    for (const article of ARTICLES) {
      expect(pageMetadata(article.path).openGraph, article.path).toMatchObject({
        type: "article",
        publishedTime: article.published,
        modifiedTime: article.updated,
      });
    }
    expect(pageMetadata("/uslugi").openGraph).toMatchObject({ type: "website" });
  });

  it("у главной заголовок целиком, без шаблона «— Global Info»", () => {
    expect(sitePage("/").absoluteTitle).toBe(true);
    expect(sitePage("/").title).toMatch(/Global Info$/u);
    for (const page of SITE_PAGES.filter((p) => p.path !== "/")) {
      expect(page.absoluteTitle, page.path).toBeFalsy();
      expect(page.title, page.path).not.toMatch(/Global Info$/u);
    }
  });

  it("неизвестный адрес — ошибка сборки, а не страница без заголовка", () => {
    expect(() => pageMetadata("/nope")).toThrow();
  });
});

describe("файлы метаданных сайта", () => {
  const png = (path: string) => {
    const buf = readFileSync(join(root, path));
    expect(buf.subarray(1, 4).toString("latin1"), path).toBe("PNG");
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  };

  it("картинка превью 1200×630 — у каждой страницы явно, а не файлом группы маршрутов", () => {
    // Файл opengraph-image.png в (site) Next подставляет только своему сегменту: у вложенных
    // страниц своя запись openGraph заменяла унаследованную, и превью было только у главной.
    expect(png(`public${SITE_SHARE_IMAGE.url}`)).toEqual({ width: 1200, height: 630 });
    expect(SITE_SHARE_IMAGE.alt.trim()).not.toBe("");
    expect(existsSync(join(root, "src/app/(site)/opengraph-image.png"))).toBe(false);
    expect(siteMetadata({}).openGraph).toMatchObject({ images: [SITE_SHARE_IMAGE] });
    for (const page of SITE_PAGES) {
      expect(pageMetadata(page.path).openGraph, page.path).toMatchObject({ images: [SITE_SHARE_IMAGE] });
      expect(pageMetadata(page.path).twitter, page.path).toMatchObject({ images: [SITE_SHARE_IMAGE.url] });
    }
  });

  it("значки: favicon.ico, icon.png 512×512, apple-icon.png 180×180 в корне app", () => {
    const ico = readFileSync(join(root, "src/app/favicon.ico"));
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(png("src/app/icon.png")).toEqual({ width: 512, height: 512 });
    expect(png("src/app/apple-icon.png")).toEqual({ width: 180, height: 180 });
  });

  it("манифест из корня app называет сайт, цвет темы и значок", async () => {
    expect(existsSync(join(root, "src/app/manifest.ts"))).toBe(true);
    const { siteManifest } = await import("@/modules/site/seo/manifest");
    const manifest = siteManifest();
    expect(manifest).toMatchObject({ name: "Global Info", start_url: "/", lang: "ru" });
    expect(manifest.theme_color).toBe("#F5F5F2");
    expect(manifest.icons?.map((i) => i.src)).toEqual(expect.arrayContaining(["/icon.png"]));
  });
});
