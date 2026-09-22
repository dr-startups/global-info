/**
 * Записанная строка Google несёт пометки своего запроса — сквозь весь цикл сбора (шаг 0146).
 *
 * Мутация «цикл копирует спеку по полям» (`{ query, contour }` вместо спеки
 * целиком) оставила зелёными все проверки функций по отдельности: цикл сбора не
 * исполнял ни один тест, и назначение с пометкой имени снова терялись бы между
 * планом и базой — ровно там, где их потеряли шаги 0137–0138.
 *
 * Здесь агент запускается целиком: план → провайдер → запись. База и сеть
 * подменены, наружу не уходит ничего; проверяется то, что легло бы в
 * `search_results`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/prisma/client";
import { RealGoogleSearchAgent } from "@/modules/digital-profile/agents/real/real-google-search-agent";
import type { SearchProvider } from "@/modules/digital-profile/providers/search-provider";
import type { ProviderRunResult, SearchProviderRequest } from "@/modules/digital-profile/providers/types";

type Db = Record<string, unknown>;
const db = prisma as unknown as Db;
const saved: Db = {};
let rows: Array<Record<string, unknown>> = [];

/** Провайдер без сети: на каждый запрос одна строка с общим адресом. */
const fakeProvider = {
  name: "serper",
  availability: () => ({ status: "AVAILABLE" }),
  enabled: () => true,
  validateConfig: () => ({ ok: true }),
  search: async (req: SearchProviderRequest): Promise<ProviderRunResult> => ({
    status: "SUCCESS",
    provider: "GOOGLE",
    results: [
      {
        provider: "GOOGLE",
        query: req.query,
        region: req.region ?? "ru",
        language: req.language ?? "ru",
        rank: 1,
        title: "Мельниченко, Андрей Игоревич — Википедия",
        snippet: "s",
        url: "https://ru.wikipedia.org/wiki/Мельниченко,_Андрей_Игоревич",
        domain: "ru.wikipedia.org",
        rawMetadata: { source: "serper", rank: 1 },
        capturedAt: new Date(0).toISOString(),
      },
    ],
  }),
} as unknown as SearchProvider;

class OfflineGoogleAgent extends RealGoogleSearchAgent {
  protected override readonly provider: SearchProvider = fakeProvider;
}

beforeEach(() => {
  rows = [];
  for (const k of ["case", "auditLog", "searchQuery", "searchResult"]) saved[k] = db[k];
  db.case = {
    findFirst: async () => ({
      id: "case-0146",
      targetRegions: ["RU", "UAE"],
      lawfulBasis: "PUBLIC_INTEREST",
      consentStatus: null,
      isFixture: false,
      subjects: [
        {
          fullName: "Мельниченко Андрей Игоревич",
          aliases: ["А. Мельниченко", "Andrey Melnichenko", "Andrei Melnichenko"],
          country: null,
          dateOfBirth: null,
          nationality: null,
        },
      ],
    }),
  };
  db.auditLog = { create: async () => ({}) };
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
  for (const k of Object.keys(saved)) db[k] = saved[k];
});

const meta = (r: Record<string, unknown>) => r.rawMetadata as Record<string, unknown>;

describe("агент Google записывает строки с пометками плана", () => {
  it("З1: строка основного запроса каждого контура несёт «это само имя» и назначение", async () => {
    const result = await new OfflineGoogleAgent().run({ caseId: "case-0146" } as never);
    expect(result.status).toBe("SUCCEEDED");
    const named = rows.filter((r) => meta(r).subjectNameQuery === true);
    expect(named.map((r) => `${meta(r).orionRegion}:${meta(r).query}`).sort()).toEqual([
      "RU:Мельниченко Андрей Игоревич",
      "UAE:Andrey Melnichenko",
    ]);
    for (const r of named) expect(meta(r).queryPurpose).toBe("subject_lookup");
  });

  it("З2: один адрес под каждым запросом плана — отдельная строка", async () => {
    await new OfflineGoogleAgent().run({ caseId: "case-0146" } as never);
    const hashes = new Set(rows.map((r) => r.dedupHash));
    expect(hashes.size).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(2);
  });
});
