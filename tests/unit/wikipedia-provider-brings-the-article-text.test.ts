import { afterEach, describe, expect, it, vi } from "vitest";
import { wikipediaProvider } from "@/modules/digital-profile/providers/wikipedia-provider";

/**
 * «Найти статью по ФИО» доведено до конца: полный текст и межъязыковая ссылка.
 *
 * Сегодня провайдер берёт REST-сводку — первый абзац со срезанными скобками, —
 * и на этом останавливается. Разбирать по такому снимку нечего: ни разделов,
 * ни тела статьи. Второе: на живом прогоне Мордашова en-проверка искала
 * «Mordashov Aleksey Aleksandrovich», нашла страницу-дизамбигуацию и написала
 * «статьи нет», пока `en.wikipedia.org/wiki/Alexei_Mordashov` стояла в выдаче
 * того же отчёта. Межъязыковая ссылка ru-статьи называет её заголовок прямо.
 *
 * Формы ответов сняты с живых запросов 2026-08-20 (`formatversion=2`), сети в
 * тесте нет.
 */

const SEARCH_RU = {
  query: {
    search: [
      { title: "Мордашов, Алексей Александрович", pageid: 1, snippet: "российский предприниматель" },
    ],
  },
};

/** Живой ответ en-поиска: единственный кандидат — страница-дизамбигуация. */
const SEARCH_EN_MISS = {
  query: { search: [{ title: "Alexey", pageid: 9, snippet: "given name" }] },
};

const SUMMARY = {
  extract: "Алексей Александрович Мордашов — российский предприниматель.",
  content_urls: { desktop: { page: "https://ru.wikipedia.org/wiki/Мордашов" } },
};

const RU_ARTICLE_TEXT =
  "Алексей Александрович Мордашов (род. 26 сентября 1965) — российский предприниматель.\n\n" +
  "== Биография ==\nРодился в Череповце.\n\n" +
  "== Санкции ==\nВ 2022 году внесён в санкционные списки ЕС.\n";

const EN_ARTICLE_TEXT =
  "Alexei Aleksandrovich Mordashov is a Russian businessman.\n\n" +
  "== Sanctions ==\nHe was sanctioned by the EU in 2022.\n";

const LANGLINKS_RU = {
  query: {
    pages: [
      {
        pageid: 1,
        title: "Мордашов, Алексей Александрович",
        langlinks: [
          { lang: "de", title: "Alexei Alexandrowitsch Mordaschow" },
          { lang: "en", title: "Alexei Mordashov" },
        ],
      },
    ],
  },
};

type StubOptions = {
  /** Ответ поиска en-раздела (по умолчанию — живой промах). */
  searchEn?: unknown;
  /** Отдавать ли межъязыковые ссылки. */
  langlinks?: boolean;
  /** Ронять ли запрос полного текста. */
  extractsFail?: boolean;
};

function stubWikipedia(opts: StubOptions = {}): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    urls.push(u);
    const ru = u.startsWith("https://ru.");
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (u.includes("prop=extracts")) {
      if (opts.extractsFail) return new Response("nope", { status: 500 });
      return json({
        query: {
          pages: [
            {
              pageid: ru ? 1 : 2,
              title: ru ? "Мордашов, Алексей Александрович" : "Alexei Mordashov",
              extract: ru ? RU_ARTICLE_TEXT : EN_ARTICLE_TEXT,
            },
          ],
        },
      });
    }
    if (u.includes("prop=langlinks")) {
      return json(opts.langlinks === false ? { query: { pages: [{ pageid: 1 }] } } : LANGLINKS_RU);
    }
    if (u.includes("list=search")) {
      return json(ru ? SEARCH_RU : (opts.searchEn ?? SEARCH_EN_MISS));
    }
    return json(SUMMARY);
  });
  return urls;
}

