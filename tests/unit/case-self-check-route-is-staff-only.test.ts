import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { fakeDb, selfCheckRow } from "../support/self-check-fakes";

/**
 * Запись проверки с сайта в админке видит только сотрудник с доступом к делу.
 *
 * В записи — доказательство согласия (адрес, браузер) и контакты заявки: это
 * данные посетителя, и ручка проверяет роль и доступ к делу до чтения, как
 * остальные ручки карточки. Хеши адреса и субъекта наружу не уходят — они
 * служат лимитам и дедупликации, а не человеку.
 */

const rig = vi.hoisted(() => ({
  calls: [] as string[],
  allowedRoles: new Set<string>(["case.view"]),
  caseAccess: true,
  record: null as unknown,
}));

vi.mock("@/modules/digital-profile/auth/guard", async () => {
  const { ForbiddenError } = await import("@/modules/digital-profile/http/errors");
  return {
    requireDigitalProfileUser: async () => ({
      id: "analyst-1",
      email: "analyst@local",
      name: "Analyst",
      role: "ANALYST",
      isActive: true,
    }),
    requireRole: (_user: unknown, action: string): void => {
      rig.calls.push(`role:${action}`);
      if (!rig.allowedRoles.has(action)) throw new ForbiddenError(`Role may not ${action}`);
    },
    requireCaseAccess: async (_user: unknown, caseId: string, level: string): Promise<void> => {
      rig.calls.push(`case:${caseId}:${level}`);
      if (!rig.caseAccess) throw new ForbiddenError("No access to this case");
    },
  };
});

vi.mock("@/modules/self-check/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/self-check/service")>();
  return {
    ...real,
    loadSelfCheckForCase: async (caseId: string) => {
      rig.calls.push(`load:${caseId}`);
      return rig.record;
    },
  };
});

const route = await import("@/app/api/digital-profile/cases/[id]/self-check/route");
const actual = await vi.importActual<typeof import("@/modules/self-check/service")>("@/modules/self-check/service");

const CASE_ID = "case-1";
const ctx = { params: Promise.resolve({ id: CASE_ID }) };
const req = () =>
  new Request(`http://localhost/api/digital-profile/cases/${CASE_ID}/self-check`) as unknown as NextRequest;

beforeEach(() => {
  rig.calls.length = 0;
  rig.allowedRoles = new Set(["case.view"]);
  rig.caseAccess = true;
  rig.record = { publicId: "public-1", status: "PERSONA_DECIDED" };
});

describe("служебная ручка проверки с сайта", () => {
  it("роль и доступ к делу проверяются до чтения записи", async () => {
    const res = await route.GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(rig.calls).toEqual(["role:case.view", `case:${CASE_ID}:VIEWER`, `load:${CASE_ID}`]);
    expect(await res.json()).toEqual({ ok: true, data: rig.record });
  });

  it("нет доступа к делу — 403, запись не читается", async () => {
    rig.caseAccess = false;
    const res = await route.GET(req(), ctx);
    expect(res.status).toBe(403);
    expect(rig.calls).not.toContain(`load:${CASE_ID}`);
  });

  it("нет роли — 403, запись не читается", async () => {
    rig.allowedRoles = new Set();
    const res = await route.GET(req(), ctx);
    expect(res.status).toBe(403);
    expect(rig.calls).not.toContain(`load:${CASE_ID}`);
  });

  it("у дела без проверки — пустые данные, а не 404", async () => {
    rig.record = null;
    const res = await route.GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: null });
  });
});

describe("запись для админки", () => {
  it("целиком, кроме хешей адреса и субъекта", async () => {
    const row = selfCheckRow({ leadName: "Иван", leadPhone: "+79000000000", leadStatus: "NEW" });
    const { db } = fakeDb({ selfChecks: [row] });
    const record = (await actual.loadSelfCheckForCase(CASE_ID, { db: db as never })) as Record<string, unknown>;
    expect(record).not.toHaveProperty("ipHash");
    expect(record).not.toHaveProperty("subjectHash");
    expect(record).toMatchObject({
      publicId: row.publicId,
      status: row.status,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 test",
      consentVersion: row.consentVersion,
      leadPhone: "+79000000000",
      leadStatus: "NEW",
      inputJson: row.inputJson,
    });
  });

  it("у дела без проверки — null", async () => {
    const { db } = fakeDb();
    expect(await actual.loadSelfCheckForCase("case-without-check", { db: db as never })).toBeNull();
  });
});
