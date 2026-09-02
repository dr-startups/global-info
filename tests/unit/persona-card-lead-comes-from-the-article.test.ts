import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Прямая защита от возвращения дефекта Мордашова.
 *
 * REST-сводка срезает скобки первого предложения, а у персон именно в них
 * стоит полная дата рождения — то есть единственная примета, по которой
 * оператор отличает тёзку. Лид карточки берётся из статьи
 * (`prop=extracts&explaintext`), и сводка на этом пути не спрашивается вовсе.
 *
 * Панели нужна только вводная секция (`exintro`): полный текст крупной
 * персоналии — сотни килобайт, а панель тянет шесть таких подряд под общим
 * бюджетом в двадцать секунд. Прежний путь провайдера (разбор статьи) просит
 * текст целиком, как и просил.
 */

/** Вводная секция: первая строка несёт дату рождения в скобках. */
const RU_INTRO =
  "Иван Иванович Петров (род. 5 марта 1970, Ленинград) — российский предприниматель, основатель компании «Пример».";

/** Полный текст той же статьи — с разделами. */
const RU_FULL_TEXT = RU_INTRO + "\n\n== Биография ==\nРодился в семье инженеров.";

/** Та же статья глазами REST-сводки: скобок нет, даты нет. */
const RU_SUMMARY_EXTRACT = "Иван Иванович Петров — российский предприниматель.";

type FetchCall = string;

const calls: FetchCall[] = [];
const realFetch = globalThis.fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const RU_SEARCH = [
  { title: "Петров, Иван Иванович (предприниматель)", pageid: 11, snippet: "предприниматель" },
  { title: "Петров, Иван Иванович (футболист)", pageid: 12, snippet: "футболист" },
  { title: "Петров, Иван Иванович", pageid: 13, snippet: "учёный" },
  { title: "Петров, Иван Иванович (хоккеист)", pageid: 14, snippet: "хоккеист" },
  { title: "Петровы", pageid: 15, snippet: "фамилия" },
];

const EN_SEARCH = [
  { title: "Ivan Petrov (businessman)", pageid: 21, snippet: "businessman" },
  { title: "Ivan Petrov (bass)", pageid: 22, snippet: "opera singer" },
];

/** У этих статей вводная секция пуста, а тело есть. */
const EMPTY_INTRO = new Set<string>(["Петров, Иван Иванович"]);

const FULL_TEXT_BY_TITLE: Record<string, string> = {
  "Петров, Иван Иванович (предприниматель)": RU_FULL_TEXT,
  "Петров, Иван Иванович (футболист)":
    "Иван Иванович Петров (род. 1 января 1988, Москва) — российский футболист.",
  "Петров, Иван Иванович": "Иван Иванович Петров (1901—1975) — советский учёный.",
  "Петров, Иван Иванович (хоккеист)": "Иван Иванович Петров — российский хоккеист.",
  Петровы: "Петровы — русская фамилия.",
  "Ivan Petrov (businessman)": "Ivan Ivanovich Petrov (born 5 March 1970) is a Russian businessman.",
  "Ivan Petrov (bass)": "Ivan Petrov (1920—2003) was a Soviet opera singer.",
};

function routeWikipedia(url: string): Response {
  calls.push(url);
  const parsed = new URL(url);
  const language = parsed.hostname.split(".")[0] ?? "ru";
  if (parsed.pathname.includes("/api/rest_v1/page/summary/")) {
    return json({
      extract: RU_SUMMARY_EXTRACT,
      content_urls: { desktop: { page: `https://${language}.wikipedia.org/wiki/Пример` } },
    });
  }
  const params = parsed.searchParams;
  if (params.get("list") === "search") {
    return json({ query: { search: language === "en" ? EN_SEARCH : RU_SEARCH } });
  }
  if (params.get("prop") === "extracts") {
    const title = params.get("titles") ?? "";
    const full = FULL_TEXT_BY_TITLE[title] ?? "";
    if (params.get("exintro")) {
      // Статья-заготовка: вводной секции нет, тело есть. Живой случай, и
      // молчать о нём нельзя — карточка иначе выродится в голый заголовок.
      const intro = EMPTY_INTRO.has(title) ? "" : (full.split("\n\n== ")[0] ?? "");
      return json({ query: { pages: [{ title, extract: intro }] } });
    }
    return json({ query: { pages: [{ title, extract: full }] } });
  }
  if (params.get("prop") === "langlinks") {
    const title = params.get("titles") ?? "";
    return json({
      query: {
        pages: [
          {
            langlinks:
              title === "Петров, Иван Иванович (предприниматель)"
                ? [{ lang: "en", title: "Ivan Petrov (businessman)" }]
                : [],
          },
        ],
      },
    });
  }
  throw new Error(`неизвестный запрос Википедии: ${url}`);
}

type Provider = typeof import("@/modules/digital-profile/providers/wikipedia-provider");
let mod: Provider;

