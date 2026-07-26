/**
 * Capability boundary for paid Arsenkin live calls.
 * Token alone is never sufficient — an installed LiveExecutionAuthorization is required.
 *
 * Separately: durable poll of already-submitted ProviderTasks may install a narrow
 * check/get-only scope via withExistingExternalTaskPollAuthorization (never /set).
 *
 * ---
 *
 * Область видимости — цепочка вызовов, а не процесс (шаг 03, корень).
 *
 * Раньше авторизация жила в переменных уровня модуля, и это делало **весь
 * процесс однопоточным по отношению к Arsenkin**: пока один из пяти агентов
 * отправлял задачи, durable-поллер любого другого получал
 * `arsenkin-poll-auth-blocked:live-session-active`. Отказ уходил в бюджет
 * поллинга, и джоба умирала при полностью успешном сборе — воспроизводимо,
 * дважды подряд.
 *
 * Замысел взаимоисключения («poll не выполняется внутри платной /set-сессии,
 * чтобы бюджеты оставались честными») правилен. Неверна была **область**: она
 * должна покрывать одну цепочку вызовов, а не всё, что происходит в процессе.
 * `AsyncLocalStorage` даёт ровно это, и подписи `with…(auth, fn)` уже написаны
 * в той форме, которая для него и нужна, — ни один вызывающий не меняется.
 *
 * Побочно закрывается дыра, которой процессная переменная и была: при открытой
 * live-сессии `assertLiveNetworkAllowed` пропускала `check`/`get` **без единой
 * проверки**, в том числе из совершенно другого кейса и на произвольный
 * `taskId`. Теперь такой вызов сессии не видит и проходит через узкую
 * poll-проверку или блокируется.
 *
 * Fail-closed сохранён двумя способами: сессия помечается закрытой по выходу из
 * `fn`, поэтому отпущенная (не дождавшаяся) асинхронная работа авторизации уже
 * не видит — как и при обнулении переменной; а отсутствие сессии по-прежнему
 * означает отказ, а не разрешение.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { hashProviderRequest } from "./provider-task-store";

export type LiveExecutionAuthorization = {
  reportRunId: string;
  confirmedPlanDigest: string;
  allowedRequestHashes: ReadonlySet<string>;
  maxNewTasks: number;
  maxEstimatedLimits: number;
  stage: string;
  liveConfirmed: true;
};

export type LiveAuthBudgetState = {
  createdNewTasks: number;
  estimatedLimitsSpent: number;
  countedRequestHashes: string[];
};

/** Narrow read-only poll of one already-paid external Arsenkin task. */
export type ExistingExternalTaskPollAuthorization = {
  caseId: string;
  unifiedJobId: string;
  enrichmentRunId: string;
  providerTaskId: string;
  externalTaskId: string;
  allowedOperations: ReadonlyArray<"check" | "get">;
  maxNewTasks: 0;
  /** Configured Arsenkin API base (no secrets). */
  expectedBaseUrl: string;
};

type ActiveLiveSession = {
  auth: LiveExecutionAuthorization;
  budget: LiveAuthBudgetState;
  countedHashes: Set<string>;
  /** Взводится по выходу из `withLiveAuthorization`: отпущенная работа авторизации не наследует. */
  closed: boolean;
};

type ActivePollScope = {
  auth: ExistingExternalTaskPollAuthorization;
  closed: boolean;
};

const liveSessionStore = new AsyncLocalStorage<ActiveLiveSession>();
const pollScopeStore = new AsyncLocalStorage<ActivePollScope>();

function activeSession(): ActiveLiveSession | null {
  const s = liveSessionStore.getStore();
  return s && !s.closed ? s : null;
}

function activePollScope(): ExistingExternalTaskPollAuthorization | null {
  const s = pollScopeStore.getStore();
  return s && !s.closed ? s.auth : null;
}

export function getActiveLiveAuthorization(): LiveExecutionAuthorization | null {
  return activeSession()?.auth ?? null;
}

