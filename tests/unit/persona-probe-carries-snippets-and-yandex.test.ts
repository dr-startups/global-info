/**
 * Проба панели персон несёт сниппеты и обе выдачи.
 *
 * Панель показывала оператору пять органических строк без сниппета — по ним
 * нельзя узнать малоизвестного человека: в заголовках выдачи по «Егоров Алексей
 * Евгеньевич» дата рождения не встречается ни разу, а в сниппетах стоит 27 раз
 * (прогон DPA-2026-0049). Признак живёт в сниппете, значит сниппет и есть то,
 * ради чего блок существует.
 *
 * Яндекс добавлен решением владельца: офтальмолога-однофамильца в том прогоне
 * было видно только там.
 */

import { describe, expect, it } from "vitest";
import { buildPersonaPanel } from "@/modules/digital-profile/services/subject-persona-check";

function serperItem(rank: number, engineRegion: string) {
  return {
    kind: "organic" as const,
    query: "Егоров Алексей Евгеньевич",
    region: engineRegion,
    language: "ru",
    rank,
    title: `Строка Google ${rank}`,
    snippet: `Сниппет Google ${rank}: родился 30.11.1977`,
    url: `https://example.org/g/${engineRegion}/${rank}`,
    domain: "example.org",
    thumbnailUrl: null,
    imageUrl: null,
    videoUrl: null,
    sourcePageUrl: null,
    rawMetadataSafe: { surface: "organic" },
  };
}

const SUBJECT = {
  caseId: "case-probe",
  fullName: "Егоров Алексей Евгеньевич",
  aliases: [] as string[],
  dateOfBirth: "1977-11-30",
};

describe("строки пробы", () => {
  it("несут сниппет, движок и по десять строк с каждого запроса", async () => {
    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        wikipedia: async () => ({ status: "SUCCESS", candidates: [] }) as never,
        openSanctions: async () => ({ status: "NOT_CONFIGURED", hits: [] }) as never,
        serper: async (_request, region) =>
          ({
            status: "SUCCESS",
            items: Array.from({ length: 12 }, (_, i) => serperItem(i + 1, String(region))),
          }) as never,
        yandex: async () =>
          ({
            status: "SUCCESS",
            provider: "yandex",
            results: Array.from({ length: 12 }, (_, i) => ({
              provider: "yandex",
              query: "Егоров Алексей Евгеньевич",
              rank: i + 1,
              title: `Строка Яндекса ${i + 1}`,
              snippet: `Сниппет Яндекса ${i + 1}`,
              url: `https://example.ru/y/${i + 1}`,
              domain: "example.ru",
              rawMetadata: {},
              capturedAt: "2026-09-04T00:00:00.000Z",
            })),
          }) as never,
      },
    });

    const google = snapshot.serpRows.filter((r) => r.engine === "GOOGLE");
    const yandex = snapshot.serpRows.filter((r) => r.engine === "YANDEX");
    // Два запроса Google (RU и международный) по десять строк каждый.
    expect(google).toHaveLength(20);
    expect(yandex).toHaveLength(10);
    expect(google[0]?.snippet).toContain("родился 30.11.1977");
    expect(yandex[0]?.snippet).toBe("Сниппет Яндекса 1");
    expect(snapshot.sources.map((s) => s.source)).toContain("yandex");
  });

  it("молчание Яндекса не роняет панель и называется словами", async () => {
    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        wikipedia: async () => ({ status: "SUCCESS", candidates: [] }) as never,
        openSanctions: async () => ({ status: "NOT_CONFIGURED", hits: [] }) as never,
        serper: async (_request, region) =>
          ({ status: "SUCCESS", items: [serperItem(1, String(region))] }) as never,
        yandex: async () =>
          ({ status: "NOT_CONFIGURED", provider: "yandex", results: [] }) as never,
      },
    });
    const yandexSource = snapshot.sources.find((s) => s.source === "yandex");
    expect(yandexSource?.status).toBe("NOT_CONFIGURED");
    expect(snapshot.fetchStatus).toBe("SUCCESS");
  });
});
