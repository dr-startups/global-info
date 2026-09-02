/**
 * Учёт глубины доезжает до строки выдачи.
 *
 * Постраничный сбор нельзя проверить кодом возврата: пустая вторая страница даёт
 * `SUCCESS` с десятью строками ровно так же, как и до правки. Отличить «глубже
 * ничего нет» от «провайдер `page` проигнорировал» можно только учётом, а учёт
 * бесполезен, если он остаётся внутри адаптера: смотреть на него будут по
 * собранному кейсу, то есть по `rawMetadata` строки.
 *
 * Контракт `page` у Serper не подтверждён документацией — поддомен документации
 * из нашей среды не резолвится. Поэтому счётчик повторов не «на всякий случай»:
 * он единственное наблюдение, по которому видно, что вторая страница была
 * второй.
 */

import { describe, expect, it } from "vitest";
import { organicRowMetadata } from "@/modules/digital-profile/services/orion-search-profile-service";
import type { SearchProviderResult } from "@/modules/digital-profile/providers/types";
import type { OrionQuerySpec } from "@/modules/digital-profile/search-surfaces/orion-query-plan";

const QUERY_SPEC: OrionQuerySpec = {
  queryPlanId: "plan-1",
  queryId: "q-1",
  query: "виктор рашников",
  normalizedQuery: "виктор рашников",
  language: "ru",
  region: "RU",
  priority: "primary",
  purpose: "subject_lookup",
  providerPreference: ["serper"],
  requiredTokens: [],
  optionalTokens: [],
  identityStrictness: "strict",
  maxResultsHint: 20,
  clientVisible: true,
  internalReason: "проверка учёта глубины",
  planRank: 1,
};

function resultRow(rank: number): SearchProviderResult {
  return {
    provider: "GOOGLE",
    query: "виктор рашников",
    region: "ru",
    language: "ru",
    rank,
    title: "Материал",
    snippet: "текст",
    url: `https://example.com/${rank}`,
    domain: "example.com",
    rawMetadata: { source: "serper", rank, providerPosition: rank },
    capturedAt: new Date().toISOString(),
  };
}

describe("учёт глубины виден в собранной строке", () => {
  it("страницы и повторы доезжают до rawMetadata строки", () => {
    const meta = organicRowMetadata({
      engine: "GOOGLE",
      orionRegion: "RU",
      querySpec: QUERY_SPEC,
      result: resultRow(11),
      depthAudit: { requested: 20, perPage: [10, 10], repeatedFromEarlierPages: 10 },
    });
    expect(meta.depthAudit).toEqual({
      requested: 20,
      perPage: [10, 10],
      repeatedFromEarlierPages: 10,
    });
  });

  it("без учёта строка собирается прежней и лишнего ключа не несёт", () => {
    const meta = organicRowMetadata({
      engine: "YANDEX",
      orionRegion: "RU",
      querySpec: QUERY_SPEC,
      result: resultRow(3),
      depthAudit: undefined,
    });
    expect(meta).not.toHaveProperty("depthAudit");
    expect(meta.queryPurpose).toBe("subject_lookup");
    expect(meta.providerLimit).toBe(20);
  });
});
