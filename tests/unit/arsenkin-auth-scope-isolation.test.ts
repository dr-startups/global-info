import { describe, expect, it } from "vitest";
import {
  assertLiveNetworkAllowed,
  assertLiveSetAllowed,
  buildLiveAuthorizationFromPlan,
  getActiveExistingTaskPollAuthorization,
  getActiveLiveAuthorization,
  getActiveLiveBudget,
  withExistingExternalTaskPollAuthorization,
  withLiveAuthorization,
} from "../../src/modules/digital-profile/providers/arsenkin/live-execution-authorization";
import { hashProviderRequest } from "../../src/modules/digital-profile/providers/arsenkin/provider-task-store";

/**
 * Шаг 03, корень.
 *
 * Авторизация платных вызовов жила в переменных уровня модуля, и это делало
 * процесс однопоточным по отношению к Arsenkin: пока один агент отправлял
 * задачи, durable-поллер другого получал
 * `arsenkin-poll-auth-blocked:live-session-active`. Отказ уходил в бюджет
 * поллинга, и джоба умирала при **полностью успешном** сборе.
 *
 * Здесь проверяется, что область видимости — цепочка вызовов: параллельные
 * цепочки друг друга не видят, а вложенность по-прежнему запрещена.
 */

const BASE = "https://arsenkin.ru/tools/api";

const auth = (reportRunId: string, body: { tools_name: string; data: Record<string, unknown> }) =>
  buildLiveAuthorizationFromPlan({
    reportRunId,
    planDigest: `digest-${reportRunId}`,
    requestHashes: [hashProviderRequest(body)],
    maxNewTasks: 2,
    maxEstimatedLimits: 100,
    stage: "ARSENKIN_ENRICHMENT",
  });

const bodyFor = (query: string) => ({ tools_name: "suggest", data: { queries: [query] } });

const pollInput = (over: Record<string, unknown> = {}) => ({
  caseId: "case-a",
  unifiedJobId: "job-a",
  enrichmentRunId: "run-suggest",
  providerTaskId: "pt-1",
  externalTaskId: "30734796",
  allowedOperations: ["check", "get"] as const,
  maxNewTasks: 0 as const,
  expectedBaseUrl: BASE,
  providerTask: {
    id: "pt-1",
    caseId: "case-a",
    reportRunId: "run-suggest",
    externalTaskId: "30734796",
    submittedAt: "2026-07-26T10:00:00.000Z",
    state: "RUNNING",
  },
  jobEnrichmentRunIds: ["run-suggest", "run-paa"],
  jobCaseId: "case-a",
  jobUnifiedJobId: "job-a",
  ...over,
});

