/**
 * Запись «связан с санкционным лицом» по-прежнему заводит задачу аналитику.
 *
 * До появления отдельного типа риска такая запись приезжала как `SANCTIONS`ы и
 * получала находку на сверку. Переименовать категорию для клиента и при этом
 * тихо перестать заводить задачу — худший из возможных исходов этой правки:
 * в отчёте запись видна, а в работе аналитика её нет. Набор типов, по которым
 * заводится находка, — второе место, куда обязан попасть новый тип, и молчать
 * оно умеет.
 */

import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    hit: {} as Record<string, unknown>,
    /** Уже заведённая находка: на ней проверяется ветка обновления. */
    existingFinding: null as Record<string, unknown> | null,
    createdFindings: [] as Array<Record<string, unknown>>,
    updatedFindings: [] as Array<Record<string, unknown>>,
  };
  return {
    state,
    client: {
      databaseProfile: {
        findFirst: async () => state.hit,
        update: async () => ({}),
      },
      riskFinding: {
        findFirst: async () => state.existingFinding,
        findUnique: async () => state.existingFinding,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          state.createdFindings.push(data);
          return { id: `finding-${state.createdFindings.length}` };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          state.updatedFindings.push(data);
          return {};
        },
      },
      auditLog: { create: async () => ({}) },
    },
  };
});

vi.mock("@/server/prisma/client", () => ({ prisma: db.client }));

const { syncComplianceRiskFinding } = await import(
  "@/modules/digital-profile/compliance-providers/service"
);

const CASE_ID = "case-sanction-linked";

async function syncHitWith(
  riskTypes: string[],
  reviewStatus = "PENDING"
): Promise<Record<string, unknown> | null> {
  db.state.createdFindings.length = 0;
  db.state.updatedFindings.length = 0;
  db.state.hit = {
    id: "hit-1",
    caseId: CASE_ID,
    provider: "OTHER",
    riskTypes,
    reviewStatus,
    matchedName: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
    profileId: "ru-inn-504309044808",
    summary: "темы: связь с санкционным лицом",
    matchScore: 100,
    riskFindingId: null,
  };
  const findingId = await syncComplianceRiskFinding(CASE_ID, "hit-1");
  return findingId ? (db.state.createdFindings[0] ?? null) : null;
}

describe("находка по записи комплаенса", () => {
  it("связь с санкционным лицом остаётся задачей на сверку", async () => {
    const finding = await syncHitWith(["SANCTION_LINKED"]);
    expect(finding, "находка не заведена").not.toBeNull();
    expect(finding).toMatchObject({
      signalType: "COMPLIANCE_DATABASE_MATCH",
      reviewStatus: "PENDING",
      // Тема — внутренняя группировка работы аналитика: разбирается вместе с
      // санкциями, хотя клиенту называется своим именем.
      riskTheme: "sanctions",
    });
  });

  it("запись без распознанной темы задачи не заводит — набор не расширился", async () => {
    expect(await syncHitWith(["OTHER"])).toBeNull();
    expect(await syncHitWith(["INSOLVENCY"])).toBeNull();
  });
});

/**
 * Уровень подтверждённой аналитиком находки.
 *
 * `severityOf` читается только на ветке `MATCH_CONFIRMED`, поэтому проверяется
 * она на уже заведённой находке. Связь с санкционным лицом — не листинг:
 * уровень у неё тот же, что у списка наблюдения, и ниже, чем у самих санкций.
 * До появления отдельного типа такая запись приезжала как `SANCTIONS` и после
 * подтверждения давала `HIGH` — снижение намеренное.
 */
describe("уровень подтверждённой находки", () => {
  it("связь с санкционным лицом — средний, санкции — высокий", async () => {
    db.state.existingFinding = { id: "finding-existing", reviewStatus: "PENDING" };
    try {
      await syncHitWith(["SANCTION_LINKED"], "MATCH_CONFIRMED");
      expect(db.state.updatedFindings[0]).toMatchObject({
        severity: "MEDIUM",
        reviewStatus: "REVIEWED",
      });
      await syncHitWith(["SANCTIONS"], "MATCH_CONFIRMED");
      expect(db.state.updatedFindings[0]).toMatchObject({ severity: "HIGH" });
      await syncHitWith(["ADVERSE_MEDIA"], "MATCH_CONFIRMED");
      expect(db.state.updatedFindings[0]).toMatchObject({ severity: "LOW" });
    } finally {
      db.state.existingFinding = null;
    }
  });
});
