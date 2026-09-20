/**
 * Строка выдачи без адреса страницы не читается (шаг 0129).
 *
 * Topvisor по Google отдаёт позицию, домен и заголовок, но **не адрес
 * страницы**: в прогоне Мордашова 20.09.2026 из 403 наблюдений
 * `topvisor-google` путь был у 34, и все 34 — это `https://youtube.com/`.
 * Для сравнения: `topvisor-yandex` 265 из 281, `serper` 228 из 261.
 *
 * Такой адрес уходил в очередь чтения наравне с настоящими, и читалась
 * витрина сайта: 47 вердиктов из 120 сняты с корня, **все 47 вернулись
 * `unclear`**, 26 из них прочитаны за деньги. Витрина попадала в отчёт
 * основанием выделения — стр. 32: «На странице ru.wikipedia.org — Главная
 * страница русскоязычной Википедии», цитата «Добро пожаловать в Википедию».
 *
 * Правило: корень сайта — не адрес материала. Очередь его не берёт (там же,
 * где уже не берёт страницы другого лица: читать их стоит денег), а отчёт о
 * чтении называет такие строки своей строкой, а не прячет в «не открылись».
 */

import { describe, expect, it } from "vitest";
import {
  addresslessRowCount,
  linksToRead,
} from "@/modules/digital-profile/orion-golden/analytics/run-link-verdicts";
import { linkReadingThemesIntro } from "@/modules/digital-profile/orion-golden/analytics/link-reading-agent";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

let seq = 0;
function item(url: string, rank = 1): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: "case-addressless",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "topvisor-google",
    region: "RU",
    collectedAt: "2026-09-20T00:00:00.000Z",
    evidenceType: "search_result",
    title: "Мордашов Алексей Александрович",
    snippet: "",
    sourceUrl: url,
    rawMetadata: { rank },
  } as unknown as RawInventoryItem;
}

describe("очередь чтения не покупает витрины сайтов", () => {
  it("А1: корень сайта в очередь не попадает, страница с путём попадает", () => {
    const rows = linksToRead([
      item("https://ru.wikipedia.org"),
      item("https://lenta.ru/"),
      item("https://youtube.com/"),
      item("https://lenta.ru/news/2022/06/02/severstal", 2),
    ]);
    expect(rows.map((r) => r.url)).toEqual(["https://lenta.ru/news/2022/06/02/severstal"]);
  });

  it("А2: адрес с запросом или якорем адресом страницы остаётся", () => {
    const rows = linksToRead([
      item("https://rbc.ru/person/6a16fa5a9a794730d1943909"),
      item("https://youtube.com/watch?v=GAjkOhKZrVY", 2),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("А3: безадресные строки считаются отдельно, а не теряются", () => {
    const items = [
      item("https://ru.wikipedia.org"),
      item("https://lenta.ru/"),
      item("https://lenta.ru/news/2022/06/02/severstal", 2),
    ];
    expect(addresslessRowCount(items)).toBe(2);
  });

  it("А4: шапка страницы тем называет строки без адреса", () => {
    const intro = linkReadingThemesIntro({
      report: {
        status: "PARTIAL",
        requested: 73,
        read: 66,
        failed: 7,
        retried: 0,
        byReason: { blocked: 7 },
        addressless: 47,
      },
      adverseTotal: 20,
      topN: 20,
      unread: 7,
      themedTotal: 37,
    });
    expect(intro).toContain("47");
    expect(intro).toMatch(/адрес/iu);
  });
});