export function getActiveExistingTaskPollAuthorization(): ExistingExternalTaskPollAuthorization | null {
  return activePollScope();
}

export function getActiveLiveBudget(): LiveAuthBudgetState | null {
  const active = activeSession();
  if (!active) return null;
  return {
    createdNewTasks: active.budget.createdNewTasks,
    estimatedLimitsSpent: active.budget.estimatedLimitsSpent,
    countedRequestHashes: [...active.budget.countedRequestHashes],
  };
}

/** Install authorization for the duration of fn (sync/async). */
export async function withLiveAuthorization<T>(
  auth: LiveExecutionAuthorization,
  fn: () => Promise<T>
): Promise<T> {
  if (!auth.liveConfirmed) {
    throw new Error("live-authorization-requires-liveConfirmed");
  }
  // Вложение запрещено в пределах цепочки: у вложенной сессии был бы собственный
  // бюджет, и внешний перестал бы что-либо ограничивать. Параллельная цепочка
  // (другой агент, другой кейс) — не вложение и не мешает.
  if (activeSession()) {
    throw new Error("live-authorization-already-active");
  }
  const session: ActiveLiveSession = {
    auth,
    budget: { createdNewTasks: 0, estimatedLimitsSpent: 0, countedRequestHashes: [] },
    countedHashes: new Set(),
    closed: false,
  };
  try {
    return await liveSessionStore.run(session, fn);
  } finally {
    session.closed = true;
  }
}

export function buildLiveAuthorizationFromPlan(input: {
  reportRunId: string;
  planDigest: string;
  requestHashes: readonly string[];
  maxNewTasks: number;
  maxEstimatedLimits: number;
  stage: string;
}): LiveExecutionAuthorization {
  return {
    reportRunId: input.reportRunId,
    confirmedPlanDigest: input.planDigest,
    allowedRequestHashes: new Set(input.requestHashes),
    maxNewTasks: input.maxNewTasks,
    maxEstimatedLimits: input.maxEstimatedLimits,
    stage: input.stage,
    liveConfirmed: true,
  };
}

export function assertLiveSetAllowed(input: {
  reportRunId: string;
  requestJson: { tools_name: string; data: Record<string, unknown> };
  /** When true, this /set creates a new paid submit (not REUSE). */
  countsAsNewTask: boolean;
  estimatedLimits: number | null;
  allowUnknownCost?: boolean;
}): string {
  const active = activeSession();
  if (!active) {
    throw new Error("arsenkin-live-set-blocked:no-live-authorization");
  }
  const { auth, budget } = active;
  if (auth.reportRunId !== input.reportRunId) {
    throw new Error(
      `arsenkin-live-set-blocked:reportRunId-mismatch expected=${auth.reportRunId} got=${input.reportRunId}`
    );
  }
  const requestHash = hashProviderRequest(input.requestJson);
  if (!auth.allowedRequestHashes.has(requestHash)) {
    throw new Error(`arsenkin-live-set-blocked:request-hash-not-in-plan:${requestHash}`);
  }
  const alreadyCounted = active.countedHashes.has(requestHash);
  if (input.countsAsNewTask && !alreadyCounted) {
    if (budget.createdNewTasks + 1 > auth.maxNewTasks) {
      throw new Error(
        `arsenkin-live-set-blocked:max-new-tasks budget=${auth.maxNewTasks} next=${budget.createdNewTasks + 1}`
      );
    }
  }
  if (input.estimatedLimits == null) {
    if (!input.allowUnknownCost) {
      throw new Error("arsenkin-live-set-blocked:unknown-cost");
    }
  } else if (
    !alreadyCounted &&
    budget.estimatedLimitsSpent + input.estimatedLimits > auth.maxEstimatedLimits
  ) {
    throw new Error(
      `arsenkin-live-set-blocked:max-estimated-limits budget=${auth.maxEstimatedLimits} next=${
        budget.estimatedLimitsSpent + input.estimatedLimits
      }`
    );
  }

  if (!alreadyCounted) {
    active.countedHashes.add(requestHash);
    budget.countedRequestHashes.push(requestHash);
    if (input.countsAsNewTask) {
      budget.createdNewTasks += 1;
    }
    if (input.estimatedLimits != null) {
      budget.estimatedLimitsSpent += input.estimatedLimits;
    }
  }
  return requestHash;
}

