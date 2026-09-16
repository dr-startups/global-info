/**
 * Метаданные сайта: база адресов, шаблон заголовка, индексация, коды вебмастеров,
 * метаданные страниц из реестра и `noindex` мастера.
 *
 * Страницы сайта пререндерятся при сборке, поэтому настройки здесь читаются на
 * сборке; до образа они доходят объявленными `ARG` в `Dockerfile`. Открыт ли сайт
 * поиску, решает `siteIndexing` — тот же ответ, что у `robots.txt` и карты сайта.
 */

import type { Metadata } from "next";
import { textSetting } from "@/modules/digital-profile/config/defaults";
import { sitePage } from "@/modules/site/content/pages";
import { siteIndexing } from "./indexing";

export const SITE_NAME = "Global Info";

/**
 * Картинка превью — файлом из `public` и явно в каждой странице, а не файлом
 * `opengraph-image.png` в группе маршрутов: Next подставляет такой файл только своему
 * сегменту, а своя запись `openGraph` у вложенной страницы заменяет унаследованную
 * целиком — вместе с картинкой. Так превью было только у главной.
 */
export const SITE_SHARE_IMAGE = {
  url: "/site/og-image.png",
  width: 1200,
  height: 630,
  alt: "Global Info — бесплатная проверка репутации в открытых источниках",
} as const;

type Env = Record<string, string | undefined>;

function verificationOf(env: Env): Metadata["verification"] {
  const yandex = textSetting("SITE_YANDEX_VERIFICATION", env);
  const google = textSetting("SITE_GOOGLE_VERIFICATION", env);
  if (!yandex && !google) return undefined;
  return { ...(yandex ? { yandex } : {}), ...(google ? { google } : {}) };
}

export function siteMetadata(env: Env = process.env): Metadata {
  const indexing = siteIndexing(env);
  const verification = verificationOf(env);
  return {
    metadataBase: indexing.origin,
    title: {
      template: `%s — ${SITE_NAME}`,
      default: `${SITE_NAME} — проверка репутации в открытых источниках`,
    },
    description:
      "Бесплатная проверка репутации по открытым источникам: есть ли о вас негативные материалы, в каких темах и насколько это серьёзно.",
    applicationName: SITE_NAME,
    openGraph: { siteName: SITE_NAME, locale: "ru_RU", type: "website", images: [SITE_SHARE_IMAGE] },
    twitter: { card: "summary_large_image", images: [SITE_SHARE_IMAGE.url] },
    robots: indexing.open ? { index: true, follow: true } : { index: false, follow: false },
    ...(verification ? { verification } : {}),
  };
}

/**
 * Метаданные страницы по её адресу в реестре. Файл страницы называет только адрес:
 * заголовок, описание и h1 живут в реестре вместе с картой сайта. Неизвестный адрес
 * роняет сборку — страница без заголовка хуже упавшей сборки.
 */
export function pageMetadata(path: string): Metadata {
  const page = sitePage(path);
  const shared = {
    url: page.path,
    title: page.title,
    description: page.description,
    siteName: SITE_NAME,
    locale: "ru_RU",
    images: [SITE_SHARE_IMAGE],
  };
  return {
    title: page.absoluteTitle ? { absolute: page.title } : page.title,
    description: page.description,
    alternates: { canonical: page.path },
    openGraph:
      page.kind === "article"
        ? { ...shared, type: "article", publishedTime: page.published, modifiedTime: page.updated }
        : { ...shared, type: "website" },
    twitter: {
      card: "summary_large_image",
      title: page.title,
      description: page.description,
      images: [SITE_SHARE_IMAGE.url],
    },
  };
}

/**
 * Страницы `/check/*`: мастер с данными конкретного человека и служебные экраны.
 * В поиск не попадают и ссылок для обхода не дают.
 */
export const checkPageMetadata: Metadata = {
  title: "Проверка",
  robots: { index: false, follow: false },
};
