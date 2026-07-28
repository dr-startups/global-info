/**
 * Poll worker: set → check → get for Arsenkin ProviderTasks.
 * Exactly-once best-effort submit via claimForSubmission; poll never touches QUEUED
 * or RATE_LIMITED-without-externalTaskId (submit-retry state).
 */

import { randomUUID } from "node:crypto";
import { ArsenkinRequestError, type ArsenkinClient } from "./client";
import { acquireArsenkinAccountSlot } from "./account-rate-limit";
import { withArsenkinSubmitSlot } from "./task-slots";
import { computeLimitsSpent } from "./cost";
import { hashProviderRequest, type ProviderTaskStore } from "./provider-task-store";
import { buildSubmitFailureDiagnostics } from "./submit-failure-diagnostics";
import { classifyArsenkinSubmitFailure } from "./submit-outcome-classification";
import type { ArsenkinSetTaskRequest, ProviderTaskRecord } from "./types";

export type EnsureArsenkinTaskInput = {
  toolName: string;
  data: Record<string, unknown>;
  caseId?: string | null;
  reportRunId: string;
  /** Optional submit worker id for CAS ownership. */
  workerId?: string;
  submitLeaseMs?: number;
  /** Max /set attempts for RATE_LIMITED-without-externalTaskId. Default 5. */
  maxSubmitRetries?: number;
  /**
   * Прогоны того же сбора, ответы которых можно переиспользовать.
   *
   * Дедупликация ограничена парой «прогон + хеш», а прогон агента заводится
   * заново при каждом дозапуске: тот же запрос уходил в Arsenkin как новый
   * **платный**. Замер на живом прогоне: 6 задач `ai-serp` на 3 хеша, 6 задач
   * `suggest` на 3 хеша — каждый инструмент оплачен дважды, и это ровно то, что
   * заказчик увидел в личном кабинете Arsenkin.
   *
   * Пусто (или не задано) — прежнее поведение: сбор действительно новый, и
   * данные должны быть свежими.
   */
  reuseFromRunIds?: readonly string[];
};

export function maxArsenkinSubmitRetries(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Number(env.ARSENKIN_MAX_SUBMIT_RETRIES ?? 5) || 5);
}

/**
 * Сколько раз ждать после `429`.
 *
 * У «слишком много запросов» и у настоящего отказа разная природа, и мерить их
 * одним счётчиком нельзя. Пять быстрых попыток с паузой в пять секунд — это
 * двадцать пять секунд терпения на провайдера, который сам сказал «позже», при
 * том что его же задачи идут по полторы минуты. На боевом прогоне этого хватило,
 * чтобы задача умерла с `submit_retry_exhausted`, хотя не случилось ничего,
 * кроме занятости аккаунта.
 *
 * Ожидание — не попытка: у отказа свой счёт, у ожидания свой.
 */
export function maxArsenkinRateLimitRetries(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Number(env.ARSENKIN_MAX_RATE_LIMIT_RETRIES ?? 20) || 20);
}

/**
 * Пауза после `429`: растёт с числом отказов, но не дольше минуты.
 *
 * Прежние неизменные пять секунд означали, что мы стучимся в занятый аккаунт с
 * той же частотой, с какой он отказывает.
 */
export function rateLimitBackoffMs(attempts: number): number {
  const n = Math.max(0, Number(attempts ?? 0));
  return Math.min(60_000, 5_000 * 2 ** Math.min(n, 4));
}

/** RATE_LIMITED without externalTaskId is a submit-retry state, never a poll state. */
export function isSubmitRetryRateLimited(row: ProviderTaskRecord): boolean {
  return row.state === "RATE_LIMITED" && !row.externalTaskId;
}

/**
 * Когда опрашивать задачу снова.
 *
 * Раньше здесь стояли неизменные две секунды. У аккаунта Arsenkin бюджет — 30
 * запросов в минуту на **все** обращения вместе (`/set`, `/check`, `/get`,
 * `/info`), и мы держим 24. То есть одна задача при опросе раз в две секунды
 * запрашивала больше всего бюджета аккаунта, а инструменты идут минутами:
 * `check-top` — три-шесть. Опросы вытесняли отправки, ограничитель ставил всех
 * в очередь, и прогон выглядел замершим при исправном провайдере.
 *
 * Пауза растёт: первые проверки частые — короткие задачи отвечают быстро, —
 * дальше реже, потому что ждать всё равно минуты.
 */
export function taskPollBackoffMs(attempts: number): number {
  const n = Math.max(0, Number(attempts ?? 0));
  if (n <= 1) return 5_000;
  return Math.min(30_000, 5_000 * 2 ** Math.min(n - 1, 3));
}

