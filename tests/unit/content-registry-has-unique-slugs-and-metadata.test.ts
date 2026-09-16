import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ABOUT, CONTACTS_PAGE } from "@/modules/site/content/about";
import { ARTICLES, ARTICLE_AUTHOR, BLOG_TOPICS, readingMinutes } from "@/modules/site/content/articles";
import { FOOTER_NAV, HEADER_NAV, LEGAL_NAV } from "@/modules/site/content/contacts";
import { FAQ_PAGE } from "@/modules/site/content/faq";
import { SOURCES, TOPICS } from "@/modules/site/content/landing";
import { LEGAL_DOCUMENTS } from "@/modules/site/content/legal";
import { SITE_PAGES, breadcrumbsFor, sitePage } from "@/modules/site/content/pages";
import { SERVICES } from "@/modules/site/content/services";

/**
 * Реестр контента — один ответ на вопрос «какие страницы есть у сайта». Из него
 * читают страницы, метаданные, карта сайта, хлебные крошки и JSON-LD: страница,
 * которой нет в реестре, не попадёт в карту, а запись без страницы отдаст 404 из
 * карты сайта.
 *
 * Текст ссылается на страницы реестра разметкой `[текст](/адрес)`; ссылка на
 * несуществующий адрес — это 404 у посетителя и у поискового робота, поэтому
 * адреса сверяются здесь, а не глазами.
 */

const SLUG_PATH = /^\/([a-z0-9]+(-[a-z0-9]+)*)(\/[a-z0-9]+(-[a-z0-9]+)*)*$/u;
const CONTENT = { SERVICES, ARTICLES, FAQ_PAGE, ABOUT, CONTACTS_PAGE };
const LANDING_ANCHORS = ["/#form", "/#how", "/#faq"];
const KNOWN_PLACEHOLDERS = ["{{PHONE}}", "{{EMAIL}}", "{{TELEGRAM}}", "{{LEGAL_ENTITY}}", "{{REQUISITES}}", "{{PRICING_MODEL}}"];

const linksIn = (value: unknown) => [...JSON.stringify(value).matchAll(/\]\((\/[^)\s]*)\)/gu)].map((m) => m[1]!);
const placeholdersIn = (value: unknown) => [...JSON.stringify(value).matchAll(/\{\{[^}]*\}\}/gu)].map((m) => m[0]);

describe("реестр страниц", () => {
  const paths = SITE_PAGES.map((page) => page.path);

  it("адреса уникальны, строчной латиницей, без завершающего слэша", () => {
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      if (path === "/") continue;
      expect(path, path).toMatch(SLUG_PATH);
    }
  });

  it("совпадает с картой страниц ТЗ 5.1: услуги, блог, вопросы, о проекте, контакты, юридические тексты", () => {
    expect([...paths].sort()).toEqual(
      [
        "/",
        "/uslugi",
        ...SERVICES.map((s) => s.path),
        "/blog",
        ...ARTICLES.map((a) => a.path),
        "/voprosy",
        "/o-proekte",
        "/kontakty",
        ...Object.values(LEGAL_DOCUMENTS).map((doc) => `/legal/${doc.slug}`),
      ].sort()
    );
    expect(SERVICES.map((s) => s.path)).toEqual([
      "/uslugi/poisk-negativa",
      "/uslugi/udalenie-iz-poiskovoy-vydachi",
      "/uslugi/pravo-na-zabvenie",
      "/uslugi/udalenie-negativa-iz-interneta",
    ]);
    expect(ARTICLES).toHaveLength(6);
    expect(ARTICLES.map((a) => a.path)).toContain("/blog/chto-o-vas-est-v-internete");
  });

  it("у каждой страницы h1, подпись крошки и дата обновления", () => {
    for (const page of SITE_PAGES) {
      expect(page.h1.trim(), page.path).not.toBe("");
      expect(page.crumb.trim(), page.path).not.toBe("");
      expect(page.updated, page.path).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(Number.isNaN(Date.parse(page.updated)), page.path).toBe(false);
    }
  });

  it("неизвестный адрес — ошибка, а не пустые метаданные", () => {
    expect(() => sitePage("/nope")).toThrow();
  });

  it("хлебные крошки идут от главной через существующие разделы", () => {
    expect(breadcrumbsFor("/uslugi/poisk-negativa").map((c) => [c.name, c.path])).toEqual([
      ["Главная", "/"],
      ["Услуги", "/uslugi"],
      ["Поиск негатива", "/uslugi/poisk-negativa"],
    ]);
    expect(breadcrumbsFor("/blog/chto-o-vas-est-v-internete").map((c) => c.path)).toEqual([
      "/",
      "/blog",
      "/blog/chto-o-vas-est-v-internete",
    ]);
    // Раздела /legal нет — крошки не ведут в пустоту.
    expect(breadcrumbsFor("/legal/soglasie").map((c) => c.path)).toEqual(["/", "/legal/soglasie"]);
  });
});

