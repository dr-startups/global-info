/**
 * Глубина Google собирается страницами, и номер позиции считаем мы.
 *
 * Отчёт обещает клиенту ТОП-20, а Serper отдаёт органику страницами по десять.
 * Просить `num: 20` одним запросом — это просить у провайдера сделать за нас то,
 * чего мы не наблюдали: в ответе приходит `position`, и до этой правки он же и
 * становился позицией строки. Значит, на один вопрос «какая это позиция» было
 * два ответа — наш индекс и число провайдера, — и второй молча побеждал.
 *
 * Здесь пинается один ответ: позиция строки — `(страница - 1) * 10 + индекс + 1`,
 * а `position` провайдера лежит рядом фактом. Номера 11–20 обязаны приходить из
 * того же снимка выдачи, что и 1–10, иначе таблица печатает точные на вид
 * позиции, которые точными не являются.
 *
 * Здесь же живёт то, ради чего заведён был `serper-asks-for-the-promised-depth`:
 * просьба о глубине обязана доехать до сети. На прогоне 76 из 601 серперной
 * строки бандла не было ни одной с позицией больше десяти — адаптер срезал
 * запрошенные двадцать до своего умолчания. Теперь тот же дефект виден
 * количеством вызовов: срезанная глубина — это один вызов вместо двух.
 *
 * Сеть подменена во всех проверках: наружу не уходит ни один запрос.
 */

import { afterEach, describe, expect, it } from "vitest";
import { serperSearch } from "@/modules/digital-profile/providers/serper-search-provider";
import { organicSearchDepth } from "@/modules/digital-profile/providers/search-depth";
import { providerConfig } from "@/modules/digital-profile/providers/config";
import { rankOf } from "@/modules/digital-profile/orion-golden/analytics/analysis-scope";
import { SERP_AUDIT_DEPTH } from "@/modules/digital-profile/services/orion-search-profile-service";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Ответ одной страницы: провайдер нумерует строки своей страницы с единицы. */
function organicPage(urls: string[]): Record<string, unknown> {
  return {
    organic: urls.map((url, i) => ({
      title: `Материал ${url}`,
      link: url,
      snippet: "текст сниппета",
      position: i + 1,
    })),
  };
}

/**
 * Страница, где у одной строки нет `link`.
 *
 * Serper так отвечает на карточках-агрегаторах. Страница при этом полная —
 * следующая существует, — но оставим мы девять строк.
 */
function organicPageWithLinklessRow(urls: string[], linklessIndex: number): Record<string, unknown> {
  const page = organicPage(urls) as { organic: Array<Record<string, unknown>> };
  delete page.organic[linklessIndex].link;
  return page;
}

function urlsOf(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `https://example.com/${prefix}/${i + 1}`);
}

type ScriptedPage = Record<string, unknown> | { httpStatus: number };

/** Подменяет сеть заранее написанными страницами и возвращает ушедшие тела. */
function serperPages(pages: ScriptedPage[]): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    const scripted = pages[bodies.length - 1] ?? { organic: [] };
    const status = (scripted as { httpStatus?: number }).httpStatus;
    if (typeof status === "number") {
      return {
        status,
        ok: false,
        text: async () => JSON.stringify({ message: "boom" }),
      } as unknown as Response;
    }
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify(scripted),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return bodies;
}

function subjectRequest(limit?: number) {
  return {
    caseId: "case-depth",
    subjectFullName: "Виктор Рашников",
    aliases: [],
    query: "виктор рашников",
    region: "ru",
    ...(limit === undefined ? {} : { limit }),
  };
}

