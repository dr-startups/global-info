/**
 * Ответ мерного прогона разбирается, а не принимается на веру.
 *
 * Мера — новый и единственный источник ответа «сколько влезает на лист», и от
 * неё зависит состав страниц отчёта. Ответ 200 с чужим телом (старый рендерер
 * после частичного деплоя, прокси, подменивший тело) раньше уезжал в укладку
 * как есть и падал `TypeError` где-то в арифметике — вместо названного отказа
 * попытки, который оператор может прочитать.
 */

import { describe, expect, it } from "vitest";
import { measureDeckViaHttp } from "@/modules/digital-profile/services/render-deck-artifacts";

/** Здоровье отвечает сразу, мера — заданным телом: сеть не нужна. */
function respond(body: unknown): typeof fetch {
  return (async (url: string) =>
    String(url).endsWith("/health")
      ? new Response("{}", { status: 200 })
      : new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
}

const PAGE = {
  slideKey: "p07",
  page: 7,
  availableHeight: 100,
  maxItems: 9,
  itemHeights: [10],
  keptItems: 1,
  droppedBullets: 0,
  droppedLines: 0,
};

async function measure(body: unknown) {
  return measureDeckViaHttp(
    {},
    { fetchImpl: respond(body), rendererBaseUrl: "http://renderer", healthAttempts: 1 }
  );
}

describe("мера ждёт рендерер так же, как это делает рендер", () => {
  it("не сдаётся на первом отказе здоровья: холодный старт — не отказ попытки", async () => {
    let health = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/health")) {
        health += 1;
        if (health < 2) throw new Error("fetch failed");
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ version: "orion-bullet-measure-v1", pages: [PAGE] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const verdict = await measureDeckViaHttp(
      {},
      { fetchImpl, rendererBaseUrl: "http://renderer", sleepMs: async () => undefined }
    );
    expect(health).toBe(2);
    expect(verdict.pages).toHaveLength(1);
  });

  it("таймаут запроса меры получает ровно один повтор", async () => {
    let posts = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/health")) return new Response("{}", { status: 200 });
      posts += 1;
      if (posts < 2) {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      }
      return new Response(JSON.stringify({ version: "orion-bullet-measure-v1", pages: [PAGE] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const verdict = await measureDeckViaHttp(
      {},
      { fetchImpl, rendererBaseUrl: "http://renderer", sleepMs: async () => undefined }
    );
    expect(posts).toBe(2);
    expect(verdict.pages).toHaveLength(1);
  });
});

describe("разбор ответа мерного прогона", () => {
  it("вердикт объявленной версии принимается", async () => {
    const verdict = await measure({ version: "orion-bullet-measure-v1", pages: [PAGE] });
    expect(verdict.pages).toHaveLength(1);
    expect(verdict.pages[0]!.itemHeights).toEqual([10]);
  });

  it("чужая версия вердикта — названный отказ", async () => {
    await expect(measure({ version: "orion-bullet-measure-v0", pages: [] })).rejects.toThrow(
      /orion-bullet-measure-v1/u
    );
  });

  it("тело без страниц — названный отказ, а не пустая мера", async () => {
    // Пустой список ворота прочли бы как «мерено, потерь нет».
    await expect(measure({ ok: true })).rejects.toThrow(/measure/iu);
  });

  it("страница без высот элементов — названный отказ", async () => {
    await expect(
      measure({ version: "orion-bullet-measure-v1", pages: [{ ...PAGE, itemHeights: undefined }] })
    ).rejects.toThrow(/measure/iu);
  });
});