beforeAll(async () => {
  // Пауза между вызовами провайдера здесь только замедляет проверку: сеть
  // подменена, и щадить нечего.
  process.env.DIGITAL_PROFILE_WIKIPEDIA_MIN_INTERVAL_MS = "0";
  mod = await import("@/modules/digital-profile/providers/wikipedia-provider");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

describe("лид карточки тёзки", () => {
  function stubFetch(): void {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      routeWikipedia(String(input))) as typeof globalThis.fetch;
  }

  it("берётся из статьи, а не из REST-сводки", async () => {
    stubFetch();
    const result = await mod.wikipediaProvider.listNamesakeCandidates({
      language: "ru",
      terms: ["Петров Иван Иванович"],
      leadCount: 3,
    });
    expect(result.candidates[0]?.lead).toBe(RU_INTRO);
    expect(result.candidates[0]?.lead).toContain("5 марта 1970");
    // Мутационная точка: если лид начнут брать из сводки, здесь появится её
    // адрес, а строка выше потеряет дату.
    expect(calls.filter((u) => u.includes("/api/rest_v1/page/summary/"))).toEqual([]);
  });

  it("панель просит вводную секцию, а не статью целиком", async () => {
    stubFetch();
    await mod.wikipediaProvider.listNamesakeCandidates({
      language: "ru",
      terms: ["Петров Иван Иванович"],
      leadCount: 3,
    });
    const extracts = calls.filter((u) => u.includes("prop=extracts"));
    expect(extracts).toHaveLength(3);
    for (const url of extracts) expect(url).toContain("exintro=1");
  });

  it("пустая вводная секция — названное состояние, а не молчание", async () => {
    stubFetch();
    const result = await mod.wikipediaProvider.listNamesakeCandidates({
      language: "ru",
      terms: ["Петров Иван Иванович"],
      leadCount: 3,
    });
    // Лид спрашивали и не получили: панель обязана сказать это словами, а не
    // показать карточку из одного заголовка.
    expect(result.candidates[2]?.leadRequested).toBe(true);
    expect(result.candidates[2]?.lead).toBeNull();
    expect(result.candidates[2]?.snippet).toBe("учёный");
  });

  it("хвост поиска показывается сниппетом, а лид ему не тянется", async () => {
    stubFetch();
    const result = await mod.wikipediaProvider.listNamesakeCandidates({
      language: "ru",
      terms: ["Петров Иван Иванович"],
      leadCount: 3,
    });
    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.slice(0, 3).map((c) => c.leadRequested)).toEqual([true, true, true]);
    expect(result.candidates.slice(3).map((c) => c.leadRequested)).toEqual([false, false]);
    expect(result.candidates[4]?.lead).toBeNull();
    expect(result.candidates[4]?.snippet).toBe("фамилия");
    expect(calls.filter((u) => u.includes("prop=extracts"))).toHaveLength(3);
  });

  it("межъязыковая ссылка спрашивается только у кандидатов с лидом", async () => {
    stubFetch();
    const result = await mod.wikipediaProvider.listNamesakeCandidates({
      language: "ru",
      terms: ["Петров Иван Иванович"],
      leadCount: 3,
      langlinkTo: "en",
    });
    expect(result.candidates[0]?.langlinkTitle).toBe("Ivan Petrov (businessman)");
    expect(result.candidates[1]?.langlinkTitle).toBeNull();
    expect(result.candidates[4]?.langlinkTitle).toBeNull();
    expect(calls.filter((u) => u.includes("prop=langlinks"))).toHaveLength(3);
  });

  it("адрес статьи в карточке есть у каждого кандидата", async () => {
    stubFetch();
    const result = await mod.wikipediaProvider.listNamesakeCandidates({
      language: "ru",
      terms: ["Петров Иван Иванович"],
      leadCount: 3,
    });
    for (const candidate of result.candidates) {
      expect(candidate.url).toMatch(/^https:\/\/ru\.wikipedia\.org\/wiki\//u);
    }
  });

  it("формы имени строит тот же код, что и сбор", () => {
    expect(mod.subjectTerms("Петров Иван", ["Петров Иван"])).toEqual([
      "Петров Иван",
      "Petrov Ivan",
    ]);
  });

  it("прежний путь провайдера не изменился: lookup по-прежнему выбирает одну статью", async () => {
    stubFetch();
    const result = await mod.wikipediaProvider.lookup({
      subjectFullName: "Петров Иван Иванович",
      aliases: [],
    });
    expect(result.status).toBe("SUCCESS");
    const ru = result.languages.find((l) => l.language === "ru");
    expect(ru?.matchedTitle).toBe("Петров, Иван Иванович (предприниматель)");
    // Разбору статьи нужны разделы целиком — вводной секцией он не обходится.
    expect(ru?.articleText).toBe(RU_FULL_TEXT);
    expect(ru?.articleText).toContain("== Биография ==");
    expect(calls.filter((u) => u.includes("prop=extracts") && u.includes("exintro"))).toEqual([]);
    expect(ru?.extract).toBe(RU_SUMMARY_EXTRACT);
    expect(ru?.candidates).toHaveLength(5);
  });
});