describe("двадцатка Google — это две страницы одного снимка", () => {
  it("размер страницы назван в адаптере и равен десяти", async () => {
    const mod = await import("@/modules/digital-profile/providers/serper-search-provider");
    expect(mod.SERPER_PAGE_SIZE).toBe(10);
  });

  it("глубина 20 уходит двумя вызовами: num — размер страницы, page — 1 и 2", async () => {
    const bodies = serperPages([organicPage(urlsOf("p1", 10)), organicPage(urlsOf("p2", 10))]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.status).toBe("SUCCESS");
    expect(bodies.map((b) => b.num)).toEqual([10, 10]);
    expect(bodies.map((b) => b.page)).toEqual([1, 2]);
  });

  it("глубина 10 — ровно один вызов", async () => {
    const bodies = serperPages([organicPage(urlsOf("p1", 10))]);
    const run = await serperSearch(subjectRequest(10));
    expect(run.status).toBe("SUCCESS");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].page).toBe(1);
    expect(bodies[0].num).toBe(10);
  });

  it("глубже предела API не листает", async () => {
    // Потолок Serper — 100 результатов, то есть десять страниц: это предел
    // числа платных вызовов на один запрос, а не размер одного из них.
    const bodies = serperPages(
      Array.from({ length: 12 }, (_, i) => organicPage(urlsOf(`p${i + 1}`, 10)))
    );
    const run = await serperSearch(subjectRequest(500));
    expect(run.status).toBe("SUCCESS");
    expect(bodies).toHaveLength(10);
    expect(bodies[9].page).toBe(10);
  });

  it("проба одностраничная: назначение запроса глубины не просит", async () => {
    // Предпосылка, без которой утверждение ниже ничего не значит: проба идёт на
    // умолчании провайдера, и одна страница получается только пока умолчание не
    // больше страницы. `GOOGLE_SEARCH_RESULTS_PER_QUERY` принимает до 50 —
    // поставив 50, оператор заставит каждую пробу покупать пять страниц.
    expect(providerConfig.google.resultsPerQuery).toBeLessThanOrEqual(10);
    const depth = organicSearchDepth({
      provider: "serper",
      purpose: "adverse_lookup",
      auditDepth: SERP_AUDIT_DEPTH,
    });
    const bodies = serperPages([organicPage(urlsOf("p1", 10))]);
    await serperSearch(subjectRequest(depth));
    expect(bodies).toHaveLength(1);
  });
});

describe("позицию строки считаем мы, а не провайдер", () => {
  it("вторая страница, пронумерованная провайдером с единицы, даёт позиции 11–20", async () => {
    serperPages([organicPage(urlsOf("p1", 10)), organicPage(urlsOf("p2", 10))]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.results.map((r) => r.rank)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1)
    );
    expect(run.results[10].url).toBe("https://example.com/p2/1");
    expect(run.results[19].url).toBe("https://example.com/p2/10");
  });

  it("позиция провайдера лежит рядом фактом и источником позиции не является", async () => {
    serperPages([organicPage(urlsOf("p1", 10)), organicPage(urlsOf("p2", 10))]);
    const run = await serperSearch(subjectRequest(20));
    const meta = run.results[10].rawMetadata as Record<string, unknown>;
    // Провайдер сказал «первая на своей странице» — это факт о его ответе.
    expect(meta.providerPosition).toBe(1);
    // Позиция строки — наша, сквозная.
    expect(meta.rank).toBe(11);
    // Ключа с двумя смыслами больше нет: `position` означал то одно, то другое.
    expect(meta).not.toHaveProperty("position");
  });

  it("аналитика читает нашу сквозную позицию, а не страничную", async () => {
    serperPages([organicPage(urlsOf("p1", 10)), organicPage(urlsOf("p2", 10))]);
    const run = await serperSearch(subjectRequest(20));
    const item = {
      inventoryId: "sr-1",
      caseId: "case-depth",
      reportRunId: "run-1",
      source: "search_result",
      provider: "GOOGLE",
      region: "RU",
      collectedAt: new Date().toISOString(),
      evidenceType: "search_result",
      title: run.results[10].title,
      rawMetadata: run.results[10].rawMetadata as Record<string, unknown>,
    } satisfies RawInventoryItem;
    expect(rankOf(item)).toBe(11);
  });
});