async function lookup() {
  return wikipediaProvider.lookup({
    subjectFullName: "Мордашов Алексей Александрович",
    aliases: [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("полный текст статьи забирается одним вызовом extracts", () => {
  it("найденная статья приносит плейнтекст с заголовками разделов", async () => {
    const urls = stubWikipedia();
    const result = await lookup();
    const ru = result.languages.find((l) => l.language === "ru")!;
    expect(ru.exists).toBe(true);
    expect(ru.articleText).toContain("== Санкции ==");
    expect(ru.articleText).toContain("российский предприниматель");
    // Запрос — официальный API с плейнтекстом, а не разбор HTML.
    const extractsUrl = urls.find((u) => u.includes("prop=extracts") && u.startsWith("https://ru."));
    expect(extractsUrl).toBeDefined();
    expect(extractsUrl!).toContain("explaintext=1");
    expect(extractsUrl!).toContain("formatversion=2");
    expect(extractsUrl!).toContain("redirects=1");
  });

  it("текст статьи доезжает до снимка ответа провайдера", async () => {
    stubWikipedia();
    const result = await lookup();
    const raw = result.languages.find((l) => l.language === "ru")!.rawSnapshot as {
      articleText?: string;
      foundVia?: string;
      query?: string;
    };
    expect(raw.articleText).toContain("== Биография ==");
    expect(raw.foundVia).toBe("search");
    expect(raw.query).toBe("Мордашов Алексей Александрович");
  });

  it("отказ extracts не отменяет проверку: статья без текста — валидное состояние", async () => {
    stubWikipedia({ extractsFail: true });
    const result = await lookup();
    expect(result.status).toBe("SUCCESS");
    const ru = result.languages.find((l) => l.language === "ru")!;
    expect(ru.exists).toBe(true);
    expect(ru.matchedTitle).toBe("Мордашов, Алексей Александрович");
    expect(ru.articleText).toBeNull();
  });
});

describe("статья соседнего раздела ищется по межъязыковой ссылке", () => {
  it("промах поиска закрывается langlink статьи-источника", async () => {
    const urls = stubWikipedia();
    const result = await lookup();
    const en = result.languages.find((l) => l.language === "en")!;
    expect(en.exists).toBe(true);
    expect(en.matchedTitle).toBe("Alexei Mordashov");
    expect(en.url).toContain("Alexei_Mordashov");
    expect(en.foundVia).toBe("langlink");
    expect(en.langlinkOf).toEqual({ language: "ru", title: "Мордашов, Алексей Александрович" });
    expect(en.articleText).toContain("== Sanctions ==");
    // Спрашивали межъязыковые ссылки у раздела-источника, а не у пустого.
    expect(urls.some((u) => u.startsWith("https://ru.") && u.includes("prop=langlinks"))).toBe(true);
  });

  it("поисковый запрос раздела остаётся в снимке дословно", async () => {
    stubWikipedia();
    const result = await lookup();
    const raw = result.languages.find((l) => l.language === "en")!.rawSnapshot as {
      query?: string;
      foundVia?: string;
      langlinkOf?: { language?: string; title?: string };
    };
    // Страница печатает и запрос, и способ находки: «не нашла по этому запросу,
    // но статья есть» — два разных факта, и оба наблюдены.
    expect(raw.query).toBe("Mordashov Aleksey Aleksandrovich");
    expect(raw.foundVia).toBe("langlink");
    expect(raw.langlinkOf?.title).toBe("Мордашов, Алексей Александрович");
  });

  it("нет ссылки на этот язык — проверка остаётся отрицательной", async () => {
    stubWikipedia({ langlinks: false });
    const result = await lookup();
    const en = result.languages.find((l) => l.language === "en")!;
    expect(en.exists).toBe(false);
    expect(en.matchedTitle).toBeNull();
    expect(en.foundVia).toBeNull();
  });

  it("без статьи-источника межъязыковой проход не выполняется вовсе", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      urls.push(u);
      const body = u.includes("list=search") ? { query: { search: [] } } : LANGLINKS_RU;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await lookup();
    expect(result.languages.every((l) => l.exists === false)).toBe(true);
    expect(urls.some((u) => u.includes("prop=langlinks"))).toBe(false);
  });

  it("нашедший раздел межъязыковой ссылкой не переспрашивается", async () => {
    const urls = stubWikipedia({
      // Заголовок, который наша транслитерация узнаёт сама.
      searchEn: {
        query: { search: [{ title: "Aleksey Mordashov", pageid: 2, snippet: "businessman" }] },
      },
    });
    const result = await lookup();
    expect(result.languages.find((l) => l.language === "en")!.foundVia).toBe("search");
    expect(urls.some((u) => u.includes("prop=langlinks"))).toBe(false);
  });
});
