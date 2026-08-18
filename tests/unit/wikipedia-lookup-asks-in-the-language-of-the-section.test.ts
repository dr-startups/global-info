import { afterEach, describe, expect, it, vi } from "vitest";
import { wikipediaProvider } from "@/modules/digital-profile/providers/wikipedia-provider";

/**
 * Языковой раздел спрашивают на его языке.
 *
 * На прогоне 76 en-проверка ушла кириллическим запросом «Рашников Виктор
 * Филиппович», вернула `exists=false` — и отчёт напечатал «статья не найдена»
 * рядом с `en.wikipedia.org/wiki/Viktor_Rashnikov` в таблице выдачи того же
 * документа. Латиница у субъекта уже была: ею собирались запросы ОАЭ.
 *
 * Ответы — формы настоящего ответа API (`action=query&list=search` и
 * `page/summary`), снятые с живого снимка. Сети в тесте нет.
 */

const SEARCH_RU = {
  query: {
    search: [
      { title: "Рашников, Виктор Филиппович", pageid: 1, snippet: "российский предприниматель" },
    ],
  },
};
const SEARCH_EN = {
  query: {
    search: [{ title: "Viktor Rashnikov", pageid: 2, snippet: "Russian businessman" }],
  },
};
const SUMMARY = {
  extract: "Виктор Филиппович Рашников — российский предприниматель.",
  content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Viktor_Rashnikov" } },
};

function stubWikipedia(): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(String(url));
    const isSearch = String(url).includes("list=search");
    const body = isSearch
      ? String(url).startsWith("https://ru.")
        ? SEARCH_RU
        : SEARCH_EN
      : SUMMARY;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return urls;
}

/** Запрос, ушедший в раздел `language`, — как его видит сам сервис. */
function searchQuery(urls: string[], language: string): string {
  const url = urls.find((u) => u.startsWith(`https://${language}.`) && u.includes("list=search"));
  if (!url) return "";
  return decodeURIComponent(new URL(url).searchParams.get("srsearch") ?? "");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("проверка Википедии по языковым разделам", () => {
  it("русский раздел спрашивается кириллицей, английский — латиницей", async () => {
    const urls = stubWikipedia();
    const result = await wikipediaProvider.lookup({
      subjectFullName: "Рашников Виктор Филиппович",
      aliases: [],
    });
    expect(result.status).toBe("SUCCESS");
    expect(searchQuery(urls, "ru")).toBe("Рашников Виктор Филиппович");
    expect(searchQuery(urls, "en")).toBe("Rashnikov Viktor Filippovich");
  });

  it("латинский псевдоним субъекта важнее машинной транслитерации", async () => {
    const urls = stubWikipedia();
    await wikipediaProvider.lookup({
      subjectFullName: "Рашников Виктор Филиппович",
      aliases: ["Viktor Rashnikov"],
    });
    expect(searchQuery(urls, "en")).toBe("Viktor Rashnikov");
  });

  it("запрос раздела записан в снимок и термы не задвоены", async () => {
    stubWikipedia();
    const result = await wikipediaProvider.lookup({
      // Живой случай: тот же терм пришёл дважды.
      subjectFullName: "Рашников Виктор Филиппович",
      aliases: ["Рашников Виктор Филиппович", "Viktor Rashnikov"],
    });
    const byLanguage = new Map(result.languages.map((l) => [l.language, l]));
    const en = byLanguage.get("en")!.rawSnapshot as { query: string; terms: string[] };
    const ru = byLanguage.get("ru")!.rawSnapshot as { query: string; terms: string[] };
    expect(en.query).toBe("Viktor Rashnikov");
    expect(ru.query).toBe("Рашников Виктор Филиппович");
    expect(en.terms).toEqual([...new Set(en.terms)]);
    expect(en.terms).toContain("Viktor Rashnikov");
  });

  it("субъект с латинским именем спрашивается им во всех разделах", async () => {
    const urls = stubWikipedia();
    await wikipediaProvider.lookup({ subjectFullName: "Anders Holmström", aliases: [] });
    expect(searchQuery(urls, "ru")).toBe("Anders Holmström");
    expect(searchQuery(urls, "en")).toBe("Anders Holmström");
  });
});
