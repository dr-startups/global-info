import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPageMetadata } from "@/modules/site/seo/metadata";

/**
 * Страницы сайта пререндерятся при `next build`, а мастер проверки — нет.
 *
 * CI собирает приложение без базы: страница сайта, которая на сборке тянет
 * Prisma или серверный сервис проверки, роняет `npm run build`, а на площадке
 * превращает статическую страницу в запрос к базе на каждый показ. Мастер
 * получает данные только через `/api/self-check/*` и в поиск не попадает.
 */

const root = process.cwd();
const SITE_APP = join(root, "src/app/(site)");
const SITE_MODULE = join(root, "src/modules/site");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}

const rel = (path: string) => relative(root, path).replace(/\\/gu, "/");
const read = (path: string) => readFileSync(path, "utf8");
const imports = (text: string) => [...text.matchAll(/from\s+"([^"]+)"/gu)].map((m) => m[1]!);

/** Что сайт не импортирует: база и серверная часть проверки. */
const SERVER_ONLY = [
  /^@prisma\/client$/u,
  /^@\/server\/prisma/u,
  /^@\/modules\/self-check\/(service|http|light-run|quotas|captcha|token|verdict|public-dto)$/u,
  /^@\/modules\/digital-profile\/services\//u,
  /^next\/headers$/u,
];

const CHECK_PAGE = "src/app/(site)/check/[publicId]/page.tsx";

describe("страницы сайта", () => {
  it("есть лендинг, мастер и страницы отказов создания", () => {
    for (const page of [
      "src/app/(site)/layout.tsx",
      "src/app/(site)/page.tsx",
      CHECK_PAGE,
      "src/app/(site)/check/limit/page.tsx",
      "src/app/(site)/check/disabled/page.tsx",
    ]) {
      expect(existsSync(join(root, page)), page).toBe(true);
    }
  });

  it("ни один файл сайта не тянет базу и серверную часть проверки", () => {
    const all = [...files(SITE_APP), ...files(SITE_MODULE)];
    expect(all.length).toBeGreaterThan(10);
    for (const file of all) {
      for (const spec of imports(read(file))) {
        expect(
          SERVER_ONLY.some((re) => re.test(spec)),
          `${rel(file)} импортирует ${spec}`
        ).toBe(false);
      }
    }
  });

  it("force-dynamic — только у мастера; остальные страницы не читают запрос", () => {
    for (const file of files(SITE_APP)) {
      const text = read(file);
      if (rel(file) === CHECK_PAGE) {
        expect(text).toMatch(/export const dynamic = "force-dynamic";/u);
        continue;
      }
      expect(text, rel(file)).not.toMatch(/export const (dynamic|revalidate)\b/u);
      expect(text, rel(file)).not.toMatch(/\b(headers|cookies)\(\)/u);
    }
  });
});

describe("мастер в поиск не попадает", () => {
  it("метаданные страниц проверки — noindex, nofollow", () => {
    expect(checkPageMetadata.robots).toEqual({ index: false, follow: false });
  });

  it("каждая страница под /check объявляет эти метаданные", () => {
    const pages = files(join(SITE_APP, "check")).filter((f) => f.endsWith("page.tsx"));
    expect(pages.map(rel).sort()).toEqual(
      [CHECK_PAGE, "src/app/(site)/check/disabled/page.tsx", "src/app/(site)/check/limit/page.tsx"].sort()
    );
    for (const page of pages) {
      expect(read(page), rel(page)).toMatch(/export const metadata(: Metadata)? = checkPageMetadata;/u);
    }
  });
});
