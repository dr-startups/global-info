/**
 * Ручной импорт считает совпадение с датой рождения субъекта, а не без неё.
 *
 * Дату субъекта загрузчик теперь читает из базы, и `importManualComplianceHit`
 * остался единственным местом, которое её знает и игнорирует: в
 * `computeMatchScore` уходил литеральный `subjectDob: null`, то есть год
 * рождения записи не с чем было сравнить. Шкала ручного импорта клиенту не
 * печатается — она живёт в базе и в кабинете аналитика, — но неверна она там
 * так же, как была неверна проверка без даты.
 */

import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const caseId = "case-manual-import-dob";
  const caseRow = {
    id: caseId,
    targetRegions: ["RU"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
    subjects: [
      {
        fullName: "Умар Назарович Кремлев",
        aliases: [],
        country: "Россия",
        nationality: "Россия",
        dateOfBirth: new Date("1982-11-01T00:00:00.000Z"),
      },
    ],
  };
  const applySelect = (row: Record<string, unknown>, select?: Record<string, unknown>): unknown => {
    if (!select) return row;
    const out: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(select)) {
      const value = row[key];
      if (spec === true) {
        out[key] = value;
        continue;
      }
      const nested = (spec as { select?: Record<string, unknown> })?.select;
      if (!nested) continue;
      out[key] = Array.isArray(value)
        ? value.map((v) => applySelect(v as Record<string, unknown>, nested))
        : applySelect(value as Record<string, unknown>, nested);
    }
    return out;
  };
  return {
    caseId,
    client: {
      case: {
        findFirst: async (args: { select?: Record<string, unknown> }) =>
          applySelect(caseRow, args?.select),
      },
      databaseProfile: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "hit-1", ...data }),
        findFirst: async () => null,
        update: async () => ({}),
      },
      riskFinding: { findFirst: async () => null, create: async () => ({ id: "f-1" }), update: async () => ({}) },
      auditLog: { create: async () => ({}) },
    },
  };
});

vi.mock("@/server/prisma/client", () => ({ prisma: db.client }));

const { importManualComplianceHit } = await import(
  "@/modules/digital-profile/compliance-providers/service"
);

describe("шкала ручного импорта", () => {
  it("совпавший год рождения виден в счёте и в признаках", async () => {
    const row = (await importManualComplianceHit(db.caseId, {
      provider: "WORLD_CHECK",
      matchedName: "Умар Назарович Кремлев",
      riskTypes: ["SANCTIONS"],
      countries: ["Россия"],
      datesOfBirth: ["1982-11-01"],
    })) as unknown as Record<string, unknown>;

    const meta = row.rawMetadataSafe as { scoringSignals?: string[] };
    expect(meta.scoringSignals).toContain("dob_year_match");
    // 40 (точное имя) + 15 (год рождения) + 10 (страна) + 10 (серьёзность).
    expect(row.matchScore).toBe(75);
  });

  it("несовпавший год рождения бонуса не даёт", async () => {
    const row = (await importManualComplianceHit(db.caseId, {
      provider: "WORLD_CHECK",
      matchedName: "Умар Назарович Кремлев",
      riskTypes: ["SANCTIONS"],
      countries: ["Россия"],
      datesOfBirth: ["1975-04-02"],
    })) as unknown as Record<string, unknown>;

    const meta = row.rawMetadataSafe as { scoringSignals?: string[] };
    expect(meta.scoringSignals).not.toContain("dob_year_match");
    expect(row.matchScore).toBe(60);
  });
});
