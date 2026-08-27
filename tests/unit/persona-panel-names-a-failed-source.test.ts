import { describe, expect, it } from "vitest";
import {
  buildPersonaPanel,
  type PersonaPanelDeps,
} from "@/modules/digital-profile/services/subject-persona-check";

/**
 * Пустое состояние честнее выдуманного: отказ источника панель называет
 * словами и продолжает работать на остальных, а «источник молчит» и «источник
 * не уложился в бюджет» — разные ответы, и второй нельзя записывать первым.
 *
 * Слова живут в словарях кабинета, снимок несёт код причины и техническую
 * подробность провайдера: готовая русская фраза, собранная на сервере,
 * печаталась бы и в английском кабинете.
 */

const SUBJECT = {
  caseId: "case-persona-failure",
  fullName: "Петров Иван Иванович",
  aliases: [] as string[],
  dateOfBirth: "1970-03-05",
};

const workingWikipedia: NonNullable<PersonaPanelDeps["wikipedia"]> = async ({ language }) => ({
  language,
  query: "Петров Иван Иванович",
  candidates:
    language === "ru"
      ? [
          {
            title: "Петров, Иван Иванович (предприниматель)",
            pageId: 11,
            snippet: "предприниматель",
            url: "https://ru.wikipedia.org/wiki/Петров",
            lead: "Иван Иванович Петров (род. 5 марта 1970) — предприниматель.",
            leadRequested: true,
            langlinkTitle: null,
          },
        ]
      : [],
});

const throwingSerper: NonNullable<PersonaPanelDeps["serper"]> = async () => {
  throw new Error("serper 503");
};

const notConfiguredSerper: NonNullable<PersonaPanelDeps["serper"]> = async () => ({
  status: "NOT_CONFIGURED",
  items: [],
  error: "Serper API key not configured",
});

const emptySanctions: NonNullable<PersonaPanelDeps["openSanctions"]> = async () => ({
  status: "SUCCESS",
  provider: "OPEN_SANCTIONS",
  hits: [],
});

describe("отказ источника называется словами и панель не отменяет", () => {
  it("один источник упал — панель собрана из остальных, у отказавшего есть код и причина", async () => {
    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        wikipedia: workingWikipedia,
        serper: throwingSerper,
        openSanctions: emptySanctions,
      },
    });
    expect(snapshot.fetchStatus).toBe("SUCCESS");
    expect(snapshot.cards).toHaveLength(1);
    const serper = snapshot.sources.find((s) => s.source === "knowledge_graph");
    expect(serper?.status).toBe("FAILED");
    expect(serper?.code).toBe("PROVIDER_REQUEST_FAILED");
    expect(serper?.detail).toContain("serper 503");
    expect(snapshot.sources.find((s) => s.source === "wikipedia")?.status).toBe("SUCCESS");
  });

  it("источник без ключа назван ненастроенным, а не отказавшим", async () => {
    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        wikipedia: workingWikipedia,
        serper: notConfiguredSerper,
        openSanctions: emptySanctions,
      },
    });
    const serper = snapshot.sources.find((s) => s.source === "knowledge_graph");
    expect(serper?.status).toBe("NOT_CONFIGURED");
    expect(serper?.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(serper?.detail).toBe("Serper API key not configured");
  });

  it("отказали все три — пустая панель с причинами, а не исключение", async () => {
    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        wikipedia: async () => {
          throw new Error("wikipedia 429");
        },
        serper: throwingSerper,
        openSanctions: async () => {
          throw new Error("opensanctions 500");
        },
      },
    });
    expect(snapshot.fetchStatus).toBe("FAILED");
    expect(snapshot.cards).toEqual([]);
    expect(snapshot.sources.map((s) => s.status)).toEqual(["FAILED", "FAILED", "FAILED"]);
    for (const source of snapshot.sources) {
      expect(source.code, source.source).toBe("PROVIDER_REQUEST_FAILED");
      expect(source.detail, source.source).toBeTruthy();
    }
    expect(snapshot.errorCode).toBe("ALL_SOURCES_FAILED");
  });

  it("не уложившийся в общий бюджет источник получает TIMEOUT, а не «нет данных»", async () => {
    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        budgetMs: 20,
        wikipedia: workingWikipedia,
        serper: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { status: "SUCCESS", items: [] };
        },
        openSanctions: emptySanctions,
      },
    });
    const serper = snapshot.sources.find((s) => s.source === "knowledge_graph");
    expect(serper?.status).toBe("TIMEOUT");
    expect(serper?.code).toBe("PERSONA_PANEL_BUDGET_EXCEEDED");
    // Ожидание одного источника не отменяет ответов остальных.
    expect(snapshot.fetchStatus).toBe("SUCCESS");
    expect(snapshot.cards).toHaveLength(1);
  });

  it("нет карточек, но источники ответили — валидное состояние, а не отказ", async () => {
    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        wikipedia: async ({ language }) => ({ language, query: "нет такого", candidates: [] }),
        serper: async () => ({ status: "SUCCESS", items: [] }),
        openSanctions: emptySanctions,
      },
    });
    expect(snapshot.fetchStatus).toBe("SUCCESS");
    expect(snapshot.cards).toEqual([]);
    expect(snapshot.errorCode).toBeNull();
  });
});
