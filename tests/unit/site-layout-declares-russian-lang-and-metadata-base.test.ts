import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { siteMetadata } from "@/modules/site/seo/metadata";

/**
 * Корневой layout общий для сайта и админки и потому пустой: язык документа и
 * `<body>`. Шапка админки и `globals.css` живут в layout админки — `globals.css`
 * ставит `html { font-size: 14px }`, и в корне все `rem` сайта считались бы от
 * 14 px. Сайт объявляет базу адресов и шаблон заголовка у себя.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("корневой layout", () => {
  const text = read("src/app/layout.tsx");

  it("документ на русском", () => {
    expect(text).toMatch(/<html lang="ru"/u);
  });

  it("ни стилей админки, ни её шапки", () => {
    expect(text).not.toMatch(/globals\.css/u);
    expect(text).not.toMatch(/dp-topbar|dp-container/u);
    expect(text).not.toMatch(/site-header|site\.css/u);
  });

  it("стили и шапка админки — в layout админки", () => {
    const admin = read("src/app/admin/layout.tsx");
    expect(admin).toMatch(/import "\.\.\/globals\.css";/u);
    expect(admin).toMatch(/dp-topbar/u);
  });

  it("редиректа с главной в админку больше нет — главная принадлежит сайту", () => {
    expect(() => read("src/app/page.tsx")).toThrow();
  });
});

describe("метаданные сайта", () => {
  it("база адресов — SITE_PUBLIC_ORIGIN, по умолчанию стенд", () => {
    expect(siteMetadata({}).metadataBase?.href).toBe("http://localhost:3000/");
    expect(siteMetadata({ SITE_PUBLIC_ORIGIN: "https://example.test" }).metadataBase?.href).toBe(
      "https://example.test/"
    );
  });

  it("шаблон заголовка «%s — Global Info» и заголовок по умолчанию не длиннее 60 знаков", () => {
    const { title, description } = siteMetadata({});
    expect(title).toMatchObject({ template: "%s — Global Info" });
    const byDefault = (title as { default: string }).default;
    expect(byDefault.length).toBeLessThanOrEqual(60);
    expect(byDefault).toMatch(/Global Info/u);
    expect(String(description).length).toBeGreaterThan(0);
    expect(String(description).length).toBeLessThanOrEqual(160);
  });

  it("коды вебмастеров — из настроек как есть; пустые не печатаются", () => {
    expect(siteMetadata({}).verification).toBeUndefined();
    expect(siteMetadata({ SITE_YANDEX_VERIFICATION: "a1B2c3", SITE_GOOGLE_VERIFICATION: "Zx-9_y" }).verification).toEqual({
      yandex: "a1B2c3",
      google: "Zx-9_y",
    });
    expect(siteMetadata({ SITE_GOOGLE_VERIFICATION: "Zx-9_y" }).verification).toEqual({ google: "Zx-9_y" });
  });

  it("адрес, индексация и коды вебмастеров доходят до сборки образа", () => {
    // Страницы сайта пререндерятся при next build, и эти значения запекаются в HTML.
    // Railway передаёт переменные сервиса в сборку Docker только объявленным ARG — без
    // них canonical на площадке указывал бы на localhost, а индексация не открылась бы.
    const dockerfile = read("Dockerfile");
    const build = dockerfile.indexOf("RUN npm run build");
    expect(build).toBeGreaterThan(0);
    for (const name of ["SITE_PUBLIC_ORIGIN", "SITE_INDEXING_ENABLED", "SITE_YANDEX_VERIFICATION", "SITE_GOOGLE_VERIFICATION"]) {
      const arg = dockerfile.indexOf(`ARG ${name}`);
      expect(arg, name).toBeGreaterThan(dockerfile.indexOf("FROM base AS build"));
      expect(arg, name).toBeLessThan(build);
    }
  });

  it("layout сайта объявляет эти метаданные и свои стили", () => {
    const site = read("src/app/(site)/layout.tsx");
    expect(site).toMatch(/export const metadata(: Metadata)? = siteMetadata\(\);/u);
    expect(site).toMatch(/import "\.\/site\.css";/u);
  });
});