/** Отпускает цикл событий, чтобы цепочки успели перемешаться по-настоящему. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("две цепочки в одном процессе не мешают друг другу", () => {
  it("опрос идёт, пока другой агент отправляет задачи", async () => {
    // Ровно тот прогон, что дважды подряд убивал джобу: сбор успешен, а
    // причина отказа — конкуренция процесса с самим собой.
    let pollSawAuthorization = false;
    let pollError: unknown = null;

    const submitting = withLiveAuthorization(auth("run-check-top", bodyFor("топ")), async () => {
      await tick();
      await tick();
      return "submitted";
    });

    const polling = (async () => {
      await tick();
      try {
        await withExistingExternalTaskPollAuthorization(pollInput(), async () => {
          pollSawAuthorization = Boolean(getActiveExistingTaskPollAuthorization());
          // Внутри опроса чужая live-сессия не видна: иначе она молча
          // отключила бы узкую проверку сетевых вызовов.
          expect(getActiveLiveAuthorization()).toBeNull();
          assertLiveNetworkAllowed("check", { taskId: "30734796", requestUrl: `${BASE}/check` });
        });
      } catch (err) {
        pollError = err;
      }
    })();

    await Promise.all([submitting, polling]);
    expect(pollError).toBeNull();
    expect(pollSawAuthorization).toBe(true);
  });

  it("у каждой цепочки свой бюджет", async () => {
    const bodyA = bodyFor("а");
    const bodyB = bodyFor("б");

    const chain = (runId: string, body: typeof bodyA) =>
      withLiveAuthorization(auth(runId, body), async () => {
        await tick();
        assertLiveSetAllowed({
          reportRunId: runId,
          requestJson: body,
          countsAsNewTask: true,
          estimatedLimits: 10,
        });
        await tick();
        return getActiveLiveBudget();
      });

    const [a, b] = await Promise.all([chain("run-a", bodyA), chain("run-b", bodyB)]);
    // Раньше вторая цепочка получала `live-authorization-already-active`, а если
    // бы прошла — потратила бы чужой бюджет.
    expect(a?.createdNewTasks).toBe(1);
    expect(b?.createdNewTasks).toBe(1);
    expect(a?.estimatedLimitsSpent).toBe(10);
    expect(b?.estimatedLimitsSpent).toBe(10);
  });

  it("чужая live-сессия не открывает сетевые вызовы мимо авторизации", async () => {
    // Дыра процессной переменной: при открытой сессии `assertLiveNetworkAllowed`
    // пропускала check/get **без единой проверки** — из любого кейса и на любой
    // taskId. Здесь вызов идёт из соседней цепочки, а не из вложенной: он
    // авторизации не получал и получить не должен.
    let outsideError: unknown = null;

    const submitting = withLiveAuthorization(auth("run-check-top", bodyFor("топ")), async () => {
      await tick();
      await tick();
    });

    const outsider = (async () => {
      await tick();
      try {
        assertLiveNetworkAllowed("check", { taskId: "999999" });
      } catch (err) {
        outsideError = err;
      }
    })();

    await Promise.all([submitting, outsider]);
    expect(String(outsideError)).toMatch(/no-authorization:check/);
  });
});

describe("вложенность по-прежнему запрещена", () => {
  it("опрос внутри платной сессии блокируется", async () => {
    // Смысл взаимоисключения сохранён: внутри /set-сессии опрос сделал бы
    // бюджеты нечестными.
    await withLiveAuthorization(auth("run-a", bodyFor("а")), async () => {
      await expect(
        withExistingExternalTaskPollAuthorization(pollInput(), async () => "unreachable")
      ).rejects.toThrow(/live-session-active/);
    });
  });

  it("вложенная live-сессия отвергается", async () => {
    await withLiveAuthorization(auth("run-a", bodyFor("а")), async () => {
      await expect(
        withLiveAuthorization(auth("run-b", bodyFor("б")), async () => "unreachable")
      ).rejects.toThrow(/live-authorization-already-active/);
    });
  });

  it("вложенный опрос внутри опроса отвергается", async () => {
    await withExistingExternalTaskPollAuthorization(pollInput(), async () => {
      await expect(
        withExistingExternalTaskPollAuthorization(pollInput(), async () => "unreachable")
      ).rejects.toThrow(/poll-auth-already-active/);
    });
  });
});

describe("fail-closed сохранён", () => {
  it("отпущенная работа авторизации не наследует", async () => {
    // Прежняя реализация обнуляла переменную в `finally`, и работа, не
    // дождавшаяся закрытия сессии, оставалась без прав. Со стором она бы её
    // унаследовала, поэтому сессия помечается закрытой явно.
    let detachedSaw: unknown = "не запускалась";
    let detached!: Promise<void>;
    await withLiveAuthorization(auth("run-a", bodyFor("а")), async () => {
      detached = (async () => {
        await tick();
        await tick();
        detachedSaw = getActiveLiveAuthorization();
      })();
    });
    await detached;
    expect(detachedSaw).toBeNull();
  });

  it("отпущенная работа опроса теряет узкую область", async () => {
    let detached!: Promise<void>;
    let sawScope: unknown = "не запускалась";
    await withExistingExternalTaskPollAuthorization(pollInput(), async () => {
      detached = (async () => {
        await tick();
        await tick();
        sawScope = getActiveExistingTaskPollAuthorization();
      })();
    });
    await detached;
    expect(sawScope).toBeNull();
  });

  it("вне всякой области сетевой вызов запрещён", () => {
    expect(() => assertLiveNetworkAllowed("check", { taskId: "1" })).toThrow(/no-authorization/);
    expect(() => assertLiveNetworkAllowed("set")).toThrow(/no-authorization:set/);
    expect(() =>
      assertLiveSetAllowed({
        reportRunId: "run-a",
        requestJson: bodyFor("а"),
        countsAsNewTask: true,
        estimatedLimits: 1,
      })
    ).toThrow(/no-live-authorization/);
  });

  it("после выхода из сессии бюджета нет", async () => {
    await withLiveAuthorization(auth("run-a", bodyFor("а")), async () => {
      expect(getActiveLiveBudget()).not.toBeNull();
    });
    expect(getActiveLiveBudget()).toBeNull();
  });
});

describe("план чужой авторизацией не пользуется", () => {
  it("вложение с другим reportRunId называется вслух", async () => {
    const { executeArsenkinExecutionPlan } = await import(
      "../../src/modules/digital-profile/providers/arsenkin/execute-arsenkin-execution-plan"
    );
    const body = bodyFor("а");
    const requestHash = hashProviderRequest(body);
    const plan = {
      caseId: "case-a",
      reportRunId: "run-b",
      digest: "digest-run-b",
      maxNewTasks: 1,
      maxEstimatedLimits: 10,
      requests: [
        {
          tool: "suggest",
          engine: "GOOGLE",
          region: "RU",
          query: "а",
          requestHash,
          requestJson: body,
        },
      ],
    };

    await withLiveAuthorization(auth("run-a", body), async () => {
      await expect(
        executeArsenkinExecutionPlan({
          plan: plan as never,
          authorization: auth("run-b", body),
          client: {} as never,
          store: {} as never,
        })
      ).rejects.toThrow(/live-authorization-foreign-run/);
    });
  });
});
