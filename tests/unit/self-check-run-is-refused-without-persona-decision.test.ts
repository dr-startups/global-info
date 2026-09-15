import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "@/modules/digital-profile/http/errors";
import { startSelfCheckRun } from "@/modules/self-check/service";
import { TEST_NOW, fakeDb, refusal, selfCheckRow } from "../support/self-check-fakes";

/**
 * Прогон стоит денег, и запускается он ровно один раз и только после решения
 * по персоне.
 *
 * Статус записи отвечает на «можно ли запускать», а условное обновление
 * `PERSONA_DECIDED → RUNNING` — на «не запущен ли уже»: двойное нажатие
 * «Проверить» не должно оплатить второй прогон. Ворота персоны оркестратора
 * остаются последним словом: если решение устарело, запись возвращается туда,
 * где была, и отказ уходит посетителю как есть.
 */

const ctx = { ip: "203.0.113.7" };

function setup(check = selfCheckRow({ status: "PERSONA_DECIDED" })) {
  const { db, state } = fakeDb({ selfChecks: [check] });
  const startRun = vi.fn(async (_input: { caseId: string; requestedBy: string; mode: "light" }) => ({
    unifiedJobId: "unified-job-1",
  }));
  const deps = { db: db as never, now: () => TEST_NOW, env: {} as NodeJS.ProcessEnv, startRun };
  return { check, db, state, startRun, deps };
}

describe("без решения по персоне", () => {
  it.each(["CREATED", "PERSONA_PENDING"])("в статусе %s — 409 PERSONA_NOT_CONFIRMED, прогона нет", async (status) => {
    const s = setup(selfCheckRow({ status }));
    const err = await refusal(startSelfCheckRun(s.check, ctx, s.deps));
    expect(err).toMatchObject({ status: 409, code: "CONFLICT", details: { reason: "PERSONA_NOT_CONFIRMED" } });
    expect(s.startRun).not.toHaveBeenCalled();
    expect(s.state.selfChecks[0]!.status).toBe(status);
  });
});

describe("прогон уже был", () => {
  it.each(["RUNNING", "DONE", "FAILED"])("в статусе %s — 409 RUN_ALREADY_STARTED", async (status) => {
    const s = setup(selfCheckRow({ status }));
    const err = await refusal(startSelfCheckRun(s.check, ctx, s.deps));
    expect(err).toMatchObject({ status: 409, details: { reason: "RUN_ALREADY_STARTED" } });
    expect(s.startRun).not.toHaveBeenCalled();
  });

  it("запись, пойманная ловушкой, не запускается", async () => {
    const s = setup(selfCheckRow({ status: "BLOCKED", honeypotTripped: true, caseId: null }));
    const err = await refusal(startSelfCheckRun(s.check, ctx, s.deps));
    expect(err).toMatchObject({ status: 409, details: { reason: "SELF_CHECK_BLOCKED" } });
    expect(s.startRun).not.toHaveBeenCalled();
  });

  it("два нажатия подряд — один прогон, второе получает 409", async () => {
    const s = setup();
    const results = await Promise.allSettled([
      startSelfCheckRun(s.check, ctx, s.deps),
      startSelfCheckRun(s.check, ctx, s.deps),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, details: { reason: "RUN_ALREADY_STARTED" } });
    expect(s.startRun).toHaveBeenCalledTimes(1);
  });
});

describe("после решения по персоне", () => {
  it("запускается лёгкий прогон от имени проверки, запись — RUNNING", async () => {
    const s = setup();
    const out = await startSelfCheckRun(s.check, ctx, s.deps);
    expect(out).toEqual({ status: "RUNNING", nextPollMs: 7000 });
    expect(s.startRun).toHaveBeenCalledWith({
      caseId: "case-1",
      requestedBy: "self-check:check-1",
      mode: "light",
    });
    expect(s.state.selfChecks[0]).toMatchObject({
      status: "RUNNING",
      runStartedAt: TEST_NOW,
      jobId: "unified-job-1",
    });
    expect(s.state.audits.find((a) => a.action === "SELF_CHECK_RUN_STARTED")).toMatchObject({
      caseId: "case-1",
      actorId: "self-check:check-1",
      ipAddress: "203.0.113.7",
      metadata: { jobId: "unified-job-1" },
    });
  });

  it("ворота персоны отказали — запись возвращается к решению, отказ уходит как есть", async () => {
    const s = setup();
    s.startRun.mockRejectedValueOnce(
      new ConflictError("persona decision is stale", { reason: "PERSONA_DECISION_STALE" })
    );
    const err = await refusal(startSelfCheckRun(s.check, ctx, s.deps));
    expect(err).toMatchObject({ status: 409, details: { reason: "PERSONA_DECISION_STALE" } });
    expect(s.state.selfChecks[0]).toMatchObject({ status: "PERSONA_DECIDED", runStartedAt: null, jobId: null });
    expect(s.state.audits.some((a) => a.action === "SELF_CHECK_RUN_STARTED")).toBe(false);
  });

  it("любой другой сбой старта тоже возвращает запись: иначе посетитель застрял бы в RUNNING без прогона", async () => {
    const s = setup();
    s.startRun.mockRejectedValueOnce(new Error("база недоступна"));
    await expect(startSelfCheckRun(s.check, ctx, s.deps)).rejects.toThrow("база недоступна");
    expect(s.state.selfChecks[0]).toMatchObject({ status: "PERSONA_DECIDED", runStartedAt: null });
  });
});
