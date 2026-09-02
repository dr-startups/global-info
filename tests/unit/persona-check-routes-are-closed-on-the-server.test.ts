import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { digitalProfileConfig } from "@/modules/digital-profile/config";

/**
 * Решать вправе те же роли, что запускают сбор: решает тот, кто платит.
 * Гард в интерфейсе закрыт и на сервере — скрытая кнопка ничего не гарантирует.
 *
 * Спрашивается сам обработчик, а не текст файла. Обработчиков в файле два, и
 * поиск подстроки по всему файлу находил `requireCaseAccess` в GET, когда из
 * POST её уже убрали: пользователь с ролью, но без доступа к делу собирал
 * панель по чужому субъекту, а проверка оставалась зелёной.
 */

const rig = vi.hoisted(() => ({
  calls: [] as string[],
  allowedRoles: new Set<string>(["agents.run", "agents.runReal"]),
  caseAccess: true,
}));

vi.mock("@/modules/digital-profile/auth/guard", async () => {
  const { ForbiddenError } = await import("@/modules/digital-profile/http/errors");
  return {
    requireDigitalProfileUser: async () => ({
      id: "operator-1",
      email: "operator@local",
      name: "Operator",
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

vi.mock("@/modules/digital-profile/agents/mock/mock-utils", () => ({
  loadCaseSubject: async (caseId: string) => {
    rig.calls.push("subject");
    return {
      caseId,
      fullName: "Петров Иван Иванович",
      aliases: [],
      targetRegions: ["RU"],
      location: null,
      dateOfBirth: "1970-03-05",
      nationality: null,
      lawfulBasis: null,
      consentStatus: null,
      isFixture: false,
    };
  },
}));

vi.mock("@/modules/digital-profile/services/audit-log-service", () => ({
  recordAudit: async (input: { action: string }) => {
    rig.calls.push(`audit:${input.action}`);
  },
}));

vi.mock("@/modules/digital-profile/services/subject-persona-check", () => ({
  buildPersonaPanel: async () => {
    rig.calls.push("buildPersonaPanel");
    return {
      request: { terms: [], languages: [], serperQueries: [], budgetMs: 1 },
      snapshot: { cards: [], sources: [], fetchStatus: "SUCCESS", errorCode: null },
    };
  },
  recordPersonaCheck: async () => {
    rig.calls.push("recordPersonaCheck");
    return { id: "check-1" };
  },
  recordPersonaDecision: async () => {
    rig.calls.push("recordPersonaDecision");
    return { id: "check-1", decision: "APPROVED_WITHOUT_PERSONA", decidedBy: "operator-1" };
  },
  loadLatestPersonaCheck: async () => {
    rig.calls.push("loadLatestPersonaCheck");
    return null;
  },
  loadPersonaGateInput: async () => {
    rig.calls.push("loadPersonaGateInput");
    return { isFixture: false, subjectInputHash: "hash", decidedHashes: [] };
  },
  personaGateState: () => ({ mode: "PENDING", reason: "PERSONA_NOT_CONFIRMED" }),
  subjectInputHash: () => "hash",
}));

const panelRoute = await import("@/app/api/digital-profile/cases/[id]/persona-check/route");
const decisionRoute = await import(
  "@/app/api/digital-profile/cases/[id]/persona-check/decision/route"
);

const CASE_ID = "case-of-somebody-else";
const ctx = { params: Promise.resolve({ id: CASE_ID }) };

function req(body?: unknown): NextRequest {
  const url = `http://localhost/api/digital-profile/cases/${CASE_ID}/persona-check`;
  const init =
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        };
  return new Request(url, init) as unknown as NextRequest;
}

/** Работа обработчика — то, чего не должно случиться у отказа. */
const WORK = ["buildPersonaPanel", "recordPersonaCheck", "recordPersonaDecision"];
const worked = (): string[] => rig.calls.filter((c) => WORK.includes(c));

const decisionBody = { checkId: "check-1", decision: "APPROVED_WITHOUT_PERSONA" };

beforeEach(() => {
  rig.calls.length = 0;
  rig.allowedRoles = new Set(["agents.run", "agents.runReal"]);
  rig.caseAccess = true;
});

describe("маршруты выбора персоны закрыты на сервере", () => {
  it("сборка панели проверяет роль и доступ к делу до работы", async () => {
    const res = await panelRoute.POST(req(), ctx);
    expect(res.status).toBe(201);
    expect(rig.calls.indexOf('role:agents.run')).toBeGreaterThanOrEqual(0);
    expect(rig.calls.indexOf(`case:${CASE_ID}:VIEWER`)).toBeGreaterThanOrEqual(0);
    // Оба гарда стоят до работы, а не после неё.
    expect(rig.calls.indexOf("role:agents.run")).toBeLessThan(
      rig.calls.indexOf("buildPersonaPanel")
    );
    expect(rig.calls.indexOf(`case:${CASE_ID}:VIEWER`)).toBeLessThan(
      rig.calls.indexOf("buildPersonaPanel")
    );
    if (!digitalProfileConfig.mockAgents) {
      expect(rig.calls).toContain("role:agents.runReal");
    }
  });

  it("роль есть, доступа к делу нет — сборка панели отказана и не выполнена", async () => {
    rig.caseAccess = false;
    const res = await panelRoute.POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(worked()).toEqual([]);
    expect(rig.calls).not.toContain("audit:PERSONA_PANEL_BUILT");
  });

  it("роль есть, доступа к делу нет — чужой снимок не отдаётся и по GET", async () => {
    rig.caseAccess = false;
    const res = await panelRoute.GET(req(), ctx);
    expect(res.status).toBe(403);
    expect(rig.calls).not.toContain("loadLatestPersonaCheck");
  });

  it("роль есть, доступа к делу нет — решение по чужому делу не записывается", async () => {
    rig.caseAccess = false;
    const res = await decisionRoute.POST(req(decisionBody), ctx);
    expect(res.status).toBe(403);
    expect(worked()).toEqual([]);
    expect(rig.calls).not.toContain("audit:PERSONA_DECIDED");
  });

  it("без роли запускающего сбор оба маршрута отказывают, а не отдают пустой ответ", async () => {
    rig.allowedRoles = new Set();
    const panel = await panelRoute.POST(req(), ctx);
    expect(panel.status).toBe(403);
    const decision = await decisionRoute.POST(req(decisionBody), ctx);
    expect(decision.status).toBe(403);
    const view = await panelRoute.GET(req(), ctx);
    expect(view.status).toBe(403);
    expect(worked()).toEqual([]);
    expect(rig.calls).not.toContain("loadLatestPersonaCheck");
  });

  it("оба действия попадают в аудит-лог с автором", async () => {
    await panelRoute.POST(req(), ctx);
    expect(rig.calls).toContain("audit:PERSONA_PANEL_BUILT");
    rig.calls.length = 0;
    await decisionRoute.POST(req(decisionBody), ctx);
    expect(rig.calls).toContain("audit:PERSONA_DECIDED");
  });
});

const read = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");

const START_ROUTE = "src/app/api/digital-profile/cases/[id]/unified-collection/route.ts";
const PANEL_ROUTE = "src/app/api/digital-profile/cases/[id]/persona-check/route.ts";
const DECISION_ROUTE =
  "src/app/api/digital-profile/cases/[id]/persona-check/decision/route.ts";

describe("ворота считаются в одном месте", () => {
  it("маршрут не заводит второго ответа на вопрос ворот", () => {
    // Ворота считает `personaGateState` и применяет оркестратор; маршруты
    // панели только показывают состояние, а маршрут старта не проверяет ничего.
    for (const path of [PANEL_ROUTE, DECISION_ROUTE]) {
      const src = read(path);
      expect(src, path).not.toMatch(/ConflictError/u);
      expect(src, path).not.toMatch(/PERSONA_NOT_CONFIRMED/u);
    }
    expect(read(START_ROUTE)).not.toMatch(/personaGateState|loadPersonaGateInput/u);
  });

  it("подставить состояние ворот снаружи нельзя: маршрут старта его не передаёт", () => {
    const start = read(START_ROUTE);
    expect(start).not.toMatch(/loadPersonaGateInput/u);
    expect(start).not.toMatch(/deps:/u);
  });
});