async function accountRequest<T>(store: ProviderTaskStore, fn: () => Promise<T>): Promise<T> {
  if (!store.isPersistent) return fn();
  const lease = await acquireArsenkinAccountSlot();
  try {
    return await fn();
  } finally {
    await lease.release();
  }
}

async function availableLimits(client: ArsenkinClient, store: ProviderTaskStore): Promise<number | null> {
  try {
    return (await accountRequest(store, () => client.getLimits())).limitsLeft ?? null;
  } catch {
    return null;
  }
}

function submitFailedState(
  error: unknown,
  attempts: number
): {
  state: ProviderTaskRecord["state"];
  errorCode: string;
  nextPollAt: Date | null;
  completedAt: Date | null;
  attempts: number;
} {
  const classified = classifyArsenkinSubmitFailure(error);
  if (classified.kind === "RATE_LIMITED") {
    return {
      state: "RATE_LIMITED",
      errorCode: classified.errorCode,
      nextPollAt: new Date(Date.now() + rateLimitBackoffMs(attempts)),
      completedAt: null,
      attempts: attempts + 1,
    };
  }
  if (classified.kind === "SUBMIT_REJECTED_RETRYABLE") {
    return {
      state: "SUBMIT_REJECTED_RETRYABLE",
      errorCode: classified.errorCode,
      nextPollAt: null,
      completedAt: new Date(),
      attempts: attempts + 1,
    };
  }
  if (classified.kind === "FAILED") {
    return {
      state: "FAILED",
      errorCode: classified.errorCode,
      nextPollAt: null,
      completedAt: new Date(),
      attempts: attempts + 1,
    };
  }
  // SUBMIT_UNKNOWN_UNRECONCILED — no soft-retry of validation-shaped 5xx.
  return {
    state: "SUBMIT_UNKNOWN",
    errorCode: classified.errorCode,
    nextPollAt: null,
    completedAt: null,
    attempts,
  };
}

/**
 * Ensure a ProviderTask exists and has been submitted at most once per claim.
 * Never calls /set for SUBMITTING or SUBMIT_UNKNOWN.
 * RATE_LIMITED without externalTaskId waits until nextPollAt, then CAS re-submit.
 */
/**
 * Готовый ответ на тот же запрос в соседнем прогоне того же сбора.
 *
 * Возвращает **новую** строку для текущего прогона с скопированной нагрузкой, а
 * не чужую: учёт по прогонам остаётся честным, приём наблюдений привязывается к
 * своему агенту, а платного вызова не происходит. `limitsSpent` — ноль, потому
 * что за эту нагрузку уже заплачено.
 */
async function findReusableArsenkinResult(
  store: ProviderTaskStore,
  input: EnsureArsenkinTaskInput,
  requestHash: string
): Promise<ProviderTaskRecord | null> {
  const siblings = (input.reuseFromRunIds ?? []).filter((r) => r && r !== input.reportRunId);
  if (siblings.length === 0 || !store.findDoneByRequestHashInRuns) return null;

  let done: ProviderTaskRecord | null = null;
  try {
    done = await store.findDoneByRequestHashInRuns(siblings, requestHash);
  } catch {
    // Поиск вспомогательный: его сбой не должен мешать обычной отправке.
    return null;
  }
  if (!done?.responseJson) return null;

  const row = await store.upsertPending({
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    toolName: input.toolName,
    requestJson: { tools_name: input.toolName, data: input.data } as unknown as Record<
      string,
      unknown
    >,
    requestHash,
  });
  // Проходим тот же жизненный цикл, что и обычная задача: строка заводится
  // QUEUED, и внешний идентификатор ей можно проставить только после захвата.
  // Иначе стор справедливо отказывает — состояние не то.
  const claimed = await store.claimForSubmission(row.id, `reuse-${process.pid}`, 60_000);
  if (!claimed) return null;
  if (done.externalTaskId) {
    await store.markExternalId(row.id, done.externalTaskId);
  }
  const adopted = await store.updateState(row.id, {
    state: "DONE",
    responseJson: done.responseJson,
    // Ноль — за эту нагрузку уже заплачено в соседнем прогоне.
    limitsSpent: 0,
    completedAt: new Date(),
    nextPollAt: null,
  });
  console.log(
    JSON.stringify({
      event: "arsenkin_reuse_paid_result",
      toolName: input.toolName,
      requestHash,
      fromReportRunId: done.reportRunId,
      toReportRunId: input.reportRunId,
    })
  );
  return adopted ?? row;
}