/**
 * Defense-in-depth for Arsenkin HTTP.
 * - Full live session: any kind.
 * - Existing-task poll scope: only check/get for the authorized externalTaskId.
 * - /set never authorized by poll scope.
 */
export function assertLiveNetworkAllowed(
  kind: string,
  extras?: { taskId?: string | number | null; requestUrl?: string | null }
): void {
  if (activeSession()) return;

  const activePoll = activePollScope();
  if (kind === "check" || kind === "get") {
    if (!activePoll) {
      throw new Error(`arsenkin-live-network-blocked:no-authorization:${kind}`);
    }
    if (!activePoll.allowedOperations.includes(kind)) {
      throw new Error(`arsenkin-poll-auth-blocked:operation-not-allowed:${kind}`);
    }
    if (activePoll.maxNewTasks !== 0) {
      throw new Error("arsenkin-poll-auth-blocked:maxNewTasks-must-be-zero");
    }
    const taskId = String(extras?.taskId ?? "").trim();
    if (!taskId || taskId !== activePoll.externalTaskId) {
      throw new Error(
        `arsenkin-poll-auth-blocked:externalTaskId-mismatch expected=${activePoll.externalTaskId} got=${taskId || "empty"}`
      );
    }
    const url = String(extras?.requestUrl ?? "").trim();
    if (url) {
      const expected = activePoll.expectedBaseUrl.replace(/\/$/, "");
      if (!url.startsWith(expected + "/") && url !== expected) {
        throw new Error("arsenkin-poll-auth-blocked:base-url-mismatch");
      }
      if (url.includes("/set")) {
        throw new Error("arsenkin-poll-auth-blocked:set-not-allowed");
      }
    }
    return;
  }

  throw new Error(`arsenkin-live-network-blocked:no-authorization:${kind}`);
}

export type ExistingExternalTaskPollAuthInput = {
  caseId: string;
  unifiedJobId: string;
  enrichmentRunId: string;
  providerTaskId: string;
  externalTaskId: string;
  allowedOperations: ReadonlyArray<"check" | "get">;
  maxNewTasks: 0;
  expectedBaseUrl: string;
  /** Persisted ProviderTask row used to prove lineage (fail-closed). */
  providerTask: {
    id: string;
    caseId?: string | null;
    reportRunId?: string | null;
    externalTaskId?: string | null;
    submittedAt?: Date | string | null;
    state?: string | null;
  };
  /** Job enrichmentRunIds must include providerTask.reportRunId. */
  jobEnrichmentRunIds: readonly string[];
  jobCaseId: string;
  jobUnifiedJobId: string;
};

/**
 * Validate + install a check/get-only poll scope for one persisted ProviderTask.
 * Never authorizes /set. Foreign / arbitrary externalTaskId → fail-closed.
 */
