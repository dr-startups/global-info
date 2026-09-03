/**
 * Долговечный тик позиций Topvisor: запуск → ожидание → приём.
 *
 * Состояние — данные джобы и строка задачи, не память процесса: после `DONE`
 * наблюдения пересобираются из сохранённого снимка на каждом обороте, пока
 * шаг ждёт Arsenkin. Без ключа — отказ с именем переменной, без тихого отката.
 */

import { describe, expect, it } from "vitest";
import {
  runTopvisorPositionsTick,
  topvisorReportRunId,
} from "@/modules/digital-profile/services/topvisor-positions-tick";
import { createMemoryTopvisorTaskStore } from "@/modules/digital-profile/providers/topvisor/task-store";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";
import { createTopvisorFixtureCall, PILOT_KEYWORDS } from "../support/topvisor-fixture-call";

const ENV = { SERP_COLLECTION_PROVIDER: "topvisor", TOPVISOR_API_KEY: "k", TOPVISOR_USER_ID: "100001" };

function job(state: UnifiedCollectionJob["topvisorEnrichmentState"] = null): UnifiedCollectionJob {
  return {
    caseId: "pilot-2026-09-03",
    unifiedJobId: "job-1",
    topvisorEnrichmentState: state,
  } as unknown as UnifiedCollectionJob;
}