export async function ensureArsenkinTask(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  input: EnsureArsenkinTaskInput
): Promise<ProviderTaskRecord> {
  const requestJson: ArsenkinSetTaskRequest = {
    tools_name: input.toolName,
    data: input.data,
  };
  const requestHash = hashProviderRequest(requestJson);
  // Бюджет ожидания после `429`. Переопределение вызывающего
  // (`maxSubmitRetries`) исторически управляло именно им: другие исходы
  // отправки терминальны сразу и счётчика не спрашивают.
  const maxRateLimitWaits = input.maxSubmitRetries ?? maxArsenkinRateLimitRetries();
  let row = await store.findByRequestHash(input.reportRunId, requestHash);
  if (!row) {
    // Тот же запрос уже оплачен и выполнен в соседнем прогоне этого же сбора —
    // берём его нагрузку вместо второго платного вызова.
    const reused = await findReusableArsenkinResult(store, input, requestHash);
    if (reused) return reused;
    row = await store.upsertPending({
      caseId: input.caseId,
      reportRunId: input.reportRunId,
      toolName: input.toolName,
      requestJson: requestJson as unknown as Record<string, unknown>,
      requestHash,
    });
  }
  if (row.state === "DONE" && row.responseJson) return row;
  const now = new Date();
  // Soft-retry only true transient RATE_LIMITED / ambiguous network — never
  // re-POST a deterministic JSON_VALIDATION_ERROR (SUBMIT_REJECTED_RETRYABLE).
  if (row.state === "SUBMIT_REJECTED_RETRYABLE") {
    return row;
  }
  if (row.state === "SUBMIT_UNKNOWN") {
    // Soft-retry disabled for SUBMIT_UNKNOWN: uncertain outcomes must be
    // reconciled manually / via targeted paid retry, not blind /set loops.
    return row;
  }
  if (row.externalTaskId) return row;

  if (row.state === "SUBMITTING") {
    const leaseExpired = !row.leaseUntil || row.leaseUntil.getTime() <= now.getTime();
    if (leaseExpired) {
      return store.updateState(row.id, {
        state: "SUBMIT_UNKNOWN",
        errorCode: "submit_lease_expired",
        nextPollAt: null,
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
      });
    }
    return row;
  }

  if (isSubmitRetryRateLimited(row)) {
    // У ожидания свой счёт: `429` значит «аккаунт занят», а не «запрос
    // негоден». Мерить его тем же бюджетом, что и настоящие отказы, значило
    // хоронить задачу через двадцать пять секунд занятости — что и случилось
    // на боевом прогоне.
    if (row.attempts >= maxRateLimitWaits) {
      return store.updateState(row.id, {
        state: "FAILED",
        errorCode: "submit_rate_limited_too_long",
        nextPollAt: null,
        completedAt: new Date(),
      });
    }
    if (row.nextPollAt && row.nextPollAt.getTime() > now.getTime()) {
      // Honour backoff — never /set before nextPollAt.
      return row;
    }
    // Safe re-queue for CAS submit (no prior externalTaskId).
    row = await store.updateState(row.id, {
      state: "QUEUED",
      nextPollAt: now,
      lockedBy: null,
      lockedAt: null,
      leaseUntil: null,
    });
  }

  if (row.state !== "QUEUED") {
    return row;
  }

  // Постановка задачи — по одной на процесс. Провайдер режет именно
  // одновременные `/set`: четыре разом дали `429` на все четыре и падение
  // стадии с `submit_retry_exhausted`. Выигрыша в параллельной постановке нет —
  // `/set` занимает доли секунды, минуты уходят на ожидание, а оно параллельно.
  return withArsenkinSubmitSlot(() => submitQueuedArsenkinTask(client, store, input, row));
}

