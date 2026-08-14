import { describe, expect, it } from "vitest";
import {
  LINK_READER_USER_AGENT,
  extractPageTitle,
  extractPublishedAt,
  extractPublishedSummary,
  extractReadableText,
  isLinkReadingEnabled,
  readLinkPage,
} from "@/modules/digital-profile/services/link-page-reader";

const BODY = "Текст статьи. ".repeat(30);

function page(extra = ""): string {
  return `<html><head><title>Заголовок страницы</title>${extra}</head>
    <body><script>alert('x')</script><style>.a{}</style><p>${BODY}</p></body></html>`;
}

function fetchOk(html: string) {
  return async () => ({ ok: true, status: 200, text: async () => html });
}

describe("извлечение текста", () => {
  it("выбрасывает скрипты и стили целиком", () => {
    const text = extractReadableText(page());
    expect(text).not.toContain("alert");
    expect(text).not.toContain(".a{}");
    expect(text).toContain("Текст статьи.");
  });

  it("раскрывает сущности и схлопывает пробелы", () => {
    expect(extractReadableText("<p>&laquo;Роснефть&raquo;&nbsp;&mdash;&nbsp;компания</p>")).toBe(
      "«Роснефть» — компания"
    );
  });

  it("режет по пределу, а не отдаёт страницу целиком", () => {
    expect(extractReadableText("<p>" + "а".repeat(5000) + "</p>", 100)).toHaveLength(100);
  });

  it("берёт заголовок из разметки страницы", () => {
    expect(extractPageTitle(page())).toBe("Заголовок страницы");
  });

  it("берёт только объявленную дату публикации", () => {
    const withMeta = page('<meta property="article:published_time" content="2024-03-15T10:00:00Z">');
    expect(extractPublishedAt(withMeta)).toBe("2024-03-15T10:00:00Z");
    // Дата в теле статьи датой публикации не считается: «12 мая» может быть чем
    // угодно, и назвать это фактом значит его выдумать.
    expect(extractPublishedAt("<p>Встреча прошла 12 мая 2019 года</p>")).toBeUndefined();
  });
});

describe("чтение страницы", () => {
  const now = () => new Date("2026-08-13T12:00:00.000Z");

  it("отдаёт текст, заголовок и дату", async () => {
    const res = await readLinkPage("https://example.com/a", {
      fetchImpl: fetchOk(page('<meta property="article:published_time" content="2024-03-15">')) as never,
      now,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.title).toBe("Заголовок страницы");
      expect(res.publishedAt).toBe("2024-03-15");
      expect(res.readAt).toBe("2026-08-13T12:00:00.000Z");
    }
  });

  it("404 отличается от закрытого сайта", async () => {
    const notFound = await readLinkPage("https://example.com/a", {
      fetchImpl: (async () => ({ ok: false, status: 404, text: async () => "" })) as never,
      now,
    });
    const blocked = await readLinkPage("https://example.com/a", {
      fetchImpl: (async () => ({ ok: false, status: 403, text: async () => "" })) as never,
      now,
    });
    expect(notFound.ok === false && notFound.failure).toBe("not_found");
    expect(blocked.ok === false && blocked.failure).toBe("blocked");
  });

  it("пустая страница — названная причина, а не молчание", async () => {
    const res = await readLinkPage("https://example.com/a", {
      fetchImpl: fetchOk("<html><body><p>коротко</p></body></html>") as never,
      now,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.failure).toBe("empty_text");
  });

  it("падение сети не роняет прогон", async () => {
    const res = await readLinkPage("https://example.com/a", {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
      now,
    });
    expect(res.ok === false && res.failure).toBe("not_fetched");
  });
});

describe("выключатель чтения", () => {
  it("по умолчанию выключено: чтение стоит денег", () => {
    expect(isLinkReadingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("включается только явно", () => {
    expect(isLinkReadingEnabled({ DIGITAL_PROFILE_LINK_READING: "true" } as never)).toBe(true);
    expect(isLinkReadingEnabled({ DIGITAL_PROFILE_LINK_READING: "maybe" } as never)).toBe(false);
  });
});

describe("страницы, которые рисуются скриптами", () => {
  const now = () => new Date("2026-08-14T02:00:00.000Z");
  const shell = (meta: string) =>
    `<html><head><title>Заголовок</title>${meta}</head><body><div id="root"></div></body></html>`;

  it("читает описание, которое страница published для роботов", async () => {
    // Половина отказов живого прогона: vk.ru, dzen.ru, rbc.ru отдают пустую
    // оболочку, но кладут в разметку описание для поисковиков.
    const description = "Подробное описание материала для поисковых систем. ".repeat(6);
    const res = await readLinkPage("https://example.com/a", {
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        text: async () => shell(`<meta property="og:description" content="${description}">`),
      })) as never,
      now,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("Подробное описание материала");
  });

  it("без описания честно признаёт, что текста нет", async () => {
    const res = await readLinkPage("https://example.com/a", {
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => shell("") })) as never,
      now,
    });
    expect(res.ok === false && res.failure).toBe("empty_text");
  });

  it("берёт articleBody из JSON-LD", () => {
    const body = "Текст статьи в структурированной разметке страницы. ".repeat(5);
    expect(extractPublishedSummary(`<script type="application/ld+json">{"articleBody":"${body}"}</script>`))
      .toContain("Текст статьи в структурированной разметке");
  });
});

describe("как читатель представляется сайту", () => {
  it("заголовок запроса — только латиница: кириллица роняет fetch до сети", () => {
    // Значение HTTP-заголовка — байтовая строка. Русское пояснение в
    // user-agent роняло каждый запрос с ByteString-ошибкой, и в трёх прогонах
    // подряд ни одна из ста двадцати страниц не была прочитана.
    expect(LINK_READER_USER_AGENT).toMatch(/^[\x20-\x7E]+$/u);
    expect(LINK_READER_USER_AGENT).toContain("DigitalProfileAudit");
  });

  it("не выдаёт себя за браузер", () => {
    expect(LINK_READER_USER_AGENT).not.toMatch(/mozilla|chrome|safari|webkit/i);
  });

  it("заголовок принимается настоящим Headers без исключения", () => {
    expect(() => new Headers({ "user-agent": LINK_READER_USER_AGENT })).not.toThrow();
  });
});