describe("тик позиций Topvisor", () => {
  it("первый оборот: проект готов, проверка запущена, задача RUNNING, шаг ждёт", async () => {
    const { call, log } = createTopvisorFixtureCall({ projectExists: false });
    const taskStore = createMemoryTopvisorTaskStore();

    const out = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });

    expect(out.blockPipeline).toBe(false);
    expect(out.waiting).toBe(true);
    expect(out.state.phase).toBe("CHECKING");
    expect(out.state.projectId).toBe(32742967);
    expect(out.state.reportRunId).toBe(topvisorReportRunId("job-1"));
    expect(out.state.externalTaskId).toMatch(/^32742967:\d{4}-\d{2}-\d{2}$/);
    expect(log.filter((e) => e.method === "checker/go")).toHaveLength(1);
    const task = await taskStore.findByReportRun(topvisorReportRunId("job-1"));
    expect(task?.state).toBe("RUNNING");
    expect(task?.externalTaskId).toBe(out.state.externalTaskId);
  });

  it("проверка идёт: ожидание без продвижения; проверка закончена: приём трёх регионов", async () => {
    const { call, log } = createTopvisorFixtureCall({ projectExists: true, checkPollsUntilDone: 1 });
    const taskStore = createMemoryTopvisorTaskStore();

    const first = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });
    const second = await runTopvisorPositionsTick({ job: job(first.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });
    expect(second.waiting).toBe(true);
    expect(second.state.phase).toBe("CHECKING");
    expect(second.state.lastPercent).toBe(0);
    expect(second.advanced).toBe(false);
    expect(log.filter((e) => e.method === "checker/go")).toHaveLength(1);

    const third = await runTopvisorPositionsTick({ job: job(second.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });
    expect(third.waiting).toBe(false);
    expect(third.blockPipeline).toBe(false);
    expect(third.state.phase).toBe("DONE");
    expect(third.advanced).toBe(true);
    const combos = new Set(third.observations.map((o) => `${o.region}/${o.engine}/${o.provider}`));
    expect(combos).toEqual(new Set(["RU/YANDEX/topvisor-yandex", "RU/GOOGLE/topvisor-google", "UAE/GOOGLE/topvisor-google"]));
    expect(third.state.regions.map((r) => r.index)).toEqual([1, 2, 2520]);
    const task = await taskStore.findByReportRun(topvisorReportRunId("job-1"));
    expect(task?.state).toBe("DONE");
    expect(task?.responseJson).toMatchObject({ snapshots: expect.any(Object) });

    // После DONE: сеть не трогается, наблюдения те же — из сохранённого снимка.
    const before = log.length;
    const fourth = await runTopvisorPositionsTick({ job: job(third.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });
    expect(log.length).toBe(before);
    expect(fourth.observations.length).toBe(third.observations.length);
    expect(fourth.waiting).toBe(false);
  });

  it("после проверки читаются и снимки, и AI-ответы: два чтения за прогон", async () => {
    /*
     * Выдача лежит в снимке, AI-ответ — в истории позиций с `show_serp_features`.
     * Одним вызовом не обойтись, и оба чтения обязаны случиться за тот же
     * оборот: иначе AI-ответы «доедут» лишь на следующем, а прогон уже ушёл к
     * слиянию.
     */
    const { call, log } = createTopvisorFixtureCall({ projectExists: true, checkPollsUntilDone: 0 });
    const taskStore = createMemoryTopvisorTaskStore();

    const first = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });
    const done = await runTopvisorPositionsTick({ job: job(first.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });

    expect(done.state.phase).toBe("DONE");
    const positionsReads = log.filter((e) => e.service === "positions_2" && e.method === "history");
    expect(positionsReads).toHaveLength(1);
    expect(positionsReads[0]!.payload).toMatchObject({ show_serp_features: 1 });
    // Индексы регионов — из проекта: Дубай 2520, а не третий по порядку.
    expect(positionsReads[0]!.payload!.regions_indexes).toEqual([1, 2, 2520]);

    const ai = done.observations.filter((o) => o.surface === "ai_answer");
    expect(ai.length).toBeGreaterThan(0);
    expect(new Set(ai.map((o) => o.provider))).toEqual(new Set(["topvisor-yandex", "topvisor-google"]));
    expect(done.state.aiAnswerCount).toBe(ai.filter((o) => !o.url).length);

    // Пересборка после DONE отдаёт те же строки и в сеть не ходит.
    const before = log.length;
    const again = await runTopvisorPositionsTick({ job: job(done.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });
    expect(log.length).toBe(before);
    expect(again.observations.filter((o) => o.surface === "ai_answer").length).toBe(ai.length);
  });

  it("без ключа — отказ с именем переменной, ни одного вызова", async () => {
    const { call, log } = createTopvisorFixtureCall({ projectExists: true });
    const out = await runTopvisorPositionsTick({
      job: job(),
      keywords: PILOT_KEYWORDS,
      call,
      taskStore: createMemoryTopvisorTaskStore(),
      env: { SERP_COLLECTION_PROVIDER: "topvisor", TOPVISOR_API_KEY: "k" },
    });

    expect(out.blockPipeline).toBe(true);
    expect(out.blockCode).toBe("TOPVISOR_NOT_CONFIGURED");
    expect(String(out.blockMessage)).toContain("TOPVISOR_USER_ID");
    expect(log).toHaveLength(0);
  });

  it("отказ запуска проверки — отказ шага, а не «запущено»", async () => {
    const { call } = createTopvisorFixtureCall({ projectExists: true, failCheckerGo: true });
    const taskStore = createMemoryTopvisorTaskStore();
    const out = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });

    expect(out.blockPipeline).toBe(true);
    expect(out.blockCode).toBe("TOPVISOR_CHECK_START_FAILED");
    expect(out.state.phase).toBe("FAILED");
    // Строка заведена до запуска и осталась без внешнего идентификатора: запуска не было.
    const task = await taskStore.findByReportRun(topvisorReportRunId("job-1"));
    expect(task?.state).toBe("QUEUED");
    expect(task?.externalTaskId).toBeNull();
  });

  it("отказ не липкий: после сбоя запуска следующий оборот пробует снова", async () => {
    /*
     * Фаза — слово; где возобновляться, говорят данные: нет строки задачи —
     * значит, проверка не запускалась, и её надо запустить. Липкий FAILED
     * превращал кнопку «Возобновить» в повтор того же отказа навсегда.
     */
    // Дата оборота отличается от даты проверки в фикстуре статуса: сверка с
    // проектом скажет «за эту дату проверки не было», и запуск повторится.
    const now = () => new Date("2026-09-02T10:00:00.000Z");
    const taskStore = createMemoryTopvisorTaskStore();
    const broken = createTopvisorFixtureCall({ projectExists: true, failCheckerGo: true });
    const failed = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call: broken.call, taskStore, env: ENV, now });
    expect(failed.state.phase).toBe("FAILED");

    const healthy = createTopvisorFixtureCall({ projectExists: true });
    const retried = await runTopvisorPositionsTick({ job: job(failed.state), keywords: PILOT_KEYWORDS, call: healthy.call, taskStore, env: ENV, now });
    expect(retried.blockPipeline).toBe(false);
    expect(retried.state.phase).toBe("CHECKING");
    expect(healthy.log.filter((e) => e.method === "checker/go")).toHaveLength(1);
  });

  it("сбой между запуском и записью строки не оплачивается дважды", async () => {
    /*
     * Строка задачи заводится ДО платного запуска. Если оборот оборвался после
     * `checker/go`, следующий находит строку без внешнего идентификатора и
     * спрашивает у проекта, идёт ли проверка за сегодня, — и не запускает
     * вторую.
     */
    const now = () => new Date("2026-09-03T10:00:00.000Z");
    const taskStore = createMemoryTopvisorTaskStore();
    await taskStore.create({
      caseId: "pilot-2026-09-03",
      reportRunId: topvisorReportRunId("job-1"),
      externalTaskId: null,
      requestJson: { projectId: 32742967, checkDate: "2026-09-03" },
      submittedAt: now(),
    });
    const { call, log } = createTopvisorFixtureCall({ projectExists: true, checkPollsUntilDone: 5 });

    const out = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV, now });

    // Проект отвечает: проверка за 2026-09-03 идёт — значит, запуск уже был.
    expect(log.filter((e) => e.method === "checker/go")).toHaveLength(0);
    expect(out.blockPipeline).toBe(false);
    expect(out.state.phase).toBe("CHECKING");
    expect(out.state.externalTaskId).toBe("32742967:2026-09-03");
    const task = await taskStore.findByReportRun(topvisorReportRunId("job-1"));
    expect(task?.externalTaskId).toBe("32742967:2026-09-03");
    expect(task?.state).toBe("RUNNING");
  });

  it("пустой набор запросов — отказ до создания проекта", async () => {
    const { call, log } = createTopvisorFixtureCall({ projectExists: false });
    const out = await runTopvisorPositionsTick({
      job: job(),
      keywords: { ru: [], uae: [] },
      call,
      taskStore: createMemoryTopvisorTaskStore(),
      env: ENV,
    });
    expect(out.blockPipeline).toBe(true);
    expect(out.blockCode).toBe("TOPVISOR_NO_KEYWORDS");
    expect(log).toHaveLength(0);
  });
});