async function submitQueuedArsenkinTask(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  input: EnsureArsenkinTaskInput,
  queued: ProviderTaskRecord
): Promise<ProviderTaskRecord> {
  // Время берётся здесь, а не до очереди отправки: аренда на отправку считается
  // от этого момента, и со временем, замеренным до ожидания в очереди, она
  // получилась бы короче на длину ожидания — вплоть до `submit_lease_expired`.
  const now = new Date();
  const requestJson: ArsenkinSetTaskRequest = {
    tools_name: input.toolName,
    data: input.data,
  };
  const requestHash = hashProviderRequest(requestJson);
  let row = queued;
  const workerId = input.workerId ?? `arsenkin-submit-${process.pid}-${randomUUID().slice(0, 8)}`;
  const claimed = await store.claimForSubmission(
    row.id,
    workerId,
    input.submitLeaseMs ?? 60_000,
    now
  );
  if (!claimed) {
    return (await store.findById(row.id)) ?? row;
  }

  const limitsBefore = await availableLimits(client, store);
  try {
    await store.updateState(
      claimed.id,
      { state: "SUBMITTING", limitsBefore, errorCode: null },
      { ownerId: workerId, expectStates: ["SUBMITTING"] }
    );
    const data = requestJson.data ?? {};
    const queries = Array.isArray(data.queries) ? data.queries : [];
    const setStarted = Date.now();
    console.info(
      JSON.stringify({
        event: "arsenkin_set_attempt",
        reportRunId: input.reportRunId,
        providerTaskId: claimed.id,
        requestHash,
        toolName: input.toolName,
        engine: data.se ?? null,
        region: data.region ?? null,
        queryCount: queries.length,
        attempt: claimed.attempts + 1,
      })
    );
    const set = await accountRequest(store, () => client.setTask(requestJson));
    console.info(
      JSON.stringify({
        event: "arsenkin_set_ok",
        reportRunId: input.reportRunId,
        providerTaskId: claimed.id,
        requestHash,
        toolName: input.toolName,
        externalTaskId: String(set.task_id),
        elapsedMs: Date.now() - setStarted,
      })
    );
    row = await store.markExternalId(claimed.id, String(set.task_id), { ownerId: workerId });
    // Confirmed externalTaskId → SUBMITTED, then RUNNING for poll.
    await store.updateState(
      claimed.id,
      {
        state: "SUBMITTED",
        submittedAt: new Date(),
        limitsBefore,
        nextPollAt: new Date(),
        errorCode: null,
      },
      { ownerId: workerId }
    );
    return store.updateState(
      claimed.id,
      {
        state: "RUNNING",
        submittedAt: new Date(),
        limitsBefore,
        nextPollAt: new Date(),
        errorCode: null,
        // Аренда бралась под отправку, и отправка состоялась. Не снять её —
        // значит на весь её срок спрятать задачу от фонового опроса, который
        // выбирает работу как раз по свободным строкам.
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
      },
      { ownerId: workerId }
    );
  } catch (error) {
    const failed = submitFailedState(error, claimed.attempts);
    const diagnostics = buildSubmitFailureDiagnostics(error);
    console.info(
      JSON.stringify({
        event: "arsenkin_set_failed",
        reportRunId: input.reportRunId,
        providerTaskId: claimed.id,
        requestHash,
        toolName: input.toolName,
        attempt: claimed.attempts + 1,
        state: failed.state,
        errorCode: failed.errorCode,
        httpStatus: (diagnostics._submitDiagnostics as { httpStatus?: number | null } | undefined)
          ?.httpStatus,
        responseBody: (diagnostics._submitDiagnostics as { responseBody?: unknown } | undefined)
          ?.responseBody,
      })
    );
    return store.updateState(
      claimed.id,
      {
        state: failed.state,
        errorCode: failed.errorCode,
        nextPollAt: failed.nextPollAt,
        completedAt: failed.completedAt,
        attempts: failed.attempts,
        limitsBefore,
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
        responseJson: diagnostics,
      },
      { ownerId: workerId }
    );
  }
}

export async function pollArsenkinTask(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  row: ProviderTaskRecord
): Promise<ProviderTaskRecord> {
  if (row.nextPollAt && row.nextPollAt.getTime() > Date.now()) return row;
  // Опрашивать можно ровно тогда, когда есть что опрашивать: внешний
  // идентификатор. Раньше решение принималось по названию состояния — и это
  // ломалось об `QUEUED`, у которого два смысла: «мы ещё не отправили» и
  // «Arsenkin поставил в очередь». Признак задан данными и двух смыслов иметь
  // не может.
  if (!row.externalTaskId) {
    if (
      row.state === "QUEUED" ||
      row.state === "SUBMITTING" ||
      row.state === "SUBMIT_UNKNOWN" ||
      row.state === "SUBMIT_REJECTED_RETRYABLE" ||
      isSubmitRetryRateLimited(row)
    ) {
      // Ещё не отправлена — это работа отправки, а не опроса. Никогда не
      // помечать ожидающую повтора RATE_LIMITED как missing_external_task_id.
      return row;
    }
    return store.updateState(row.id, {
      state: "FAILED",
      errorCode: "missing_external_task_id",
      completedAt: new Date(),
    });
  }
  const externalTaskId = row.externalTaskId;
  const check = await accountRequest(store, () => client.checkTask(externalTaskId));
  if (check.state === "RATE_LIMITED") {
    return store.updateState(row.id, {
      state: "RATE_LIMITED",
      attempts: row.attempts + 1,
      nextPollAt: new Date(Date.now() + 5_000),
      errorCode: "429",
    });
  }
  if (check.state === "FAILED" || check.state === "CANCELLED") {
    return store.updateState(row.id, {
      state: check.state,
      attempts: row.attempts + 1,
      errorCode: check.state.toLowerCase(),
      responseJson: check.raw,
      completedAt: new Date(),
    });
  }
  if (check.state !== "DONE") {
    return store.updateState(row.id, {
      state: check.state,
      attempts: row.attempts + 1,
      nextPollAt: new Date(Date.now() + taskPollBackoffMs(row.attempts + 1)),
    });
  }
  const got = await accountRequest(store, () => client.getTask(externalTaskId));
  const completedAt = new Date();
  const limitsAfter = await availableLimits(client, store);
  const limitsSpent = computeLimitsSpent(row.limitsBefore, limitsAfter);
  return store.updateState(row.id, {
    state: "DONE",
    attempts: row.attempts + 1,
    responseJson: got.raw,
    completedAt,
    latencyMs: row.submittedAt ? Math.max(0, completedAt.getTime() - row.submittedAt.getTime()) : null,
    limitsAfter,
    limitsSpent,
    nextPollAt: null,
    errorCode: null,
  });
}

