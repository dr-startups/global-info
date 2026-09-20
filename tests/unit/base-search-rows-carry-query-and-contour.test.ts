/**
 * Строка базового сбора несёт свой запрос и свой контур (шаг 0138).
 *
 * Прогон Вексельберга 20.09.2026: 81 органическая строка Serper пришла **без
 * записанного запроса** и вся с регионом «RU», хотя план аудита ходил и по
 * ОАЭ. Склейка берёт запрос и контур из `rawMetadata` строки
 * (`composite-serp-merge`: `rm.query ?? rm.orionQuery`, `rm.orionRegion ??
 * rm.region`, иначе литерал «RU»), а базовый агент туда их не клал: в
 * `rawMetadata` уходило только то, что вернул провайдер — источник, ранг и
 * дата.
 *
 * Отсюда на стр. 19 отчёта Галицкого стояло «запрос, по которому она собрана,
 * в наборе не записан», а контур ОАЭ оставался без органики: его строки
 * становились российскими и склеивались с ними по адресу.
 */

import { describe, expect, it } from "vitest";
import { taggedSearchRows } from "@/modules/digital-profile/agents/real/real-search-agent-base";
import type { SearchProviderResult } from "@/modules/digital-profile/providers/types";

const result = (url: string): SearchProviderResult =>
  ({
    provider: "GOOGLE",
    query: "Viktor Vekselberg sanctions",
    region: "ae",
    rank: 3,
    title: "t",
    snippet: "s",
    url,
    domain: "example.org",
    rawMetadata: { source: "serper", rank: 3 },
  }) as SearchProviderResult;

describe("строка базового сбора помнит, чем и где её нашли", () => {
  it("Б1: запрос и контур попадают в rawMetadata", () => {
    const rows = taggedSearchRows([result("https://example.org/a")], {
      query: "Viktor Vekselberg sanctions",
      contour: "UAE",
    });
    const rm = rows[0]!.rawMetadata as Record<string, unknown>;
    expect(rm.query).toBe("Viktor Vekselberg sanctions");
    expect(rm.orionRegion).toBe("UAE");
  });

  it("Б2: то, что вернул провайдер, не затирается", () => {
    const rows = taggedSearchRows([result("https://example.org/a")], {
      query: "Viktor Vekselberg sanctions",
      contour: "UAE",
    });
    const rm = rows[0]!.rawMetadata as Record<string, unknown>;
    expect(rm.source).toBe("serper");
    expect(rm.rank).toBe(3);
  });

  it("Б3: без контура строка остаётся как была — личный набор его не знает", () => {
    const rows = taggedSearchRows([result("https://example.org/a")], {
      query: "Вексельберг Виктор Феликсович",
    });
    const rm = rows[0]!.rawMetadata as Record<string, unknown>;
    expect(rm.query).toBe("Вексельберг Виктор Феликсович");
    expect(rm.orionRegion).toBeUndefined();
  });
});
