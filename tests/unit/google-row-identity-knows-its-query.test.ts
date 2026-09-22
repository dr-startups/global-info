/**
 * Строка Google помнит, каким запросом и в каком контуре её нашли (шаг 0146).
 *
 * С шага 0138 строка базового сбора несёт запрос и контур в `rawMetadata`, а
 * хеш при записи считался по одному адресу: `saveEvidence` звал
 * `searchResultDedupHash({ engine, normalizedUrl })`, и `createMany({
 * skipDuplicates })` молча выбрасывал строку следующего запроса с уже виденным
 * адресом. Прогон Мельниченко 22.09.2026: у запроса «Мельниченко Андрей» в
 * бандле позиции 8, 10–18 — первые семь совпали по адресу с основным запросом и
 * записаны не были, а стр. 24 объявила их «не вернул ни один источник».
 *
 * Идентичность строки говорит прямо: запрос и регион входят в хеш там, где
 * строка их знает. Здесь она их знает.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/prisma/client";
import { RealGoogleSearchAgent } from "@/modules/digital-profile/agents/real/real-google-search-agent";
import { taggedSearchRows } from "@/modules/digital-profile/agents/real/real-search-agent-base";
import { searchResultDedupHash } from "@/modules/digital-profile/services/search-result-identity";
import { normalizeUrl } from "@/modules/digital-profile/services/evidence-service";
import type { SearchProviderResult } from "@/modules/digital-profile/providers/types";

const URL = "https://ru.wikipedia.org/wiki/Мельниченко,_Андрей_Игоревич";

const result = (rank: number): SearchProviderResult =>
  ({
    provider: "GOOGLE",
    query: "q",
    region: "ru",
    language: "ru",
    rank,
    title: "Мельниченко, Андрей Игоревич — Википедия",
    snippet: "s",
    url: URL,
    domain: "ru.wikipedia.org",
    rawMetadata: { source: "serper", rank },
  }) as SearchProviderResult;

type Db = Record<string, unknown>;
const db = prisma as unknown as Db;
const saved = { searchResult: db.searchResult, searchQuery: db.searchQuery };
let rows: Array<Record<string, unknown>> = [];

beforeEach(() => {
  rows = [];
  db.searchQuery = {
    deleteMany: async () => ({ count: 0 }),
    createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }),
  };
  db.searchResult = {
    ...(saved.searchResult as object),
    createMany: async (a: { data: Array<Record<string, unknown>> }) => {
      rows.push(...a.data);
      return { count: a.data.length };
    },
  };
});

afterEach(() => {
  db.searchResult = saved.searchResult;
  db.searchQuery = saved.searchQuery;
});

async function save(results: SearchProviderResult[]): Promise<string[]> {
  const agent = new RealGoogleSearchAgent();
  await agent.saveEvidence({ caseId: "case-0146" } as never, { queries: [], results });
  return rows.map((r) => String(r.dedupHash));
}

describe("хеш строки Google знает запрос и контур", () => {
  it("И1: один адрес двумя запросами — две строки", async () => {
    const hashes = await save([
      ...taggedSearchRows([result(1)], { query: "Мельниченко Андрей Игоревич", contour: "RU" }),
      ...taggedSearchRows([result(3)], { query: "Мельниченко Андрей", contour: "RU" }),
    ]);
    expect(new Set(hashes).size).toBe(2);
  });

  it("И2: один адрес в двух контурах — две строки", async () => {
    const hashes = await save([
      ...taggedSearchRows([result(1)], { query: "Andrey Melnichenko", contour: "RU" }),
      ...taggedSearchRows([result(1)], { query: "Andrey Melnichenko", contour: "UAE" }),
    ]);
    expect(new Set(hashes).size).toBe(2);
  });

  it("И3: тот же адрес, запрос и контур — та же строка (повторный сбор идемпотентен)", async () => {
    const hashes = await save([
      ...taggedSearchRows([result(1)], { query: "Мельниченко Андрей Игоревич", contour: "RU" }),
      ...taggedSearchRows([result(1)], { query: "Мельниченко Андрей Игоревич", contour: "RU" }),
    ]);
    expect(new Set(hashes).size).toBe(1);
  });

  it("И4: строка, не знающая ни запроса, ни контура, сохраняет прежний хеш", async () => {
    const [hash] = await save([result(1)]);
    expect(hash).toBe(
      searchResultDedupHash({ engine: "GOOGLE", normalizedUrl: normalizeUrl(URL) })
    );
  });
});