/**
 * Wait until DONE/FAILED/CANCELLED, or terminal SUBMIT_UNKNOWN after soft-retries exhausted.
 * RATE_LIMITED without externalTaskId waits for nextPollAt then re-enters ensure (never poll).
 * Transient /set HTTP 5xx (SUBMIT_UNKNOWN http_5xx, no externalTaskId) is soft-retried via ensure.
 */
export async function waitForArsenkinTaskCompletion(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  input: EnsureArsenkinTaskInput,
  waitTimeoutMs: number
): Promise<ProviderTaskRecord> {
  let row = await ensureArsenkinTask(client, store, input);
  const started = Date.now();
  while (row.state !== "DONE" && row.state !== "FAILED" && row.state !== "CANCELLED") {
    if (Date.now() - started > waitTimeoutMs) {
      // Last-chance /check→/get: Arsenkin often finishes just after our poll window
      // (check-top can take 3–6 min). Avoid false timeout when task is already DONE.
      if (row.externalTaskId) {
        try {
          row = await pollArsenkinTask(client, store, row);
          if (row.state === "DONE") break;
        } catch {
          /* fall through to timeout */
        }
      }
      throw new Error(
        `Arsenkin task timeout tool=${input.toolName} id=${row.externalTaskId} waitedMs=${Date.now() - started}`
      );
    }
    if (row.state === "SUBMIT_UNKNOWN" || row.state === "SUBMIT_REJECTED_RETRYABLE") {
      break;
    }
    // Отправленную задачу двигает опрос, а не повторная отправка. Проверка идёт
    // по внешнему идентификатору: строка, оставшаяся с прежней записью `QUEUED`
    // от ответа провайдера, иначе крутилась бы здесь до самого таймаута.
    if (
      !row.externalTaskId &&
      (row.state === "SUBMITTING" || row.state === "QUEUED" || isSubmitRetryRateLimited(row))
    ) {
      if (isSubmitRetryRateLimited(row) && row.nextPollAt && row.nextPollAt.getTime() > Date.now()) {
        const waitMs = Math.min(1_500, Math.max(50, row.nextPollAt.getTime() - Date.now()));
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        await new Promise((r) => setTimeout(r, 500));
      }
      row = await ensureArsenkinTask(client, store, input);
      continue;
    }
    row = await pollArsenkinTask(client, store, row);
    if (row.state !== "DONE") {
      // Ждём ровно до времени, которое назначил сам опрос: раньше него
      // `pollArsenkinTask` всё равно выйдет, не сделав запроса, а бюджет
      // аккаунта тратить на холостые обороты незачем.
      const dueInMs = row.nextPollAt ? row.nextPollAt.getTime() - Date.now() : 0;
      await new Promise((r) => setTimeout(r, Math.min(30_000, Math.max(500, dueInMs))));
    }
  }
  return row;
}

export async function runDueArsenkinPolls(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  options?: { limit?: number; workerId?: string; leaseMs?: number }
): Promise<ProviderTaskRecord[]> {
  const now = new Date();
  const due = await store.claimDue(
    options?.workerId ?? `arsenkin-poll-${process.pid}`,
    now,
    options?.limit ?? 10,
    options?.leaseMs ?? 30_000
  );
  const out: ProviderTaskRecord[] = [];
  for (const row of due) {
    try {
      out.push(await pollArsenkinTask(client, store, row));
    } finally {
      await store.releaseLease(row.id);
    }
  }
  return out;
}
