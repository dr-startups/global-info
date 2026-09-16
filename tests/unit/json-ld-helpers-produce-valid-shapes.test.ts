import { describe, expect, it } from "vitest";
import { ARTICLES } from "@/modules/site/content/articles";
import { FAQ_PAGE } from "@/modules/site/content/faq";
import { FAQ } from "@/modules/site/content/landing";
import { SITE_PAGES } from "@/modules/site/content/pages";
import { SERVICES } from "@/modules/site/content/services";
import {
  articleLd,
  breadcrumbLd,
  faqLd,
  organizationLd,
  serializeJsonLd,
  serviceLd,
  websiteLd,
} from "@/modules/site/seo/json-ld";

/**
 * Структурированные данные строит один помощник, и поля у каждого типа — те,
 * которые поисковики требуют для расширенного показа. Поисковик молча
 * пропускает разметку без обязательного поля, поэтому форма сверяется здесь.
 *
 * Разметка текста (`**жирный**`, `[ссылка](/адрес)`) и плейсхолдеры в JSON-LD
 * не попадают: робот прочёл бы их как текст ответа. Адреса — абсолютные: у
 * разметки нет базы адресов страницы.
 */

const origin = new URL("https://global-info.example");
type Ld = Record<string, unknown>;
const MARKUP = /\*\*|\]\(|\{\{/u;

const absolute = (value: unknown) => {
  expect(typeof value).toBe("string");
  expect(String(value).startsWith("https://global-info.example/")).toBe(true);
};

describe("Organization и WebSite", () => {
  it("организация — имя, адрес, логотип и идентификатор для ссылок", () => {
    const ld = organizationLd(origin) as Ld;
    expect(ld).toMatchObject({ "@context": "https://schema.org", "@type": "Organization", name: "Global Info" });
    expect(ld.url).toBe("https://global-info.example/");
    absolute(ld.logo);
    absolute(ld["@id"]);
  });

  it("сайт — имя, адрес, язык", () => {
    expect(websiteLd(origin)).toMatchObject({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Global Info",
      url: "https://global-info.example/",
      inLanguage: "ru",
    });
  });
});

describe("BreadcrumbList", () => {
  it("позиции с единицы подряд, у каждой имя и абсолютный адрес", () => {
    const ld = breadcrumbLd("/blog/chto-o-vas-est-v-internete", origin) as Ld;
    expect(ld).toMatchObject({ "@context": "https://schema.org", "@type": "BreadcrumbList" });
    const items = ld.itemListElement as Ld[];
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
    for (const item of items) {
      expect(item["@type"]).toBe("ListItem");
      expect(String(item.name).trim()).not.toBe("");
      absolute(item.item);
    }
    expect(items[2]!.item).toBe("https://global-info.example/blog/chto-o-vas-est-v-internete");
  });
});

describe("FAQPage", () => {
  it("вопрос — Question с name, ответ — Answer с text, без разметки текста", () => {
    const groups = FAQ_PAGE.groups.flatMap((g) => g.items);
    for (const items of [FAQ.items, groups]) {
      const ld = faqLd(items) as Ld;
      expect(ld).toMatchObject({ "@context": "https://schema.org", "@type": "FAQPage" });
      const questions = ld.mainEntity as Ld[];
      expect(questions).toHaveLength(items.length);
      for (const q of questions) {
        expect(q["@type"]).toBe("Question");
        expect(String(q.name)).not.toMatch(MARKUP);
        const answer = q.acceptedAnswer as Ld;
        expect(answer["@type"]).toBe("Answer");
        expect(String(answer.text).trim()).not.toBe("");
        expect(String(answer.text)).not.toMatch(MARKUP);
      }
    }
  });

  it("на странице вопросов их 15–20 (ТЗ 5.1)", () => {
    const count = FAQ_PAGE.groups.flatMap((g) => g.items).length;
    expect(count).toBeGreaterThanOrEqual(15);
    expect(count).toBeLessThanOrEqual(20);
  });

  it("ссылка в ответе становится текстом ссылки", () => {
    const ld = faqLd([{ q: "Где подробнее?", a: "В статье [о праве на забвение](/blog/x) и **на странице** услуги." }]) as Ld;
    const text = ((ld.mainEntity as Ld[])[0]!.acceptedAnswer as Ld).text;
    expect(text).toBe("В статье о праве на забвение и на странице услуги.");
  });
});

describe("Service", () => {
  it("у каждой услуги — имя, описание, адрес, исполнитель и регион", () => {
    for (const service of SERVICES) {
      const ld = serviceLd(service, origin) as Ld;
      expect(ld).toMatchObject({ "@context": "https://schema.org", "@type": "Service", areaServed: "RU" });
      expect(String(ld.name).trim()).not.toBe("");
      expect(String(ld.description).trim()).not.toBe("");
      expect(ld.url).toBe(new URL(service.path, origin).href);
      expect((ld.provider as Ld)["@id"]).toBe((organizationLd(origin) as Ld)["@id"]);
      expect(JSON.stringify(ld)).not.toMatch(MARKUP);
    }
  });

  it("цена указана только у бесплатной проверки: у остальных её нет, а не выдумана", () => {
    for (const service of SERVICES) {
      const offers = (serviceLd(service, origin) as Ld).offers as Ld | undefined;
      if (service.slug === "poisk-negativa") {
        expect(offers).toMatchObject({ "@type": "Offer", price: "0", priceCurrency: "RUB" });
      } else {
        expect(offers, service.slug).toBeUndefined();
      }
    }
  });
});

describe("Article", () => {
  it("у каждой статьи — заголовок до 110 знаков, картинка, даты, автор, издатель, адрес", () => {
    for (const article of ARTICLES) {
      const ld = articleLd(article, origin) as Ld;
      const page = SITE_PAGES.find((p) => p.path === article.path)!;
      expect(ld).toMatchObject({ "@context": "https://schema.org", "@type": "Article", inLanguage: "ru" });
      expect(ld.headline).toBe(page.h1);
      expect(String(ld.headline).length).toBeLessThanOrEqual(110);
      expect(ld.description).toBe(page.description);
      const images = ld.image as string[];
      expect(images.length).toBeGreaterThan(0);
      images.forEach(absolute);
      expect(ld.datePublished).toBe(article.published);
      expect(ld.dateModified).toBe(article.updated);
      expect(ld.author).toMatchObject({ "@type": "Organization", name: "Редакция Global Info" });
      expect((ld.publisher as Ld)["@id"]).toBe((organizationLd(origin) as Ld)["@id"]);
      expect(ld.mainEntityOfPage).toBe(new URL(article.path, origin).href);
      expect(JSON.stringify(ld)).not.toMatch(MARKUP);
    }
  });
});

describe("сериализация в <script>", () => {
  it("строка с </script> не закрывает тег, а данные читаются как были", () => {
    const data = { name: "</script><script>alert(1)</script>" };
    const text = serializeJsonLd(data);
    expect(text).not.toMatch(/<\/script/iu);
    expect(text).not.toContain("<");
    expect(JSON.parse(text)).toEqual(data);
  });
});
