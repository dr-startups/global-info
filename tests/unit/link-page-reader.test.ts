import { describe, expect, it } from "vitest";
import {
  extractPageTitle,
  extractPublishedAt,
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
