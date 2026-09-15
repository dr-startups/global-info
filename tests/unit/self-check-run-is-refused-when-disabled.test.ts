import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createSelfCheckToken } from "@/modules/self-check/token";
import { selfCheckRow } from "../support/self-check-fakes";

/**
 * Ручка запуска закрыта рубильником раньше, чем начинается платная работа.
 *
 * Суточного потолка прогонов нет (решение владельца 15.09.2026: новых лимитов
 * не вводить), поэтому остановить запуски целиком может только рубильник
 * `SELF_CHECK_ENABLED`, и он обязан срабатывать до сервиса запуска.
 */

const rig = vi.hoisted(() => {
  process.env.DIGITAL_PROFILE_SESSION_SECRET = "run-route-test-secret-0123456789abcdef";
  return { check: null as unknown, started: [] as string[] };
});

vi.mock("@/modules/self-check/service", () => ({
  loadSelfCheckByPublicId: async () => rig.check,
  startSelfCheckRun: async (check: { id: string }) => {
    rig.started.push(check.id);
    return { status: "RUNNING", nextPollMs: 7000 };
  },
}));

const runRoute = await import("@/app/api/self-check/[publicId]/run/route");

const CHECK = selfCheckRow({ id: "check-run", publicId: "public-run-0123456789abcdef", status: "PERSONA_DECIDED" });

function post(cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = `dp_selfcheck=${cookie}`;
  const req = new Request(`http://localhost/api/self-check/${CHECK.publicId}/run`, {
    method: "POST",
    headers,
  }) as unknown as NextRequest;
  return runRoute.POST(req, { params: Promise.resolve({ publicId: CHECK.publicId }) });
}

beforeEach(() => {
  rig.check = CHECK;
  rig.started.length = 0;
  delete process.env.SELF_CHECK_ENABLED;
});

afterEach(() => {
  delete process.env.SELF_CHECK_ENABLED;
});

describe("рубильник", () => {
  it("выключен — 503 SELF_CHECK_DISABLED даже со своей cookie, прогон не запускается", async () => {
    process.env.SELF_CHECK_ENABLED = "false";
    const res = await post(await createSelfCheckToken(CHECK.id, process.env.DIGITAL_PROFILE_SESSION_SECRET!));
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { details: { reason: string } } };
    expect(json.error.details.reason).toBe("SELF_CHECK_DISABLED");
    expect(rig.started).toEqual([]);
  });

  it("включён — 202, прогон запущен ровно один раз", async () => {
    const res = await post(await createSelfCheckToken(CHECK.id, process.env.DIGITAL_PROFILE_SESSION_SECRET!));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, data: { status: "RUNNING", nextPollMs: 7000 } });
    expect(rig.started).toEqual(["check-run"]);
  });

  it("без cookie — 403 до запуска", async () => {
    const res = await post();
    expect(res.status).toBe(403);
    expect(rig.started).toEqual([]);
  });
});
