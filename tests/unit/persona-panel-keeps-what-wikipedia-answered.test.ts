import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPersonaPanel,
  type PersonaPanelDeps,
} from "@/modules/digital-profile/services/subject-persona-check";

/**
 * Панель не теряет ответ Википедии из-за одного медленного раздела.
 *
 * Живой прогон 24.09.2026: у публичного лица со статьями в обоих разделах панель
 * показала только карточку OpenSanctions — снимок записал Википедии `TIMEOUT`
 * после 20 с. Разделы шли по очереди под одним бюджетом на весь источник:
 * медленный раздел съедал время соседа, а истёкший бюджет выбрасывал и тот
 * ответ, что уже пришёл. Причину самой задержки покажет журнал запросов.
 */

const SUBJECT = {
  caseId: "case-persona-wiki",
  fullName: "Петров Иван Иванович",
  aliases: [] as string[],
  dateOfBirth: "1970-03-05",
};

type WikipediaImpl = NonNullable<PersonaPanelDeps["wikipedia"]>;
type WikipediaAnswer = Awaited<ReturnType<WikipediaImpl>>;

function answer(language: string, title: string): WikipediaAnswer {
  return {
    language,
    query: "Петров Иван Иванович",
    candidates: [
      {
        title,
        pageId: language === "ru" ? 11 : 12,
        snippet: "предприниматель",
        url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
        lead: `${title} (род. 5 марта 1970) — предприниматель.`,
        leadRequested: true,
        langlinkTitle: null,
      },
    ],
  };
}

const quietSerper: NonNullable<PersonaPanelDeps["serper"]> = async () => ({ status: "SUCCESS", items: [] });
const emptySanctions: NonNullable<PersonaPanelDeps["openSanctions"]> = async () => ({
  status: "SUCCESS",
  provider: "OPEN_SANCTIONS",
  hits: [],
});

function wikipediaTitles(cards: Array<{ source: string; title?: string }>): string[] {
  return cards.filter((c) => c.source === "wikipedia").map((c) => String(c.title));
}

describe("ответ Википедии не теряется из-за медленного раздела", () => {
  it("ru ответил, en молчит дольше бюджета — карточка ru есть, источник ответил", async () => {
    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        budgetMs: 50,
        wikipedia: async ({ language }) => {
          if (language === "en") await new Promise((resolve) => setTimeout(resolve, 300));
          return answer(language, language === "ru" ? "Петров, Иван Иванович" : "Ivan Petrov");
        },
        serper: quietSerper,
        openSanctions: emptySanctions,
      },
    });
    expect(wikipediaTitles(snapshot.cards)).toEqual(["Петров, Иван Иванович"]);
    expect(snapshot.sources.find((s) => s.source === "wikipedia")?.status).toBe("SUCCESS");
  });

  it("разделы спрашиваются одновременно, а не по очереди", async () => {
    // ru отвечает только после того, как начался en: очередь ru → en здесь — взаимная
    // блокировка до конца бюджета, параллельные разделы отвечают оба.
    let enStarted: () => void = () => {};
    const enHasStarted = new Promise<void>((resolve) => {
      enStarted = resolve;
    });
    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        budgetMs: 200,
        wikipedia: async ({ language }) => {
          if (language === "en") enStarted();
          else await enHasStarted;
          return answer(language, language === "ru" ? "Петров, Иван Иванович" : "Ivan Petrov");
        },
        serper: quietSerper,
        openSanctions: emptySanctions,
      },
    });
    expect(wikipediaTitles(snapshot.cards).sort()).toEqual(["Ivan Petrov", "Петров, Иван Иванович"]);
    expect(snapshot.sources.find((s) => s.source === "wikipedia")?.status).toBe("SUCCESS");
  });
});

describe("каждый запрос Википедии оставляет строку журнала", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("строка на запрос: язык, вид, статус, время — без имени человека", async () => {
    vi.stubEnv("DIGITAL_PROFILE_WIKIPEDIA_MIN_INTERVAL_MS", "0");
    vi.resetModules();
    const urls: string[] = [];
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      urls.push(url);
      const params = new URL(url).searchParams;
      const body =
        params.get("list") === "search"
          ? { query: { search: [{ title: "Петров, Иван Иванович", pageid: 11, snippet: "предприниматель" }] } }
          : params.get("prop") === "extracts"
            ? { query: { pages: [{ extract: "Иван Иванович Петров (род. 5 марта 1970) — предприниматель." }] } }
            : params.get("prop") === "langlinks"
              ? { query: { pages: [{ langlinks: [] }] } }
              : { query: { pages: [{ title: "Петров, Иван Иванович" }] } };
      return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
    }) as typeof globalThis.fetch;
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    const { wikipediaProvider } = await import("@/modules/digital-profile/providers/wikipedia-provider");
    await wikipediaProvider.listNamesakeCandidates({
      language: "ru",
      terms: ["Петров Иван Иванович"],
      leadCount: 3,
      langlinkTo: "en",
    });

    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e?.event === "wikipedia_request");
    expect(urls.length).toBeGreaterThan(0);
    expect(events).toHaveLength(urls.length);
    expect(events.map((e) => e.kind)).toEqual(["search", "pageprops", "extracts", "langlinks"]);
    for (const e of events) {
      expect(e.lang).toBe("ru");
      expect(e.status).toBe(200);
      expect(typeof e.ms).toBe("number");
    }
    expect(lines.join("\n")).not.toMatch(/Петров|%D0/u);
  });
});
