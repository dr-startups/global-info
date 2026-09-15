import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createSelfCheckToken } from "@/modules/self-check/token";
import { selfCheckRow } from "../support/self-check-fakes";

/**
 * Публичные ручки проверки открываются только cookie своей проверки.
 *
 * Посетитель — не пользователь приложения: доступ к проверке даёт подписанный
 * токен в cookie, выданный при её создании. Ни отсутствие cookie, ни cookie
 * другой проверки, ни чужая подпись не открывают ни статуса, ни панели, ни
 * решения, ни заявки — и отказ случается до работы, а не после неё.
 *
 * Спрашиваются сами обработчики, сервис подменён: здесь проверяется гард.
 */

const rig = vi.hoisted(() => {
  process.env.DIGITAL_PROFILE_SESSION_SECRET = "routes-test-secret-0123456789abcdef";
  return { checks: new Map<string, unknown>(), calls: [] as string[] };
});

vi.mock("@/modules/self-check/service", () => ({
  loadSelfCheckByPublicId: async (publicId: string) => rig.checks.get(publicId) ?? null,
  getSelfCheckStatus: async (check: { id: string; publicId: string; status: string }) => {
    rig.calls.push(`status:${check.id}`);
    return { publicId: check.publicId, status: check.status };
  },
  buildSelfCheckPersona: async (check: { id: string }) => {
    rig.calls.push(`persona:${check.id}`);
    return { checkId: "persona-1", cards: [], sources: [], decision: null };
  },
  decideSelfCheckPersona: async (check: { id: string }) => {
    rig.calls.push(`decision:${check.id}`);
    return { decision: "APPROVED_WITHOUT_PERSONA", decidedAt: new Date() };
  },
  submitSelfCheckLead: async (check: { id: string }) => {
    rig.calls.push(`lead:${check.id}`);
    return { leadAt: new Date() };
  },
  startSelfCheckRun: async (check: { id: string }) => {
    rig.calls.push(`run:${check.id}`);
    return { status: "RUNNING", nextPollMs: 7000 };
  },
  createSelfCheck: async () => {
    rig.calls.push("create");
    return { kind: "created", checkId: "check-new", publicId: "new-public-id", status: "CREATED", token: "new-token" };
  },
}));

const statusRoute = await import("@/app/api/self-check/[publicId]/route");
const personaRoute = await import("@/app/api/self-check/[publicId]/persona/route");
const decisionRoute = await import("@/app/api/self-check/[publicId]/persona/decision/route");
const leadRoute = await import("@/app/api/self-check/[publicId]/lead/route");
const runRoute = await import("@/app/api/self-check/[publicId]/run/route");
const createRoute = await import("@/app/api/self-check/route");

const SECRET = process.env.DIGITAL_PROFILE_SESSION_SECRET!;
const A = selfCheckRow({ id: "check-a", publicId: "public-a-0123456789abcdef", status: "PERSONA_DECIDED" });
const B = selfCheckRow({ id: "check-b", publicId: "public-b-0123456789abcdef" });
const EXPIRED = selfCheckRow({
  id: "check-x",
  publicId: "public-x-0123456789abcdef",
  status: "EXPIRED",
  anonymizedAt: new Date("2026-09-10T00:00:00Z"),
  inputJson: null,
  ip: null,
  userAgent: null,
});

type Handler = (req: NextRequest, ctx: { params: Promise<{ publicId: string }> }) => Promise<Response>;

const ROUTES: Array<{ name: string; handler: Handler; body?: unknown }> = [
  { name: "статус", handler: statusRoute.GET as Handler },
  { name: "панель персоны", handler: personaRoute.POST as Handler },
  { name: "решение", handler: decisionRoute.POST as Handler, body: { decision: "APPROVED_WITHOUT_PERSONA" } },
  { name: "заявка", handler: leadRoute.POST as Handler, body: { name: "Иван", phone: "+7 900 000-00-00" } },
  { name: "запуск", handler: runRoute.POST as Handler },
];

function call(
  route: { handler: Handler; body?: unknown },
  publicId: string,
  cookie?: string
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = `dp_selfcheck=${cookie}`;
  const req = new Request(`http://localhost/api/self-check/${publicId}`, {
    method: route.body === undefined && route.handler === statusRoute.GET ? "GET" : "POST",
    headers,
    ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
  }) as unknown as NextRequest;
  return route.handler(req, { params: Promise.resolve({ publicId }) });
}

async function reason(res: Response): Promise<string | undefined> {
  const json = (await res.json()) as { error?: { details?: { reason?: string } } };
  return json.error?.details?.reason;
}

beforeEach(() => {
  rig.calls.length = 0;
  rig.checks = new Map([
    [A.publicId, A],
    [B.publicId, B],
    [EXPIRED.publicId, EXPIRED],
  ]);
  delete process.env.SELF_CHECK_ENABLED;
});

afterEach(() => {
  delete process.env.SELF_CHECK_ENABLED;
});

