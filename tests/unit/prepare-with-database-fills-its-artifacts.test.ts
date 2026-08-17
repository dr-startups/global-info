/**
 * Делегаты бандла — те самые, которые подготовка отчёта действительно читает.
 *
 * Между «бандл собран» и «артефакт наполнен» лежат три резолвера, и каждый
 * берёт свой делегат по имени. Переименовали в бандле — резолвер молча пойдёт
 * веткой «данных нет»: типы этого не поймают (входы `Partial`), а отчёт
 * скажет, что скрининга не было и совпадение не подтверждено. Поэтому связь
 * проверяется сквозным прогоном подготовки на живом бандле.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import { resolvePreparePrismaBundle } from "@/modules/digital-profile/services/prepare-prisma-bundle";
import {
  TINY_ADVERSE_URL,
  TINY_CASE_ID,
  tinyPrepareInput,
} from "../fixtures/tiny-canonical-prepare";

/** Клиент базы с данными, которые аналитик и скрининг оставляют по кейсу. */
function caseWithDatabaseWork() {
  return {
    searchResult: {
      count: async () => 2,
      findMany: async () => [
        {
          id: "sr-1",
          url: TINY_ADVERSE_URL,
          rawMetadata: {
            riskClassification: {
              manual: { classification: "NEUTRAL", riskTheme: null },
            },
          },
        },
      ],
    },
    searchSurfaceItem: { count: async () => 1 },
    databaseProfile: {
      findMany: async () => [
        {
          id: "hit-lexis-1",
          provider: "LEXISNEXIS",
          importMethod: "MANUAL",
          hitSource: "MANUAL",
          matchedName: "Anders Holmström",
          subjectName: "Anders Holmström",
          matchType: "ADVERSE_MEDIA",
          matchScore: 71,
          reviewStatus: "MATCH_CONFIRMED",
          riskTypes: ["ADVERSE_MEDIA"],
          countries: ["Швеция"],
          confidence: "HIGH",
          profileId: "LN-AM-1",
          summary: "Adverse media hit confirmed by the analyst.",
        },
      ],
    },
    complianceScreeningRun: {
      findMany: async () => [
        {
          provider: "OPEN_SANCTIONS",
          status: "SUCCESS",
          hitCount: 0,
          startedAt: "2026-08-01T09:00:00.000Z",
          finishedAt: "2026-08-01T09:00:12.000Z",
        },
      ],
    },
    riskFinding: { findMany: async () => [] },
    wikipediaCheck: {
      findMany: async () => [
        {
          id: "wiki-1",
          exists: true,
          url: "https://ru.wikipedia.org/wiki/Хольмстрём,_Андерс",
          language: "ru",
          pageTitle: "Хольмстрём, Андерс",
          lastChecked: "2026-08-01T09:00:00.000Z",
          checkedBy: "real:WIKIPEDIA",
        },
      ],
    },
    serpCapture: { findMany: async () => [] },
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("подготовка отчёта с бандлом базы", () => {
  it("наполняет артефакты, которые без делегатов оставались пустыми", async () => {
    const root = mkdtempSync(join(tmpdir(), "prepare-with-db-"));
    const prisma = await resolvePreparePrismaBundle(caseWithDatabaseWork() as never);

    const res = await runCanonicalReportPrepare(await tinyPrepareInput(root, { prisma }));

    expect(res.ok).toBe(true);
    const inventory = readJson<{
      count: number;
      items: unknown[];
      screenings: Array<{ provider: string; status: string }>;
    }>(join(root, "analytics", "compliance-inventory.json"));
    expect(inventory.items.length).toBeGreaterThanOrEqual(1);
    expect(inventory.screenings.map((s) => s.provider)).toContain("OPEN_SANCTIONS");

    const supplement = readJson<{ caseId: string; wikipediaChecks: unknown[] }>(
      join(root, "analytics", "evidence-supplement.json")
    );
    expect(supplement.caseId).toBe(TINY_CASE_ID);
    expect(supplement.wikipediaChecks.length).toBeGreaterThanOrEqual(1);

    const overrides = readJson<{ count: number }>(
      join(root, "analytics", "analyst-overrides-applied.json")
    );
    expect(overrides.count).toBeGreaterThanOrEqual(1);

    // Воронка «в базе против довезённого» слепнет без счётчиков: `null` там
    // означает «не спрашивали», а не «ноль».
    const quality = readJson<{ counts: { dbSearchResults: number | null } }>(
      join(root, "report-quality-summary.json")
    );
    expect(quality.counts.dbSearchResults).toBe(2);
  });
});
