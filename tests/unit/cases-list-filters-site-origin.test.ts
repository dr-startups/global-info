import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { caseListWhere } from "@/modules/digital-profile/services/case-service";
import { ListDigitalProfileCasesQuerySchema } from "@/modules/digital-profile/validation/case-schemas";
import { SELF_CHECK_ACTOR_PREFIX, selfCheckActor } from "@/modules/self-check/actor";

/**
 * Список дел умеет показать только дела, заведённые проверкой с сайта.
 *
 * Уведомлений о лидах в MVP нет (решение заказчика 12.09), поэтому менеджер
 * находит новые заявки фильтром «с сайта». Признак — автор кейса: проверка
 * заводит его от своего имени `self-check:<id>`, и новых колонок в делах нет.
 */

const rig = vi.hoisted(() => ({ listed: [] as unknown[] }));

vi.mock("@/modules/digital-profile/auth/guard", () => ({
  requireDigitalProfileUser: async () => ({
    id: "admin-1",
    email: "admin@local",
    name: "Admin",
    role: "SUPER_ADMIN",
    isActive: true,
  }),
  requireRole: () => undefined,
  actorOf: (user: { id: string }) => ({ actorId: user.id }),
}));

vi.mock("@/modules/digital-profile/auth/access-service", () => ({
  accessibleCaseIds: async () => null,
}));

vi.mock("@/modules/digital-profile/services/case-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/digital-profile/services/case-service")>();
  return {
    ...real,
    listCases: async (query: unknown) => {
      rig.listed.push(query);
      return { items: [], total: 0, page: 1, pageSize: 20 };
    },
  };
});

const casesRoute = await import("@/app/api/digital-profile/cases/route");

beforeEach(() => {
  rig.listed.length = 0;
});

describe("выборка дел с сайта", () => {
  it("origin=site — дела, автор которых проверка с сайта", () => {
    expect(caseListWhere({ origin: "site" })).toMatchObject({
      createdBy: { startsWith: SELF_CHECK_ACTOR_PREFIX },
      deletedAt: null,
      isFixture: false,
    });
  });

  it("без origin — все дела, как раньше", () => {
    expect(caseListWhere({})).not.toHaveProperty("createdBy");
  });

  it("фильтр сочетается с поиском и статусом", () => {
    const where = caseListWhere({ origin: "site", status: "DRAFT", q: "иванов" });
    expect(where).toMatchObject({ createdBy: { startsWith: SELF_CHECK_ACTOR_PREFIX }, status: "DRAFT" });
    expect(where.OR).toHaveLength(3);
  });

  it("автор кейса и фильтр отвечают одним префиксом", () => {
    expect(SELF_CHECK_ACTOR_PREFIX).toBe("self-check:");
    expect(selfCheckActor("abc")).toBe("self-check:abc");
  });
});

describe("запрос списка", () => {
  it("принимает только site", () => {
    expect(ListDigitalProfileCasesQuerySchema.parse({ origin: "site" }).origin).toBe("site");
    expect(ListDigitalProfileCasesQuerySchema.parse({}).origin).toBeUndefined();
    expect(ListDigitalProfileCasesQuerySchema.safeParse({ origin: "admin" }).success).toBe(false);
  });

  it("ручка списка передаёт origin в выборку", async () => {
    const res = await casesRoute.GET(new NextRequest("http://localhost/api/digital-profile/cases?origin=site"));
    expect(res.status).toBe(200);
    expect(rig.listed[0]).toMatchObject({ origin: "site" });
  });
});
