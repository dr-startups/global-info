import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Сниппет поиска стал текстом, который читает человек.
 *
 * `list=search` отдаёт его размеченным и с HTML-сущностями: «уч&#1105;ный»,
 * «Ren&#233;», «&quot;». Снятия тегов мало — раньше сниппет никому не показывался, а теперь
 * это единственные слова на хвостовой карточке, и машинная запись в них
 * читается как порча данных.
 */

const SNIPPET_RAW =
  '<span class="searchmatch">уч&#1105;ный</span> Ren&#233;, &quot;автор&quot; книг &amp; статей &#x27;90-х';

const realFetch = globalThis.fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type Provider = typeof import("@/modules/digital-profile/providers/wikipedia-provider");
let mod: Provider;

beforeAll(async () => {
  process.env.DIGITAL_PROFILE_WIKIPEDIA_MIN_INTERVAL_MS = "0";
  mod = await import("@/modules/digital-profile/providers/wikipedia-provider");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("сниппет карточки — человеческий текст", () => {
  it("теги сняты, сущности раскрыты", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("list") === "search") {
        return json({
          query: { search: [{ title: "Петров, Иван", pageid: 7, snippet: SNIPPET_RAW }] },
        });
      }
      return json({ query: { pages: [{ title: "Петров, Иван", extract: "" }] } });
    }) as typeof globalThis.fetch;

    const result = await mod.wikipediaProvider.listNamesakeCandidates({
      language: "ru",
      terms: ["Петров Иван"],
      leadCount: 0,
    });
    expect(result.candidates[0]?.snippet).toBe("учёный René, \"автор\" книг & статей '90-х");
  });
});
