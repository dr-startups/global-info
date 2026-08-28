/**
 * Учёт глубины доезжает до строки, которую пишут в базу.
 *
 * Шов между адаптером и сборщиком `rawMetadata` был единственным местом работы,
 * которое не держало ничто: `organicRowMetadata` закреплён, `serperSearch` учёт
 * возвращает, а строку `depthAudit: run.depthAudit` можно было заменить на
 * `undefined`, и весь прогон оставался зелёным — типам необязательное поле не
 * противоречит. Ревью нашло это мутацией.
 *
 * Цена пропажи — вся защита от невидимой траты: без учёта в строке «провайдер
 * проигнорировал page и мы заплатили за дубли» и «глубже ничего нет»
 * неразличимы.
 */

import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/prisma/client";
import { persistOrganicResults } from "@/modules/digital-profile/services/orion-search-profile-service";
import type { ProviderRunResult } from "@/modules/digital-profile/providers/types";
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
  internalReason: "проверка доставки учёта глубины",
  planRank: 1,
};

const realCreateMany = prisma.searchResult.createMany;

afterEach(() => {
  prisma.searchResult.createMany = realCreateMany;
});

/**
 * Перехватывает строки, которые ушли бы в базу; в сеть и в базу ничего не идёт.
 *
 * Приведение типа нужно потому, что подмена клиента у vitest — рантаймовая
 * (алиас на `tests/mocks/prisma-client.ts`), а типы `tsc` берёт у настоящего
 * Prisma: делегат объявлен там дженериком.
 */
function captureRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const capture = async (args: { data: Array<Record<string, unknown>> }) => {
    rows.push(...args.data);
    return { count: args.data.length };
  };
  prisma.searchResult.createMany = capture as unknown as typeof prisma.searchResult.createMany;
  return rows;
}

function googleRun(): ProviderRunResult {
  return {
    status: "SUCCESS",
    provider: "GOOGLE",
    results: [11, 12].map((rank) => ({
      provider: "GOOGLE" as const,
      query: "виктор рашников",
      region: "ru",
      language: "ru",
      rank,
      title: "Материал",
      snippet: "текст",
      url: `https://example.com/${rank}`,
      domain: "example.com",
      rawMetadata: { source: "serper", rank, providerPosition: rank - 10 },
      capturedAt: new Date().toISOString(),
    })),
    depthAudit: { requested: 20, perPage: [10, 10], repeatedFromEarlierPages: 10 },
  };
}

describe("строка выдачи уносит с собой учёт глубины", () => {
  it("учёт прогона доезжает до каждой записанной строки", async () => {
    const rows = captureRows();
    await persistOrganicResults("case-1", "GOOGLE", googleRun(), "RU", QUERY_SPEC);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const meta = row.rawMetadata as Record<string, unknown>;
      expect(meta.depthAudit).toEqual({
        requested: 20,
        perPage: [10, 10],
        repeatedFromEarlierPages: 10,
      });
    }
  });

  it("прогон без учёта не подсовывает строке пустой ключ", async () => {
    const rows = captureRows();
    const run = googleRun();
    delete run.depthAudit;
    await persistOrganicResults("case-1", "GOOGLE", run, "RU", QUERY_SPEC);
    expect(rows).toHaveLength(2);
    expect(rows[0].rawMetadata).not.toHaveProperty("depthAudit");
  });
});