describe("тексты страниц", () => {
  const known = new Set([...SITE_PAGES.map((page) => page.path), ...LANDING_ANCHORS]);

  it("внутренние ссылки ведут на существующие страницы", () => {
    const links = linksIn(CONTENT);
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) expect(known.has(link), link).toBe(true);
  });

  it("каждая статья ведёт на услугу своего кластера", () => {
    const services = new Set(SERVICES.map((s) => s.path));
    for (const article of ARTICLES) {
      expect(services.has(article.servicePath), article.path).toBe(true);
      expect(linksIn(article.blocks), article.path).toContain(article.servicePath);
    }
  });

  it("плейсхолдеры — только названные в ТЗ, и не в заголовках и описаниях", () => {
    for (const placeholder of placeholdersIn(CONTENT)) expect(KNOWN_PLACEHOLDERS, placeholder).toContain(placeholder);
    for (const page of SITE_PAGES) {
      expect(placeholdersIn([page.title, page.description, page.h1, page.crumb]), page.path).toEqual([]);
    }
  });

  it("шкала риска в текстах — три ступени отчёта, без «критического»", () => {
    expect(JSON.stringify(CONTENT)).not.toMatch(/критическ/iu);
  });

  it("«Поиск негатива» не копирует тексты главной, а берёт их из тех же констант", () => {
    const search = SERVICES.find((s) => s.slug === "poisk-negativa")!;
    const json = JSON.stringify(search);
    for (const text of [...SOURCES.items.map((i) => i.text), ...TOPICS.items.map((i) => i.text)]) {
      expect(json, text).not.toContain(text);
    }
    expect(search.blocks.map((b) => b.type)).toEqual(expect.arrayContaining(["sources", "topics", "steps"]));
  });

  it("у услуг и статей есть обложка в public", () => {
    // Ширины под экран нарезает next/image из одного файла — как кадр главной.
    for (const item of [...SERVICES, ...ARTICLES]) {
      const file = `${item.cover}.webp`;
      expect(existsSync(join(process.cwd(), "public/site/covers", file)), `${item.path}: ${file}`).toBe(true);
    }
  });
});

describe("блог", () => {
  it("автор статей — редакция (решение владельца 16.09.2026), темы — как в фильтре макета", () => {
    expect(ARTICLE_AUTHOR).toBe("Редакция Global Info");
    expect(BLOG_TOPICS.map((t) => [t.id, t.label])).toEqual([
      ["check", "Проверка"],
      ["remove", "Удаление"],
      ["law", "Право"],
    ]);
    const topics = new Set(BLOG_TOPICS.map((t) => t.id));
    for (const article of ARTICLES) expect(topics.has(article.topic), article.path).toBe(true);
  });

  it("время чтения считается по тексту и совпадает с макетом у двух его статей", () => {
    const minutes = (path: string) => readingMinutes(ARTICLES.find((a) => a.path === path)!);
    expect(minutes("/blog/chto-o-vas-est-v-internete")).toBe(4);
    expect(minutes("/blog/kak-udalit-informaciyu-o-sebe-iz-interneta")).toBe(2);
    for (const article of ARTICLES) expect(readingMinutes(article), article.path).toBeGreaterThanOrEqual(1);
  });

  it("опубликована не позже обновления", () => {
    for (const article of ARTICLES) {
      expect(article.published <= article.updated, article.path).toBe(true);
      expect(sitePage(article.path).updated).toBe(article.updated);
    }
  });
});

describe("меню", () => {
  it("шапка — как в утверждённом макете", () => {
    expect(HEADER_NAV.map((i) => [i.label, i.href])).toEqual([
      ["Как это работает", "/#how"],
      ["Услуги", "/uslugi"],
      ["Вопросы", "/#faq"],
      ["Блог", "/blog"],
      ["Контакты", "#contacts"],
    ]);
  });

  it("подвал ведёт на страницы вопросов и контактов (решение владельца 16.09.2026)", () => {
    expect(FOOTER_NAV.map((i) => [i.label, i.href])).toEqual([
      ["Как это работает", "/#how"],
      ["Услуги", "/uslugi"],
      ["Вопросы", "/voprosy"],
      ["Блог", "/blog"],
      ["О проекте", "/o-proekte"],
      ["Контакты", "/kontakty"],
    ]);
  });

  it("каждый пункт меню без якоря ведёт на страницу реестра", () => {
    const known = new Set(SITE_PAGES.map((page) => page.path));
    for (const item of [...HEADER_NAV, ...FOOTER_NAV, ...LEGAL_NAV]) {
      if (item.href.includes("#")) continue;
      expect(known.has(item.href), item.href).toBe(true);
    }
  });
});
