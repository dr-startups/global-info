import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildPersonaPanel } from "@/modules/digital-profile/services/subject-persona-check";

/**
 * MediaWiki отвечает кодом 200 и телом `{"error":{"code":"maxlag"|…}}`.
 *
 * Смотреть только на `res.ok` значит принять отказ источника за «никого не
 * нашли»: `query.search` в таком теле нет вовсе, кандидатов ноль, и панель
 * напишет «Википедия: ответил» ровно там, где Википедия отказала. Пустое
 * состояние честнее выдуманного только тогда, когда названа причина.
 */

const MAXLAG_BODY = {
  error: { code: "maxlag", info: "Waiting for a database server: 5 seconds lagged." },
};

const realFetch = globalThis.fetch;
const calls: string[] = [];

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
  calls.length = 0;
});

/** Всё отвечает телом ошибки MediaWiki — при коде 200. */
function stubErrorBody(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return json(MAXLAG_BODY);
  }) as typeof globalThis.fetch;
}

describe("ответ MediaWiki с телом ошибки — отказ, а не пустая выдача", () => {
  it("поиск кандидатов отказывает с названным кодом MediaWiki", async () => {
    stubErrorBody();
    const failure = await mod.wikipediaProvider
      .listNamesakeCandidates({ language: "ru", terms: ["Петров Иван Иванович"], leadCount: 3 })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toContain("maxlag");
  });

  it("панель называет Википедию отказавшей, а не ответившей пустотой", async () => {
    stubErrorBody();
    const { snapshot } = await buildPersonaPanel({
      subject: {
        caseId: "case-wikipedia-error-body",
        fullName: "Петров Иван Иванович",
        aliases: [],
        dateOfBirth: "1970-03-05",
      },
      deps: {
        wikipedia: (params) => mod.wikipediaProvider.listNamesakeCandidates(params),
        serper: async () => ({ status: "SUCCESS", items: [] }),
        openSanctions: async () => ({ status: "SUCCESS", provider: "OPEN_SANCTIONS", hits: [] }),
      },
    });
    const wikipedia = snapshot.sources.find((s) => s.source === "wikipedia");
    expect(wikipedia?.status).toBe("FAILED");
    expect(wikipedia?.code).toBe("PROVIDER_REQUEST_FAILED");
    expect(String(wikipedia?.detail ?? "")).toContain("maxlag");
    expect(snapshot.cards).toEqual([]);
  });

  it("прежний путь провайдера тоже не выдаёт отказ за «статьи нет»", async () => {
    stubErrorBody();
    const result = await mod.wikipediaProvider.lookup({
      subjectFullName: "Петров Иван Иванович",
      aliases: [],
    });
    expect(result.status).toBe("FAILED");
    expect(result.languages.some((l) => l.exists)).toBe(false);
  });

  it("тело без `error` отказом не считается", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      const url = new URL(String(input));
      if (url.searchParams.get("list") === "search") {
        return json({ query: { search: [{ title: "Петров", pageid: 1, snippet: "инженер" }] } });
      }
      return json({ query: { pages: [{ title: "Петров", extract: "Пётр Петров — инженер." }] } });
    }) as typeof globalThis.fetch;
    const result = await mod.wikipediaProvider.listNamesakeCandidates({
      language: "ru",
      terms: ["Петров"],
      leadCount: 1,
    });
    expect(result.candidates.map((c) => c.title)).toEqual(["Петров"]);
  });
});
