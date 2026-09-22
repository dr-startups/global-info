/**
 * Короткая первая страница Google — не конец выдачи (шаг 0146).
 *
 * `serperSearch` выходил из цикла, если страница вернула меньше десяти строк.
 * У Google на первой странице часто девять органических результатов: место
 * занимает блок выдачи. Прогон Мельниченко 22.09.2026: основной запрос остался
 * с позициями 1–9 из обещанных двадцати, а соседний запрос с полной первой
 * страницей получил и вторую десятку.
 *
 * Конец выдачи — пустая страница, выбранная глубина или страница из одних
 * повторов (провайдер проигнорировал `page`). Цена правила — не больше одного
 * лишнего вызова на запрос.
 */

import { afterEach, describe, expect, it } from "vitest";
import { serperSearch } from "@/modules/digital-profile/providers/serper-search-provider";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const page = (urls: string[]) => ({
  organic: urls.map((link, i) => ({ title: `t ${link}`, link, snippet: "s", position: i + 1 })),
});
const urlsOf = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `https://example.com/${prefix}/${i + 1}`);

function serperPages(pages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_u: string, init: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const scripted = pages[bodies.length - 1] ?? { organic: [] };
    return { status: 200, ok: true, text: async () => JSON.stringify(scripted) } as unknown as Response;
  }) as typeof globalThis.fetch;
  return bodies;
}

const request = (limit: number) => ({
  caseId: "case-0146",
  subjectFullName: "Мельниченко Андрей Игоревич",
  aliases: [],
  query: "Мельниченко Андрей Игоревич",
  region: "ru",
  limit,
});

describe("конец выдачи — пустая страница, а не короткая", () => {
  it("С1: первая страница из девяти — вторая покупается, позиции 11–20 приходят", async () => {
    const bodies = serperPages([page(urlsOf("p1", 9)), page(urlsOf("p2", 10))]);
    const run = await serperSearch(request(20));
    expect(bodies.map((b) => b.page)).toEqual([1, 2]);
    expect(run.results.map((r) => r.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  it("С2: пустая страница — конец, третья не покупается", async () => {
    const bodies = serperPages([page(urlsOf("p1", 10)), { organic: [] }, page(urlsOf("p3", 10))]);
    const run = await serperSearch(request(30));
    expect(bodies).toHaveLength(2);
    expect(run.results).toHaveLength(10);
  });

  it("С3: страница из одних повторов — конец, провайдер проигнорировал page", async () => {
    const first = urlsOf("p1", 10);
    const bodies = serperPages([page(first), page(first), page(urlsOf("p3", 10))]);
    await serperSearch(request(30));
    expect(bodies).toHaveLength(2);
  });

  it("С4: короткая первая страница и пустая вторая — два вызова, строки первой целы", async () => {
    const bodies = serperPages([page(urlsOf("p1", 7))]);
    const run = await serperSearch(request(20));
    expect(bodies).toHaveLength(2);
    expect(run.results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