describe("без своей cookie ручки проверки закрыты", () => {
  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: без cookie — 403 и никакой работы", async (_n, route) => {
    const res = await call(route, A.publicId);
    expect(res.status).toBe(403);
    expect(await reason(res)).toBe("SELF_CHECK_FORBIDDEN");
    expect(rig.calls).toEqual([]);
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: cookie другой проверки — 403", async (_n, route) => {
    const foreign = await createSelfCheckToken(B.id, SECRET);
    const res = await call(route, A.publicId, foreign);
    expect(res.status).toBe(403);
    expect(rig.calls).toEqual([]);
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: токен своей проверки с чужой подписью — 403", async (_n, route) => {
    const forged = await createSelfCheckToken(A.id, "attacker-secret-0123456789abcdef");
    const res = await call(route, A.publicId, forged);
    expect(res.status).toBe(403);
    expect(rig.calls).toEqual([]);
  });
});

describe("со своей cookie", () => {
  it("статус, панель, решение, заявка и запуск работают со своей проверкой", async () => {
    const own = await createSelfCheckToken(A.id, SECRET);
    for (const route of ROUTES) {
      const res = await call(route, A.publicId, own);
      // Запуск принимает работу, а не отдаёт её результат.
      expect(res.status, route.name).toBe(route.name === "запуск" ? 202 : 200);
    }
    expect(rig.calls).toEqual([
      "status:check-a",
      "persona:check-a",
      "decision:check-a",
      "lead:check-a",
      "run:check-a",
    ]);
  });

  it("несуществующая проверка — 404", async () => {
    const own = await createSelfCheckToken(A.id, SECRET);
    const res = await call(ROUTES[0]!, "public-missing-0123456789", own);
    expect(res.status).toBe(404);
  });

  it("обезличенная проверка — 410 даже без cookie: срок cookie истёк вместе со сроком хранения", async () => {
    const res = await call(ROUTES[0]!, EXPIRED.publicId);
    expect(res.status).toBe(410);
    expect(await reason(res)).toBe("SELF_CHECK_EXPIRED");
    expect(rig.calls).toEqual([]);
  });
});

describe("создание проверки", () => {
  const form = { fullName: "Иванов Иван Иванович", birthDate: "1985-03-12", consent: true };

  it("ставит httpOnly cookie на путь публичного API на срок доступа", async () => {
    const req = new Request("http://localhost/api/self-check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    }) as unknown as NextRequest;
    const res = await createRoute.POST(req);
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("dp_selfcheck=new-token");
    expect(cookie).toMatch(/Path=\/api\/self-check/iu);
    expect(cookie).toMatch(/HttpOnly/iu);
    expect(cookie).toMatch(/SameSite=lax/iu);
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    expect(await res.json()).toEqual({ ok: true, data: { publicId: "new-public-id", status: "CREATED" } });
  });
});

describe("рубильник и заголовки", () => {
  it("выключенный рубильник — 503 SELF_CHECK_DISABLED на всех шести ручках, работы нет", async () => {
    process.env.SELF_CHECK_ENABLED = "false";
    const own = await createSelfCheckToken(A.id, SECRET);
    for (const route of ROUTES) {
      const res = await call(route, A.publicId, own);
      expect(res.status, route.name).toBe(503);
      expect(await reason(res), route.name).toBe("SELF_CHECK_DISABLED");
    }
    const create = await createRoute.POST(
      new Request("http://localhost/api/self-check", {
        method: "POST",
        body: "{}",
      }) as unknown as NextRequest
    );
    expect(create.status).toBe(503);
    expect(rig.calls).toEqual([]);
  });

  it("ни ответ, ни отказ не кэшируются и не индексируются", async () => {
    const own = await createSelfCheckToken(A.id, SECRET);
    const ok = await call(ROUTES[0]!, A.publicId, own);
    const refused = await call(ROUTES[0]!, A.publicId);
    process.env.SELF_CHECK_ENABLED = "false";
    const disabled = await call(ROUTES[0]!, A.publicId, own);
    for (const res of [ok, refused, disabled]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    }
  });
});

describe("испорченная cookie", () => {
  // Битая %-кодировка — не токен, а не повод для ошибки сервера: публичную
  // ручку дёргает кто угодно, и 500 на ровном месте — это шум в логе и
  // неверный ответ посетителю.
  const BROKEN = "%E0%A4%A";

  it("ручка проверки отвечает 403, а не 500", async () => {
    const res = await call(ROUTES[0]!, A.publicId, BROKEN);
    expect(res.status).toBe(403);
    expect(await reason(res)).toBe("SELF_CHECK_FORBIDDEN");
    expect(rig.calls).toEqual([]);
  });

  it("создание проверки она не ломает", async () => {
    const req = new Request("http://localhost/api/self-check", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `dp_selfcheck=${BROKEN}` },
      body: JSON.stringify({ fullName: "Иванов Иван Иванович", birthDate: "1985-03-12", consent: true }),
    }) as unknown as NextRequest;
    const res = await createRoute.POST(req);
    expect(res.status).toBe(201);
  });
});
