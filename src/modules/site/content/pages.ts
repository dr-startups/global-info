/**
 * Реестр страниц сайта — один ответ на вопрос «какие страницы есть».
 *
 * Из него читают метаданные страниц, карта сайта, хлебные крошки и JSON-LD.
 * `title`, `description` и `h1` — строки таблицы семантического ядра (она лежит вне
 * репозитория, в `global-info-research/seo/semantic-core.md`). У услуг, статей и
 * текстовых страниц эти поля живут рядом с их текстом; здесь они только
 * собираются в список. Мастер проверки в реестр не входит: это не страница для
 * поиска.
 */

import { ABOUT, CONTACTS_PAGE } from "./about";
import { ARTICLES, BLOG } from "./articles";
import { FAQ_PAGE } from "./faq";
import { HERO } from "./landing";
import { LEGAL_DOCUMENTS } from "./legal";
import { SERVICES, SERVICES_HUB } from "./services";

export type SitePageKind = "home" | "hub" | "service" | "blog" | "article" | "faq" | "about" | "contacts" | "legal";

export interface SitePage {
  path: string;
  kind: SitePageKind;
  /** Без «— Global Info»: шаблон заголовка добавит его сам. */
  title: string;
  /** Заголовок целиком, без шаблона, — только у главной. */
  absoluteTitle?: true;
  description: string;
  h1: string;
  /** Подпись в хлебных крошках. */
  crumb: string;
  /** Дата последнего изменения текста — для карты сайта, а не время сборки. */
  updated: string;
  published?: string;
}

const pick = (kind: SitePageKind, page: Omit<SitePage, "kind">): SitePage => ({
  kind,
  path: page.path,
  title: page.title,
  ...(page.absoluteTitle ? { absoluteTitle: true as const } : {}),
  description: page.description,
  h1: page.h1,
  crumb: page.crumb,
  updated: page.updated,
  ...(page.published ? { published: page.published } : {}),
});

export const SITE_PAGES: readonly SitePage[] = [
  pick("home", {
    path: "/",
    title: "Проверить себя в интернете бесплатно — Global Info",
    absoluteTitle: true,
    description:
      "Бесплатная проверка репутации по открытым источникам: есть ли о вас негативные материалы, в каких темах и насколько это серьёзно.",
    h1: HERO.title,
    crumb: "Главная",
    updated: "2026-09-16",
  }),
  pick("hub", SERVICES_HUB),
  ...SERVICES.map((service) => pick("service", service)),
  pick("blog", { ...BLOG, updated: ARTICLES.map((a) => a.updated).sort().at(-1)! }),
  ...ARTICLES.map((article) => pick("article", article)),
  pick("faq", FAQ_PAGE),
  pick("about", ABOUT),
  pick("contacts", CONTACTS_PAGE),
  ...Object.values(LEGAL_DOCUMENTS).map((doc) =>
    pick("legal", {
      path: `/legal/${doc.slug}`,
      title: doc.title,
      description: doc.description,
      h1: doc.title,
      crumb: doc.title,
      updated: doc.updated,
    })
  ),
];

export function sitePage(path: string): SitePage {
  const page = SITE_PAGES.find((p) => p.path === path);
  if (!page) throw new Error(`Страницы ${path} нет в реестре сайта (content/pages.ts)`);
  return page;
}

export interface Crumb {
  name: string;
  path: string;
}

/** Главная → разделы, которые есть в реестре → сама страница. */
export function breadcrumbsFor(path: string): Crumb[] {
  const segments = path.split("/").filter(Boolean);
  const paths = ["/", ...segments.map((_, i) => `/${segments.slice(0, i + 1).join("/")}`)];
  return paths
    .map((p) => SITE_PAGES.find((page) => page.path === p))
    .filter((page): page is SitePage => page !== undefined)
    .map((page) => ({ name: page.crumb, path: page.path }));
}
