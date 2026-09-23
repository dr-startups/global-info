import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Панель «Это вы?» предлагает только статьи о людях с этим именем.
 *
 * Поиск Википедии полнотекстовый: он возвращает любую статью, в тексте которой
 * встречается имя, — страницу фамилии, область, где человек родился, награду,
 * федерацию, которой он руководил. На живом прогоне 23.09.2026 каждая такая
 * статья стала карточкой с кнопкой «Это я», и владелец назвал это дефектом.
 * Решение владельца: карточка — только статья о человеке: в заголовке названы
 * фамилия и имя (`isMatch` провайдера), и это не страница неоднозначности (по
 * признаку самой Википедии). Полные тёзки остаются: кто из них посетитель,
 * по-прежнему решает он сам.
 */

const calls: string[] = [];
const realFetch = globalThis.fetch;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const RU_SEARCH = [
  { title: "Петров, Иван Иванович (предприниматель)", pageid: 11, snippet: "предприниматель" },
  { title: "Петровы", pageid: 15, snippet: "фамилия" },
  { title: "Ленинградская область", pageid: 31, snippet: "Петров Иван Иванович — уроженец области" },
  { title: "Орден Почёта", pageid: 32, snippet: "Петров, Иван Иванович (2004)" },
  { title: "Петров, Иван", pageid: 16, snippet: "Петров, Иван — список однофамильцев" },
  { title: "Петров, Иван Иванович (футболист)", pageid: 12, snippet: "футболист" },
];

/** Страницы неоднозначности — по признаку самой Википедии (`pageprops.disambiguation`). */
const DISAMBIGUATION = new Set(["Петров, Иван"]);

const EN_SEARCH = [
  { title: "Russian Chess Federation", pageid: 41, snippet: "president Ivan Petrov" },
  { title: "Ivan Petrov (businessman)", pageid: 21, snippet: "businessman" },
];

function routeWikipedia(url: string): Response {
  calls.push(url);
  const parsed = new URL(url);
  const language = parsed.hostname.split(".")[0] ?? "ru";
  const params = parsed.searchParams;
  if (params.get("list") === "search") return json({ query: { search: language === "en" ? EN_SEARCH : RU_SEARCH } });
  if (params.get("prop") === "extracts") {
    const title = params.get("titles") ?? "";
    return json({ query: { pages: [{ title, extract: `${title} — вводная строка.` }] } });
  }
  if (params.get("prop") === "langlinks") return json({ query: { pages: [{ langlinks: [] }] } });
  if (params.get("prop") === "pageprops") {
    const pages = (params.get("titles") ?? "")
      .split("|")
      .map((title) => (DISAMBIGUATION.has(title) ? { title, pageprops: { disambiguation: "" } } : { title }));
    return json({ query: { pages } });
  }
  throw new Error(`неизвестный запрос Википедии: ${url}`);
}

type Provider = typeof import("@/modules/digital-profile/providers/wikipedia-provider");
let mod: Provider;

beforeAll(async () => {
  process.env.DIGITAL_PROFILE_WIKIPEDIA_MIN_INTERVAL_MS = "0";
  mod = await import("@/modules/digital-profile/providers/wikipedia-provider");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

function stubFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => routeWikipedia(String(input))) as typeof globalThis.fetch;
}

const TERMS = ["Петров Иван Иванович", "Petrov Ivan Ivanovich"];

describe("карточки панели — только люди с этим именем", () => {
  it("страница фамилии, область, награда и страница неоднозначности карточками не становятся", async () => {
    stubFetch();
    const result = await mod.wikipediaProvider.listNamesakeCandidates({ language: "ru", terms: TERMS, leadCount: 3 });
    expect(result.candidates.map((c) => c.title)).toEqual([
      "Петров, Иван Иванович (предприниматель)",
      "Петров, Иван Иванович (футболист)",
    ]);
  });

  it("английский раздел: федерация отсеяна, статья о человеке осталась", async () => {
    stubFetch();
    const result = await mod.wikipediaProvider.listNamesakeCandidates({ language: "en", terms: TERMS, leadCount: 3 });
    expect(result.candidates.map((c) => c.title)).toEqual(["Ivan Petrov (businessman)"]);
  });

  it("полные тёзки остаются оба — выбирает посетитель, а не отбор", async () => {
    stubFetch();
    const result = await mod.wikipediaProvider.listNamesakeCandidates({ language: "ru", terms: TERMS, leadCount: 3 });
    expect(result.candidates).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/"selected"/u);
  });

  it("лид тянется только статьям о людях", async () => {
    stubFetch();
    await mod.wikipediaProvider.listNamesakeCandidates({ language: "ru", terms: TERMS, leadCount: 3 });
    const extracted = calls
      .filter((u) => u.includes("prop=extracts"))
      .map((u) => new URL(u).searchParams.get("titles"));
    expect(extracted).toEqual(["Петров, Иван Иванович (предприниматель)", "Петров, Иван Иванович (футболист)"]);
  });
});
