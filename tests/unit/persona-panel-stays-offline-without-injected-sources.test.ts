import { afterEach, describe, expect, it } from "vitest";
import {
  PERSONA_PANEL_SERPER_LIMIT,
  buildPersonaPanel,
  type PersonaPanelDeps,
} from "@/modules/digital-profile/services/subject-persona-check";
import { serperOrganicWithExtras } from "@/modules/digital-profile/providers/serper-surfaces";

/**
 * `NETWORK_CALLS=0` — условие офлайн-контура, и право вето за ним.
 *
 * «Разрешение — ключ» держит здесь не всех: без ключа молчит только Serper.
 * Википедия и OpenSanctions включены по умолчанию и ключа не требуют — без
 * явного вето первый же тест, забывший подставить источник, ушёл бы в сеть на
 * машине разработчика и в CI.
 */

const SUBJECT = {
  caseId: "case-persona-offline",
  fullName: "Петров Иван Иванович",
  aliases: [] as string[],
  dateOfBirth: "1970-03-05",
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function countingFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error("офлайн-контур в сеть не ходит");
  }) as typeof globalThis.fetch;
  return { calls };
}

describe("панель в офлайне в сеть не ходит вовсе", () => {
  it("без подставленных источников не выполняется ни одного запроса", async () => {
    expect(process.env.NETWORK_CALLS).toBe("0");
    const counter = countingFetch();
    const { snapshot } = await buildPersonaPanel({ subject: SUBJECT });
    // Мутационная точка: снимут вето — счётчик перестанет быть нулём.
    expect(counter.calls).toEqual([]);
    expect(snapshot.sources.map((s) => s.status)).toEqual(["OFFLINE", "OFFLINE", "OFFLINE"]);
    for (const source of snapshot.sources) {
      expect(source.code, source.source).toBe("NETWORK_CALLS_DISABLED");
      // Провайдера не спрашивали — технической подробности взяться неоткуда, а
      // слова оператору даёт словарь кабинета по коду выше.
      expect(source.detail, source.source).toBeNull();
    }
    expect(snapshot.cards).toEqual([]);
    expect(snapshot.fetchStatus).toBe("FAILED");
    expect(snapshot.errorCode).toBe("NETWORK_CALLS_DISABLED");
  });

  it("подставленный источник сетью не является и вето его не касается", async () => {
    const counter = countingFetch();
    const deps: PersonaPanelDeps = {
      wikipedia: async ({ language }) => ({
        language,
        query: "Петров Иван Иванович",
        candidates:
          language === "ru"
            ? [
                {
                  title: "Петров, Иван Иванович",
                  pageId: 11,
                  snippet: "предприниматель",
                  url: "https://ru.wikipedia.org/wiki/Петров",
                  lead: "Иван Иванович Петров (род. 5 марта 1970) — предприниматель.",
                  leadRequested: true,
                  langlinkTitle: null,
                },
              ]
            : [],
      }),
    };
    const { snapshot } = await buildPersonaPanel({ subject: SUBJECT, deps });
    expect(counter.calls).toEqual([]);
    expect(snapshot.sources.find((s) => s.source === "wikipedia")?.status).toBe("SUCCESS");
    // Источники, которых не подставили, вето по-прежнему держит.
    expect(snapshot.sources.find((s) => s.source === "knowledge_graph")?.status).toBe("OFFLINE");
    expect(snapshot.sources.find((s) => s.source === "opensanctions")?.status).toBe("OFFLINE");
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.fetchStatus).toBe("SUCCESS");
  });
});

describe("Serper без ключа молчит и не платит", () => {
  it("прямой вызов отдаёт NOT_CONFIGURED до сети", async () => {
    const counter = countingFetch();
    const result = await serperOrganicWithExtras(
      {
        caseId: SUBJECT.caseId,
        subjectFullName: SUBJECT.fullName,
        aliases: [],
        query: SUBJECT.fullName,
      },
      "RU",
      10
    );
    expect(result.status).toBe("NOT_CONFIGURED");
    expect(result.items).toEqual([]);
    expect(counter.calls).toEqual([]);
  });

  it("панель просит у Serper не более десяти результатов — иначе запрос стоит вдвое", async () => {
    const limits: number[] = [];
    await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        serper: async (_request, _region, limit) => {
          limits.push(limit);
          return { status: "SUCCESS", items: [] };
        },
      },
    });
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.length).toBeLessThanOrEqual(2);
    for (const limit of limits) expect(limit).toBeLessThanOrEqual(10);
    expect(PERSONA_PANEL_SERPER_LIMIT).toBeLessThanOrEqual(10);
  });
});
