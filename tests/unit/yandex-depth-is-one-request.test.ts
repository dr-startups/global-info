/**
 * Глубина Яндекса — одним запросом.
 *
 * Двадцатка двумя страницами по десять стоила двух оплаченных запросов, и две
 * страницы отвечали разные реплики: живая проверка 24.09.2026 получила на второй
 * странице два адреса из первой — восемнадцать разных результатов вместо двадцати,
 * а места 11–20 из чужого ранжирования. Один запрос с `groupSpec.groupsOnPage`
 * отдаёт всю глубину одним снимком за цену одного запроса.
 *
 * Подменённый `fetch` ведёт себя как API на той проверке: без `groupSpec` — десять
 * групп (`groups-on-page="10"`), с ним — столько, сколько попросили.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realFetch = globalThis.fetch;

interface SentBody {
  query?: { page?: string; queryText?: string };
  groupSpec?: { groupMode?: string; groupsOnPage?: string; docsInGroup?: string };
}

let sent: SentBody[] = [];
/** Сколько групп есть у «Яндекса» по запросу всего. */
let available = 100;

function answer(body: SentBody): string {
  const perPage = Number(body.groupSpec?.groupsOnPage ?? 10);
  const page = Number(body.query?.page ?? 0);
  const from = page * perPage;
  const count = Math.max(0, Math.min(perPage, available - from));
  const docs = Array.from(
    { length: count },
    (_, i) =>
      `<group><doc id="d${from + i}"><url>https://example.ru/${from + i}</url><title>Материал ${from + i}</title>` +
      `<passages><passage>текст</passage></passages></doc></group>`
  ).join("");
  const xml =
    `<?xml version="1.0" encoding="utf-8"?><yandexsearch><response><results>` +
    `<grouping attr="d" mode="deep" groups-on-page="${perPage}" docs-in-group="1">${docs}</grouping>` +
    `</results></response></yandexsearch>`;
  return JSON.stringify({ rawData: Buffer.from(xml, "utf8").toString("base64") });
}

beforeEach(() => {
  sent = [];
  available = 100;
  vi.stubEnv("YANDEX_SEARCH_API_KEY", "AQVNoffline0000testkey1234567890abcd");
  vi.stubEnv("YANDEX_SEARCH_FOLDER_ID", "b1goffline0000test");
  vi.resetModules();
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as SentBody;
    sent.push(body);
    return { status: 200, ok: true, text: async () => answer(body) } as unknown as Response;
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function search(limit?: number) {
  const { yandexSearchProvider } = await import(
    "@/modules/digital-profile/providers/yandex-search-provider"
  );
  return yandexSearchProvider.search({
    caseId: "case-depth",
    subjectFullName: "Петров Иван Иванович",
    aliases: [],
    query: "Петров Иван Иванович суд",
    region: "ru",
    ...(limit === undefined ? {} : { limit }),
  });
}

describe("глубина Яндекса — один запрос", () => {
  it("проба ORION просит двадцать одним запросом и получает двадцать мест подряд", async () => {
    const run = await search(20);
    expect(run.status).toBe("SUCCESS");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.query?.page).toBe("0");
    expect(sent[0]!.groupSpec?.groupsOnPage).toBe("20");
    expect(run.results.map((r) => r.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("агент без явной глубины — глубина из настроек, тоже одним запросом", async () => {
    const run = await search();
    expect(run.status).toBe("SUCCESS");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.groupSpec?.groupsOnPage).toBe("10");
    expect(run.results).toHaveLength(10);
  });

  it("потолок адаптера (50) укладывается в одну страницу API", async () => {
    const run = await search(50);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.groupSpec?.groupsOnPage).toBe("50");
    expect(run.results).toHaveLength(50);
  });

  it("короткий ответ — всё, что есть: второго запроса за ним нет", async () => {
    // Пятнадцать — как у запросов ORION в живом прогоне 24.09: страница по десять
    // пошла бы за второй, а «дособирать до двадцати» — за пустой.
    available = 15;
    const run = await search(20);
    expect(run.status).toBe("SUCCESS");
    expect(sent).toHaveLength(1);
    expect(run.results).toHaveLength(15);
  });

  it("группировка — та, что Яндекс применял сам: меняется только число групп", async () => {
    await search(20);
    expect(sent[0]!.groupSpec).toEqual({
      groupMode: "GROUP_MODE_DEEP",
      groupsOnPage: "20",
      docsInGroup: "1",
    });
  });
});
