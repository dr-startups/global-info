import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeSelfCheckSettings } from "@/modules/digital-profile/config/env-validation";
import { siteIndexing } from "@/modules/site/seo/indexing";
import { siteMetadata } from "@/modules/site/seo/metadata";
import { siteRobots } from "@/modules/site/seo/robots";

/**
 * Пока индексация не включена, сайт закрыт для поиска целиком: `robots.txt`
 * запрещает всё, страницы отдают `noindex`. Тестовая выкладка не должна попасть в
 * выдачу, а выключенное значение — единственное, при котором ошибка безопасна.
 *
 * Включённая индексация при адресе не `https` или локальном — тоже закрыта.
 * Адрес читается при сборке, и забытая переменная сборки оставила бы в canonical
 * и карте сайта `http://localhost:3000`: открыть поиску такие страницы хуже, чем
 * не открыть никакие. Ответ «открыт ли сайт поиску» один, и его читают robots,
 * метаданные страниц, карта сайта и сводка на старте.
 */

const OPEN = { SITE_INDEXING_ENABLED: "true", SITE_PUBLIC_ORIGIN: "https://global-info.example" };

type Rule = { userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[] };
const rulesOf = (env: Record<string, string | undefined>) => {
  const robots = siteRobots(env);
  return { robots, rules: ([] as Rule[]).concat(robots.rules as Rule | Rule[]) };
};
const list = (value: string | string[] | undefined) => ([] as string[]).concat(value ?? []);

describe("индексация", () => {
  it("по умолчанию закрыта и называет переменную", () => {
    const state = siteIndexing({});
    expect(state.open).toBe(false);
    expect(state.reason).toMatch(/SITE_INDEXING_ENABLED/u);
  });

  it("включённая при локальном или не https адресе остаётся закрытой и говорит почему", () => {
    for (const origin of ["http://localhost:3000", "http://global-info.example", "https://localhost", "https://127.0.0.1:3000"]) {
      const state = siteIndexing({ SITE_INDEXING_ENABLED: "true", SITE_PUBLIC_ORIGIN: origin });
      expect(state.open, origin).toBe(false);
      expect(state.reason, origin).toMatch(/SITE_PUBLIC_ORIGIN/u);
    }
  });

  it("открыта только при включённой настройке и настоящем https-адресе", () => {
    expect(siteIndexing(OPEN)).toMatchObject({ open: true, reason: null });
    expect(siteIndexing(OPEN).origin.href).toBe("https://global-info.example/");
    expect(siteIndexing({ ...OPEN, SITE_INDEXING_ENABLED: "false" }).open).toBe(false);
  });

  it("опечатка в адресе не роняет сборку: берётся адрес по умолчанию, и индексация закрыта", () => {
    const state = siteIndexing({ SITE_INDEXING_ENABLED: "true", SITE_PUBLIC_ORIGIN: "global info" });
    expect(state.origin.href).toBe("http://localhost:3000/");
    expect(state.open).toBe(false);
  });
});

describe("robots.txt", () => {
  it("закрытый сайт запрещает всё и карту сайта не называет", () => {
    for (const env of [{}, { SITE_INDEXING_ENABLED: "true" }, { ...OPEN, SITE_PUBLIC_ORIGIN: "http://localhost:3000" }]) {
      const { robots, rules } = rulesOf(env);
      expect(rules).toHaveLength(1);
      expect(list(rules[0]!.userAgent)).toEqual(["*"]);
      expect(list(rules[0]!.disallow)).toEqual(["/"]);
      expect(robots.sitemap).toBeUndefined();
    }
  });

  it("открытый сайт закрывает админку, API и мастер проверки и называет карту сайта", () => {
    const { robots, rules } = rulesOf(OPEN);
    expect(rules).toHaveLength(1);
    const disallow = list(rules[0]!.disallow);
    expect(disallow).not.toContain("/");
    expect(disallow).toEqual(expect.arrayContaining(["/admin", "/api", "/check"]));
    expect(robots.sitemap).toBe("https://global-info.example/sitemap.xml");
  });

  it("robots.txt отдаёт маршрут Next из корня app, а ответ берёт у сайта", () => {
    const path = join(process.cwd(), "src/app/robots.ts");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toMatch(/siteRobots\(\)/u);
  });
});

describe("метаданные страниц", () => {
  it("закрытый сайт — noindex, nofollow на всех страницах сайта", () => {
    expect(siteMetadata({}).robots).toEqual({ index: false, follow: false });
    expect(siteMetadata({ SITE_INDEXING_ENABLED: "true" }).robots).toEqual({ index: false, follow: false });
  });

  it("открытый сайт — index, follow", () => {
    expect(siteMetadata(OPEN).robots).toEqual({ index: true, follow: true });
  });
});

describe("сводка на старте", () => {
  const text = (env: Record<string, string>) => describeSelfCheckSettings(env).join("\n");

  it("называет причину, по которой включённая индексация закрыта", () => {
    const out = text({ SITE_INDEXING_ENABLED: "true" });
    expect(out).toMatch(/индексация — закрыта/u);
    expect(out).toMatch(/SITE_PUBLIC_ORIGIN/u);
  });

  it("открытую индексацию печатает открытой", () => {
    expect(text(OPEN)).toMatch(/индексация — открыта, адрес https:\/\/global-info\.example/u);
  });
});