describe("остановка цикла и отказы страниц", () => {
  it("строка без адреса не выдаёт страницу за короткую", async () => {
    // Полнота страницы считается по ответу провайдера, а не по строкам, которые
    // мы оставили. Считать по оставленным — значит остановиться на девяти и не
    // купить вторую страницу никогда: это буквально повторение прогона 76.
    const bodies = serperPages([
      organicPageWithLinklessRow(urlsOf("p1", 10), 4),
      organicPage(urlsOf("p2", 10)),
    ]);
    const run = await serperSearch(subjectRequest(20));
    expect(bodies.map((b) => b.page)).toEqual([1, 2]);
    expect(run.depthAudit?.perPage).toEqual([10, 10]);
    // Позиции остаются позициями страницы: пятая строка выпала, а не сдвинула
    // соседей.
    expect(run.results.slice(0, 9).map((r) => r.rank)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10]);
    expect(run.results[9].rank).toBe(11);
  });

  it("короткая страница останавливает цикл", async () => {
    const bodies = serperPages([organicPage(urlsOf("p1", 7))]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.status).toBe("SUCCESS");
    expect(bodies).toHaveLength(1);
    expect(run.results).toHaveLength(7);
  });

  it("отказ второй страницы оставляет SUCCESS и строки первой", async () => {
    serperPages([organicPage(urlsOf("p1", 10)), { httpStatus: 500 }]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.status).toBe("SUCCESS");
    expect(run.results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("отказ первой страницы — это FAILED без строк", async () => {
    serperPages([{ httpStatus: 500 }]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.status).toBe("FAILED");
    expect(run.results).toEqual([]);
  });
});

describe("учёт глубины делает трату видимой", () => {
  it("учёт доезжает до результата, и пустая страница в нём видна числом", async () => {
    serperPages([organicPage(urlsOf("p1", 10)), { organic: [] }]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.depthAudit).toEqual({
      requested: 20,
      perPage: [10, 0],
      repeatedFromEarlierPages: 0,
    });
  });

  it("вторая страница с адресами первой считается повторами", async () => {
    // Полное совпадение означает, что провайдер `page` проигнорировал: без
    // счётчика дедупликация схлопнула бы дубли молча, и трата стала невидимой.
    const first = urlsOf("p1", 10);
    serperPages([organicPage(first), organicPage(first)]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.depthAudit).toEqual({
      requested: 20,
      perPage: [10, 10],
      repeatedFromEarlierPages: 10,
    });
  });

  it("отказ второй страницы виден в учёте одной страницей при запрошенных двадцати", async () => {
    serperPages([organicPage(urlsOf("p1", 10)), { httpStatus: 500 }]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.depthAudit).toEqual({
      requested: 20,
      perPage: [10],
      repeatedFromEarlierPages: 0,
      stoppedByError: "PROVIDER_BAD_RESPONSE",
    });
  });

  it("учёт называет причину, по которой сбор оборвался", async () => {
    // Иначе отказ второй страницы неотличим от «глубже ничего нет»: прогон
    // зелёный, оператор видит COLLECTED, а отчёт печатает десять строк там, где
    // обещал двадцать. Самая вероятная причина — 429 на возросшем числе
    // запросов.
    serperPages([organicPage(urlsOf("p1", 10)), { httpStatus: 429 }]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.status).toBe("SUCCESS");
    expect(run.depthAudit?.stoppedByError).toBe("PROVIDER_RATE_LIMITED");
  });

  it("сбор, дошедший до конца сам, причины отказа не выдумывает", async () => {
    serperPages([organicPage(urlsOf("p1", 10)), organicPage(urlsOf("p2", 10))]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.depthAudit).not.toHaveProperty("stoppedByError");
  });

  it("отказ первой страницы тоже оставляет учёт: видно, что не куплено ничего", async () => {
    serperPages([{ httpStatus: 500 }]);
    const run = await serperSearch(subjectRequest(20));
    expect(run.status).toBe("FAILED");
    expect(run.depthAudit).toEqual({
      requested: 20,
      perPage: [],
      repeatedFromEarlierPages: 0,
      stoppedByError: "PROVIDER_BAD_RESPONSE",
    });
  });
});
