import { describe, expect, it } from "vitest";
import { LIGHT_RUN_VISITOR_WAIT_MS, lightRunState } from "@/modules/self-check/light-run";
import { publicSelfCheckStatus } from "@/modules/self-check/public-dto";
import { getSelfCheckStatus } from "@/modules/self-check/service";
import { stepMaxWaitMs } from "@/modules/digital-profile/workflow/step-plan";
import { TEST_NOW, fakeDb, selfCheckRow } from "../support/self-check-fakes";

/**
 * Посетитель видит стадию словами, а не диагностику конвейера.
 *
 * Стадий две (решение владельца 15.09.2026): базовый сбор и вердикт. Третьей
 * данные джобы не различают — базовый сбор идёт одним тиком. Отказ прогона
 * посетитель узнаёт при чтении статуса: запись становится `FAILED`, и форма
 * «оставьте контакты» открывается. Предел ожидания — одно число из реестра
 * шагов, а не второй предел рядом.
 */

const STARTED = new Date(TEST_NOW.getTime() - 60_000);

function job(stage: string, over: Record<string, unknown> = {}) {
  return {
    unifiedJobId: "unified-1",
    stage,
    status: "RUNNING",
    progress: 0,
    mode: "light",
    cancelRequested: false,
    ...over,
  };
}

function step(state: string, over: Record<string, unknown> = {}) {
  return { state, nextRunAt: null, attempts: 0, maxAttempts: 3, ...over };
}

function state(jobRow: ReturnType<typeof job> | null, over: Record<string, unknown> = {}) {
  return lightRunState({
    runStartedAt: STARTED,
    jobId: "unified-1",
    job: jobRow as never,
    steps: [],
    now: TEST_NOW,
    ...over,
  } as never);
}

describe("стадия прогона по данным джобы", () => {
  it("базовый сбор — collecting", () => {
    expect(state(job("BASE_COLLECTION"))).toMatchObject({ kind: "running", stage: "collecting" });
  });

  it.each(["LIGHT_VERDICT", "LIGHT_READY"])("%s — verdict", (stage) => {
    expect(state(job(stage))).toMatchObject({ kind: "running", stage: "verdict" });
  });

  it("джобу ещё не видно — collecting", () => {
    expect(state(null)).toMatchObject({ kind: "running", stage: "collecting" });
  });

  it.each(["FAILED_TERMINAL", "CANCELLED"])("%s — прогон не удался", (stage) => {
    expect(state(job(stage))).toEqual({ kind: "failed", reason: "RUN_FAILED" });
  });

  it("повторяемый отказ с назначенным повтором — работа продолжается", () => {
    const retry = step("FAILED", { nextRunAt: new Date(TEST_NOW.getTime() + 10_000), attempts: 1 });
    expect(state(job("FAILED_RETRYABLE"), { steps: [retry] })).toMatchObject({ kind: "running" });
  });

  it("шаг, который больше не проснётся, — прогон не удался", () => {
    expect(state(job("FAILED_RETRYABLE"), { steps: [step("FAILED", { attempts: 3 })] })).toEqual({
      kind: "failed",
      reason: "RUN_FAILED",
    });
  });

  it("джоба дела заменена другим прогоном — этот прогон не закончится", () => {
    expect(state(job("BASE_COLLECTION", { unifiedJobId: "unified-2" }))).toEqual({
      kind: "failed",
      reason: "RUN_FAILED",
    });
  });

  it("предел ожидания — шаг базового сбора, и превышение — RUN_TIMEOUT", () => {
    expect(LIGHT_RUN_VISITOR_WAIT_MS).toBe(stepMaxWaitMs("BASE_COLLECTION"));
    const edge = new Date(TEST_NOW.getTime() - LIGHT_RUN_VISITOR_WAIT_MS);
    const past = new Date(TEST_NOW.getTime() - LIGHT_RUN_VISITOR_WAIT_MS - 1);
    expect(state(job("BASE_COLLECTION"), { runStartedAt: edge })).toMatchObject({ kind: "running" });
    expect(state(job("BASE_COLLECTION"), { runStartedAt: past })).toEqual({
      kind: "failed",
      reason: "RUN_TIMEOUT",
    });
  });
});

describe("проекция идущего прогона", () => {
  const running = selfCheckRow({ status: "RUNNING", runStartedAt: STARTED, jobId: "unified-1" });

  it("стадия словами, прогресс, срок опроса и время запуска", () => {
    const out = publicSelfCheckStatus(running, null, { kind: "running", stage: "collecting", progress: 0 });
    expect(out.run).toEqual({
      stage: "collecting",
      stageLabel: "Поиск упоминаний и сверка с открытыми источниками и санкционными списками",
      progress: 0,
      nextPollMs: 7000,
      startedAt: STARTED,
    });
    expect(out.result).toBeNull();
  });

  it("вердикт — своя подпись", () => {
    const out = publicSelfCheckStatus(running, null, { kind: "running", stage: "verdict", progress: 0.5 });
    expect(out.run).toMatchObject({ stage: "verdict", stageLabel: "AI-анализ размечает находки и формирует результат" });
  });

  it("срок опроса — настройка, но не чаще раза в пять секунд", () => {
    const view = { kind: "running" as const, stage: "collecting" as const, progress: 0 };
    const fast = publicSelfCheckStatus(running, null, view, { SELF_CHECK_POLL_INTERVAL_MS: "2000" });
    const slow = publicSelfCheckStatus(running, null, view, { SELF_CHECK_POLL_INTERVAL_MS: "9000" });
    expect(fast.run?.nextPollMs).toBe(5000);
    expect(slow.run?.nextPollMs).toBe(9000);
  });

  it("ни идентификатора джобы, ни стадий конвейера", () => {
    const text = JSON.stringify(
      publicSelfCheckStatus(running, null, { kind: "running", stage: "verdict", progress: 0.5 })
    );
    for (const internal of ["unified-1", "BASE_COLLECTION", "LIGHT_VERDICT", "LIGHT_READY"]) {
      expect(text).not.toContain(internal);
    }
  });
});

