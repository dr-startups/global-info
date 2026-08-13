import { describe, expect, it } from "vitest";
import {
  analyzeLinkPage,
  analyzeLinkPages,
  unreadVerdict,
} from "@/modules/digital-profile/orion-golden/analytics/link-verdict-analyst";
import type { LinkPageRead } from "@/modules/digital-profile/services/link-page-reader";

const READ_AT = "2026-08-14T09:00:00.000Z";

const page: LinkPageRead = {
  ok: true,
  url: "https://example.com/a",
  text: "Суд удовлетворил иск бывшей супруги о разделе активов. ".repeat(6),
  title: "Иск о разделе активов",
  readAt: READ_AT,
};

function input(over: Partial<Parameters<typeof analyzeLinkPage>[0]> = {}) {
  return {
    evidenceRef: "inventory:obs-1",
    url: "https://example.com/a",
    domain: "example.com",
    rank: 3,
    query: "иванов иван",
    subject: { fullName: "Иванов Иван Иванович" },
    page,
    ...over,
  };
}

function answer(body: Record<string, unknown>) {
  return (async () => body) as never;
}

describe("решение по прочитанной странице", () => {
  it("принимает структурное решение модели", async () => {
    const v = await analyzeLinkPage(input(), {
      call: answer({
        subjectMatch: "subject",
        tone: "adverse",
        theme: "Судебный спор с бывшей супругой о разделе активов",
        quotes: [{ text: "Суд удовлетворил иск бывшей супруги о разделе активов" }],
      }),
    });
    expect(v.tone).toBe("adverse");
    expect(v.theme).toBe("Судебный спор с бывшей супругой о разделе активов");
    expect(v.rank).toBe(3);
    expect(v.readAt).toBe(READ_AT);
  });

  it("нежелательный вывод без цитаты не принимается на веру", async () => {
    // Без цитаты это мнение модели, а не факт со страницы.
    const v = await analyzeLinkPage(input(), {
      call: answer({ subjectMatch: "subject", tone: "adverse", theme: "Коррупционные связи", quotes: [] }),
    });
    expect(v.tone).toBe("neutral");
    expect(v.subjectMatch).toBe("unclear");
  });

  it("однофамилец назван прямо, а не растворён в тексте", async () => {
    const v = await analyzeLinkPage(input(), {
      call: answer({
        subjectMatch: "other",
        tone: "adverse",
        theme: "Приговор однофамильцу",
        quotes: [{ text: "осуждён Иванов Пётр Сергеевич, 1970 года рождения" }],
      }),
    });
    expect(v.subjectMatch).toBe("other");
  });

  it("непрочитанная страница не получает выдуманного вывода", async () => {
    const failed: LinkPageRead = {
      ok: false,
      url: "https://example.com/a",
      failure: "blocked",
      message: "HTTP 403",
      readAt: READ_AT,
    };
    const v = await analyzeLinkPage(input({ page: failed, serpTitle: "Заголовок из выдачи" }));
    expect(v.readFailure).toBe("blocked");
    expect(v.tone).toBe("neutral");
    expect(v.subjectMatch).toBe("unclear");
  });

  it("отказ модели превращается в честное «не знаем», а не в вывод", async () => {
    const v = await analyzeLinkPage(input(), {
      call: (async () => {
        throw new Error("openai-timeout");
      }) as never,
    });
    expect(v.readFailure).toBeDefined();
    expect(v.tone).toBe("neutral");
  });

  it("ответ не по форме отбрасывается целиком", async () => {
    const v = await analyzeLinkPage(input(), {
      call: answer({ subjectMatch: "да", tone: "плохо", theme: "" }),
    });
    expect(v.subjectMatch).toBe("unclear");
    expect(v.readFailure).toBeDefined();
  });

  it("цитаты обрезаются по числу и длине", async () => {
    const v = await analyzeLinkPage(input(), {
      call: answer({
        subjectMatch: "subject",
        tone: "adverse",
        theme: "Тема",
        quotes: [
          { text: "а".repeat(500) },
          { text: "б".repeat(50) },
          { text: "в".repeat(50) },
          { text: "г".repeat(50) },
          { text: "короткая" },
        ],
      }),
    });
    expect(v.quotes).toHaveLength(3);
    expect(v.quotes[0]!.text).toHaveLength(400);
  });
});

describe("решения по странице выдачи", () => {
  it("сохраняют порядок ссылок", async () => {
    const inputs = [1, 2, 3, 4, 5].map((i) =>
      input({ evidenceRef: `inventory:obs-${i}`, url: `https://example.com/${i}`, rank: i })
    );
    const verdicts = await analyzeLinkPages(inputs, {
      call: answer({ subjectMatch: "subject", tone: "neutral", theme: "Деловой профиль", quotes: [] }),
      concurrency: 3,
    });
    expect(verdicts.map((v) => v.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("непрочитанная страница", () => {
  it("берёт заголовок из выдачи как описание, но не как вывод", () => {
    const v = unreadVerdict(
      input({
        page: { ok: false, url: "u", failure: "timeout", message: "", readAt: READ_AT },
        serpTitle: "Заголовок из поисковой выдачи",
      })
    );
    expect(v.theme).toBe("Заголовок из поисковой выдачи");
    expect(v.readFailure).toBe("timeout");
    expect(v.quotes).toEqual([]);
  });
});