export function assertExistingExternalTaskPollAuthorized(
  input: ExistingExternalTaskPollAuthInput
): ExistingExternalTaskPollAuthorization {
  const externalTaskId = String(input.externalTaskId ?? "").trim();
  const providerTaskId = String(input.providerTaskId ?? "").trim();
  const enrichmentRunId = String(input.enrichmentRunId ?? "").trim();
  const caseId = String(input.caseId ?? "").trim();
  const unifiedJobId = String(input.unifiedJobId ?? "").trim();

  if (!externalTaskId) {
    throw new Error("arsenkin-poll-auth-blocked:empty-externalTaskId");
  }
  if (!providerTaskId || !enrichmentRunId || !caseId || !unifiedJobId) {
    throw new Error("arsenkin-poll-auth-blocked:missing-lineage");
  }
  if (input.maxNewTasks !== 0) {
    throw new Error("arsenkin-poll-auth-blocked:maxNewTasks-must-be-zero");
  }
  const ops = [...input.allowedOperations];
  if (ops.length === 0 || ops.some((o) => o !== "check" && o !== "get")) {
    throw new Error("arsenkin-poll-auth-blocked:invalid-operations");
  }
  if (ops.includes("set" as never)) {
    throw new Error("arsenkin-poll-auth-blocked:set-not-allowed");
  }

  const row = input.providerTask;
  if (String(row.id ?? "").trim() !== providerTaskId) {
    throw new Error("arsenkin-poll-auth-blocked:providerTaskId-mismatch");
  }
  if (String(row.externalTaskId ?? "").trim() !== externalTaskId) {
    throw new Error("arsenkin-poll-auth-blocked:persisted-externalTaskId-mismatch");
  }
  if (String(row.reportRunId ?? "").trim() !== enrichmentRunId) {
    throw new Error("arsenkin-poll-auth-blocked:enrichmentRunId-mismatch");
  }
  if (caseId !== String(input.jobCaseId ?? "").trim()) {
    throw new Error("arsenkin-poll-auth-blocked:foreign-caseId");
  }
  if (unifiedJobId !== String(input.jobUnifiedJobId ?? "").trim()) {
    throw new Error("arsenkin-poll-auth-blocked:foreign-unifiedJobId");
  }
  if (row.caseId != null && String(row.caseId).trim() && String(row.caseId).trim() !== caseId) {
    throw new Error("arsenkin-poll-auth-blocked:foreign-providerTask-caseId");
  }
  if (!input.jobEnrichmentRunIds.map(String).includes(enrichmentRunId)) {
    throw new Error("arsenkin-poll-auth-blocked:enrichmentRunId-not-on-job");
  }
  if (!row.submittedAt) {
    throw new Error("arsenkin-poll-auth-blocked:not-submitted");
  }
  const expectedBase = String(input.expectedBaseUrl ?? "").trim().replace(/\/$/, "");
  if (!expectedBase || !/^https?:\/\//i.test(expectedBase)) {
    throw new Error("arsenkin-poll-auth-blocked:invalid-base-url");
  }

  return {
    caseId,
    unifiedJobId,
    enrichmentRunId,
    providerTaskId,
    externalTaskId,
    allowedOperations: ops as Array<"check" | "get">,
    maxNewTasks: 0,
    expectedBaseUrl: expectedBase,
  };
}

/** Install existing-task poll authorization for the duration of fn. */
export async function withExistingExternalTaskPollAuthorization<T>(
  input: ExistingExternalTaskPollAuthInput,
  fn: () => Promise<T>
): Promise<T> {
  if (activePollScope()) {
    throw new Error("arsenkin-poll-auth-already-active");
  }
  // Poll scope must not run nested inside a paid live-set session (keeps budgets honest).
  // Проверка про **вложенность**, а не про процесс: параллельная отправка другого
  // агента этой цепочке не родитель и опрашивать не мешает (шаг 03).
  if (activeSession()) {
    throw new Error("arsenkin-poll-auth-blocked:live-session-active");
  }
  const auth = assertExistingExternalTaskPollAuthorized(input);
  const scope: ActivePollScope = { auth, closed: false };
  try {
    return await pollScopeStore.run(scope, fn);
  } finally {
    scope.closed = true;
  }
}

export function digestBindingFingerprint(auth: LiveExecutionAuthorization): string {
  const hashes = [...auth.allowedRequestHashes].sort();
  return createHash("sha256")
    .update(
      JSON.stringify({
        reportRunId: auth.reportRunId,
        confirmedPlanDigest: auth.confirmedPlanDigest,
        hashes,
        maxNewTasks: auth.maxNewTasks,
        maxEstimatedLimits: auth.maxEstimatedLimits,
        stage: auth.stage,
      })
    )
    .digest("hex")
    .slice(0, 32);
}