describe("проекция результата", () => {
  const verdictAt = new Date("2026-09-14T11:05:00Z");
  const done = selfCheckRow({
    status: "DONE",
    verdict: "NEGATIVE_FOUND",
    riskLevel: "critical",
    materialsFound: 2,
    findingsTotal: 2,
    themesJson: [
      { id: "criminal_legal", label: "Суд и криминал", count: 2, level: "critical" },
      { id: "financial_claims", label: "Финансовые претензии и долги", count: 1, level: "medium" },
    ],
    partial: true,
    sourcesJson: ["search", "open_sources"],
    verdictAt,
  } as never);

  it("уровни печатаются тремя ступенями шкалы отчёта", () => {
    expect(publicSelfCheckStatus(done, null).result).toEqual({
      verdict: "NEGATIVE_FOUND",
      riskLevel: "high",
      materialsFound: 2,
      findingsTotal: 2,
      themes: [
        { id: "criminal_legal", label: "Суд и криминал", count: 2, level: "high" },
        { id: "financial_claims", label: "Финансовые претензии и долги", count: 1, level: "medium" },
      ],
      partial: true,
      sourcesChecked: ["search", "open_sources"],
      checkedAt: verdictAt,
    });
    expect(publicSelfCheckStatus(done, null).run).toBeNull();
  });

  it("чисто — низкий; данных недостаточно — уровня нет", () => {
    const clean = selfCheckRow({ ...done, verdict: "CLEAN", riskLevel: "low", themesJson: [] } as never);
    const empty = selfCheckRow({ ...done, verdict: "INSUFFICIENT_DATA", riskLevel: null, themesJson: [] } as never);
    expect(publicSelfCheckStatus(clean, null).result?.riskLevel).toBe("low");
    expect(publicSelfCheckStatus(empty, null).result?.riskLevel).toBeNull();
  });

  it("превышение ожидания — тот же честный текст отказа, что у упавшего прогона", () => {
    const timedOut = selfCheckRow({ status: "FAILED", blockedReason: "RUN_TIMEOUT" });
    expect(publicSelfCheckStatus(timedOut, null).blocked).toEqual({
      reason: "RUN_TIMEOUT",
      message: "Не удалось завершить проверку. Оставьте контакты — проверим вручную.",
    });
  });
});

describe("чтение статуса сверяет запись с прогоном", () => {
  function deps(db: unknown, jobRow: ReturnType<typeof job> | null, steps: unknown[] = []) {
    return {
      db: db as never,
      now: () => TEST_NOW,
      env: {} as NodeJS.ProcessEnv,
      loadJob: async () => jobRow as never,
      listSteps: async () => steps as never,
    };
  }

  it("прогон упал — запись становится FAILED, посетитель видит отказ", async () => {
    const check = selfCheckRow({ status: "RUNNING", runStartedAt: STARTED, jobId: "unified-1" });
    const { db, state: rows } = fakeDb({ selfChecks: [check] });
    const out = await getSelfCheckStatus(check, deps(db, job("FAILED_TERMINAL")));
    expect(out.status).toBe("FAILED");
    expect(out.blocked?.reason).toBe("RUN_FAILED");
    expect(rows.selfChecks[0]).toMatchObject({ status: "FAILED", blockedReason: "RUN_FAILED", runFinishedAt: TEST_NOW });
  });

  it("идущий прогон запись не трогает", async () => {
    const check = selfCheckRow({ status: "RUNNING", runStartedAt: STARTED, jobId: "unified-1" });
    const { db, state: rows } = fakeDb({ selfChecks: [check] });
    const out = await getSelfCheckStatus(check, deps(db, job("BASE_COLLECTION")));
    expect(out.status).toBe("RUNNING");
    expect(out.run?.stage).toBe("collecting");
    expect(rows.selfChecks[0]!.status).toBe("RUNNING");
  });

  it("дольше предела — FAILED с причиной RUN_TIMEOUT", async () => {
    const long = new Date(TEST_NOW.getTime() - LIGHT_RUN_VISITOR_WAIT_MS - 1);
    const check = selfCheckRow({ status: "RUNNING", runStartedAt: long, jobId: "unified-1" });
    const { db, state: rows } = fakeDb({ selfChecks: [check] });
    const out = await getSelfCheckStatus(check, deps(db, job("BASE_COLLECTION")));
    expect(out.blocked?.reason).toBe("RUN_TIMEOUT");
    expect(rows.selfChecks[0]!.blockedReason).toBe("RUN_TIMEOUT");
  });
});
