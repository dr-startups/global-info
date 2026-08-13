import { describe, expect, it } from "vitest";
import {
  linksToRead,
  runLinkVerdicts,
} from "@/modules/digital-profile/orion-golden/analytics/run-link-verdicts";
import type { LinkPageRead } from "@/modules/digital-profile/services/link-page-reader";

const ON = { DIGITAL_PROFILE_LINK_READING: "true" } as unknown as NodeJS.ProcessEnv;

function item(over: Record<string, unknown> = {}) {
  return {
    inventoryId: String(over.inventoryId ?? "obs-1"),
    sourceUrl: String(over.sourceUrl ?? "https://example.com/a"),
    title: (over.title as string) ?? "Заголовок",
    snippet: "сниппет",
    rawMetadata: (over.rawMetadata as Record<string, unknown>) ?? { rank: 1, queryText: "иванов иван" },
  } as never;
}

const page: LinkPageRead = {
  ok: true,
  url: "https://example.com/a",
  text: "текст".repeat(100),
  readAt: "2026-08-14T09:00:00.000Z",
};

describe("выбор ссылок для чтения", () => {
  it("один адрес читается один раз, даже если найден несколькими запросами", () => {
    const links = linksToRead([
      item({ inventoryId: "a", sourceUrl: "https://example.com/x?utm=1", rawMetadata: { rank: 5 } }),
      item({ inventoryId: "b", sourceUrl: "https://example.com/x", rawMetadata: { rank: 2 } }),
    ] as never);
    expect(links).toHaveLength(1);
  });

  it("порядок — по позиции в выдаче: сверху то, что видно первым", () => {
    const links = linksToRead([
      item({ inventoryId: "a", sourceUrl: "https://a.ru/1", rawMetadata: { rank: 9 } }),
      item({ inventoryId: "b", sourceUrl: "https://b.ru/1", rawMetadata: { rank: 2 } }),
    ] as never);
    expect(links.map((l) => l.rank)).toEqual([2, 9]);
  });

  it("не-веб-адреса не читаются", () => {
    expect(linksToRead([item({ sourceUrl: "mailto:a@b.ru" })] as never)).toHaveLength(0);
  });

  it("предел соблюдается", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      item({ inventoryId: `i${i}`, sourceUrl: `https://s${i}.ru/`, rawMetadata: { rank: i + 1 } })
    );
    expect(linksToRead(many as never, 10)).toHaveLength(10);
  });
});

describe("шаг чтения ссылок", () => {
  const subject = { fullName: "Иванов Иван Иванович" };

  it("без разрешения не ходит ни в сеть, ни в модель", async () => {
    let touched = false;
    const res = await runLinkVerdicts({
      caseId: "case-1",
      subject,
      items: [item()] as never,
      deps: {
        env: {} as unknown as NodeJS.ProcessEnv,
        read: async () => {
          touched = true;
          return page;
        },
      },
    });
    expect(touched).toBe(false);
    expect(res.skippedReason).toBe("disabled");
    expect(res.verdicts).toEqual([]);
  });

  it("читает ссылки и сводит темы, когда разрешено", async () => {
    const res = await runLinkVerdicts({
      caseId: "case-1",
      subject,
      items: [
        item({ inventoryId: "a", sourceUrl: "https://a.ru/1", rawMetadata: { rank: 1 } }),
        item({ inventoryId: "b", sourceUrl: "https://b.ru/1", rawMetadata: { rank: 2 } }),
      ] as never,
      deps: {
        env: ON,
        read: async (url) => ({ ...page, url }),
        analyze: (async (inputs: Array<{ evidenceRef: string; url: string; rank?: number }>) =>
          inputs.map((i, idx) => ({
            schemaVersion: "link-verdict-v1" as const,
            evidenceRef: i.evidenceRef,
            url: i.url,
            rank: i.rank,
            subjectMatch: "subject" as const,
            tone: idx === 0 ? ("adverse" as const) : ("neutral" as const),
            theme: idx === 0 ? "Судебный спор" : "Деловой профиль",
            quotes: idx === 0 ? [{ text: "суд удовлетворил иск заявителя" }] : [],
            readAt: page.readAt,
          }))) as never,
      },
    });
    expect(res.requested).toBe(2);
    expect(res.summary.adverse).toBe(1);
    expect(res.summary.themes.map((t) => t.theme)).toEqual(["Судебный спор", "Деловой профиль"]);
    // Свойство эталона: суммы по темам сходятся с числом нежелательных ссылок.
    expect(res.summary.themes.reduce((n, t) => n + t.adverseCount, 0)).toBe(res.summary.adverse);
  });

  it("без ссылок называет причину, а не молчит", async () => {
    const res = await runLinkVerdicts({
      caseId: "case-1",
      subject,
      items: [] as never,
      deps: { env: ON },
    });
    expect(res.skippedReason).toBe("no-links");
  });
});
