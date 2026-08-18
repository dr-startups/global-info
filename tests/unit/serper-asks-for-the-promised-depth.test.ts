/**
 * Глубина выдачи — просьба вызывающего и свойство назначения запроса.
 *
 * Прогон 76: аудит обещает ТОП-20, сбор просил у Serper двадцать, а адаптер
 * считал глубину как `Math.min(запрошено ?? настройка, настройка)` и отправлял
 * в сеть `num: 10`. Из 601 серперной строки бандла ни одной с позицией больше
 * десяти — при том, что Яндекс через починенный адаптер отдавал до двадцати.
 *
 * Кому эти двадцать нужны и почему у Яндекса иначе — в
 * `free-depth-is-not-rationed.test.ts`: здесь пинается только доставка просьбы
 * до тела запроса Serper.
 */

import { afterEach, describe, expect, it } from "vitest";
import { serperSearch } from "@/modules/digital-profile/providers/serper-search-provider";
import { providerConfig } from "@/modules/digital-profile/providers/config";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Тело запроса, ушедшее в сеть: сеть подменена, наружу ничего не уходит. */
async function bodyOfSerperRequest(limit?: number): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ organic: [] }),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  const run = await serperSearch({
    caseId: "case-depth",
    subjectFullName: "Виктор Рашников",
    aliases: [],
    query: "viktor rashnikov",
    region: "ae",
    ...(limit === undefined ? {} : { limit }),
  });
  expect(run.status).toBe("SUCCESS");
  return captured;
}

describe("просьба о глубине доезжает до Serper", () => {
  it("запрошенные двадцать уходят в тело запроса", async () => {
    // Настройка провайдера — десять; двадцать просит аудит.
    expect(providerConfig.google.resultsPerQuery).toBe(10);
    expect((await bodyOfSerperRequest(20)).num).toBe(20);
  });

  it("без просьбы берётся глубина по умолчанию", async () => {
    expect((await bodyOfSerperRequest()).num).toBe(providerConfig.google.resultsPerQuery);
  });

  it("глубже предела API не просит", async () => {
    expect((await bodyOfSerperRequest(500)).num).toBe(100);
  });
});

