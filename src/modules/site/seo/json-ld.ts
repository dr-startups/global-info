/**
 * Структурированные данные schema.org одним помощником.
 *
 * Поля — те, без которых поисковики не строят расширенный показ, и адреса —
 * абсолютные: у разметки нет базы адресов страницы. Текст контента приходит со
 * строчной разметкой (`**`, `[текст](/адрес)`) — в JSON-LD уходит простой текст.
 * Цена указана только у бесплатной проверки: модели цены у услуг ещё нет, и
 * выдуманная цена в разметке хуже её отсутствия.
 */

import { ARTICLE_AUTHOR, type ArticleContent } from "@/modules/site/content/articles";
import { type FaqItem, plainText } from "@/modules/site/content/blocks";
import { breadcrumbsFor, sitePage } from "@/modules/site/content/pages";
import type { ServiceContent } from "@/modules/site/content/services";
import { SITE_NAME } from "./metadata";

type Ld = Record<string, unknown>;

const CONTEXT = "https://schema.org";
const abs = (path: string, origin: URL) => new URL(path, origin).href;
const organizationId = (origin: URL) => abs("/#organization", origin);

export function organizationLd(origin: URL): Ld {
  return {
    "@context": CONTEXT,
    "@type": "Organization",
    "@id": organizationId(origin),
    name: SITE_NAME,
    url: abs("/", origin),
    logo: abs("/icon.png", origin),
  };
}

export function websiteLd(origin: URL): Ld {
  return { "@context": CONTEXT, "@type": "WebSite", name: SITE_NAME, url: abs("/", origin), inLanguage: "ru" };
}

export function breadcrumbLd(path: string, origin: URL): Ld {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: breadcrumbsFor(path).map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: abs(crumb.path, origin),
    })),
  };
}

export function faqLd(items: readonly FaqItem[]): Ld {
  return {
    "@context": CONTEXT,
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: plainText(item.q),
      acceptedAnswer: { "@type": "Answer", text: plainText(item.a) },
    })),
  };
}

export function serviceLd(service: ServiceContent, origin: URL): Ld {
  return {
    "@context": CONTEXT,
    "@type": "Service",
    name: service.h1,
    description: service.description,
    url: abs(service.path, origin),
    serviceType: service.crumb,
    areaServed: "RU",
    provider: { "@id": organizationId(origin) },
    ...(service.free ? { offers: { "@type": "Offer", price: "0", priceCurrency: "RUB" } } : {}),
  };
}

export function articleLd(article: ArticleContent, origin: URL): Ld {
  const page = sitePage(article.path);
  return {
    "@context": CONTEXT,
    "@type": "Article",
    headline: page.h1,
    description: page.description,
    image: [abs(`/site/covers/${article.cover}.webp`, origin)],
    datePublished: article.published,
    dateModified: article.updated,
    author: { "@type": "Organization", name: ARTICLE_AUTHOR, url: abs("/o-proekte", origin) },
    publisher: { "@id": organizationId(origin) },
    mainEntityOfPage: abs(article.path, origin),
    inLanguage: "ru",
  };
}

/**
 * Текст для `<script type="application/ld+json">`. `<` экранируется: строка с
 * `</script>` из контента иначе закрыла бы тег, а JSON читает `<` как тот же
 * символ.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</gu, "\\u003c");
}
