/**
 * Глубину экономят там, где за неё платят.
 *
 * Ограничение глубины — денежное, а не смысловое. У Serper `num` > 10 стоит два
 * кредита за запрос вместо одного, поэтому дорогая двадцатка просится только у
 * запросов, по которым строятся позиционные таблицы отчёта. У Яндекса глубина
 * входит в стоимость запроса, и урезать её незачем: до правила о назначении
 * запроса все органические запросы шли на двадцатку, и негативный, деловой и
 * медийный корпус проб сократился бы вдвое побочно.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { organicSearchDepth } from "@/modules/digital-profile/providers/search-depth";
import { SERP_AUDIT_DEPTH } from "@/modules/digital-profile/services/orion-search-profile-service";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("глубина зависит от назначения запроса и от цены глубины", () => {
  it("платному провайдеру двадцатка достаётся только запросам таблиц", () => {
    expect(organicSearchDepth({ provider: "serper", purpose: "subject_lookup", auditDepth: 20 })).toBe(20);
    expect(
      organicSearchDepth({ provider: "serper", purpose: "adverse_lookup", auditDepth: 20 })
    ).toBeUndefined();
    expect(
      organicSearchDepth({ provider: "serper", purpose: "business_lookup", auditDepth: 20 })
    ).toBeUndefined();
    expect(
      organicSearchDepth({ provider: "serper", purpose: "media_lookup", auditDepth: 20 })
    ).toBeUndefined();
  });

  it("бесплатная глубина просится всегда — и на пробах тоже", () => {
    for (const purpose of ["subject_lookup", "adverse_lookup", "business_lookup", "media_lookup"]) {
      expect(organicSearchDepth({ provider: "yandex", purpose, auditDepth: 20 })).toBe(20);
    }
  });
});

/** Ответ Яндекса на одну страницу: десять документов — значит, есть следующая. */
function yandexPageResponse(count: number): string {
  const docs = Array.from(
    { length: count },
    (_, i) =>
      `<doc><url>https://example.ru/${i}</url><title>Материал ${i}</title><passages><passage>текст</passage></passages></doc>`
  ).join("");
  const xml = `<?xml version="1.0" encoding="utf-8"?><yandexsearch><response><results><grouping>${docs}</grouping></results></response></yandexsearch>`;
  return JSON.stringify({ rawData: Buffer.from(xml, "utf8").toString("base64") });
}

/*
 * Серперной половины здесь больше нет: с постраничным сбором `num` равен десяти
 * в каждом запросе, и утверждение `num === 10` стало тавтологией — зелёной даже
 * тогда, когда проба листает две страницы. То, что оно проверяло, теперь держит
 * `serper-collects-depth-page-by-page.test.ts`: проба обязана уложиться в один
 * вызов.
 */
describe("глубина доезжает до тела запроса", () => {
  it("Яндекс листает вторую страницу и на пробе", async () => {
    // Двадцать у Яндекса — это две страницы по десять: просьба видна тем, что
    // адаптер идёт за второй страницей.
    vi.stubEnv("YANDEX_SEARCH_API_KEY", "AQVNoffline0000testkey1234567890abcd");
    vi.stubEnv("YANDEX_SEARCH_FOLDER_ID", "b1goffline0000test");
    vi.resetModules();
    const pages: string[] = [];
    globalThis.fetch = (async (_url: string, init: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: { page?: string } };
      pages.push(String(body.query?.page ?? ""));
      return {
        status: 200,
        ok: true,
        text: async () => yandexPageResponse(10),
      } as unknown as Response;
    }) as typeof globalThis.fetch;
    const { yandexSearchProvider } = await import(
      "@/modules/digital-profile/providers/yandex-search-provider"
    );
    const depth = organicSearchDepth({
      provider: "yandex",
      purpose: "adverse_lookup",
      auditDepth: SERP_AUDIT_DEPTH,
    });
    const run = await yandexSearchProvider.search({
      caseId: "case-depth",
      subjectFullName: "Виктор Рашников",
      aliases: [],
      query: "рашников компромат",
      region: "ru",
      ...(depth === undefined ? {} : { limit: depth }),
    });
    expect(run.status).toBe("SUCCESS");
    expect(pages).toEqual(["0", "1"]);
    expect(run.results.length).toBe(20);
  });
});
