/**
 * Idempotent ProviderTask store for Arsenkin (memory + Prisma).
 */

import { createHash, randomUUID } from "node:crypto";
import type { ArsenkinTaskState, ProviderTaskRecord } from "./types";

export type UpsertProviderTaskInput = {
  caseId?: string | null;
  /** Required for persisted/live work; null is only supported by the memory test store. */
  reportRunId: string | null;
  toolName: string;
  requestJson: Record<string, unknown>;
  /** Optional precomputed hash; otherwise SHA-256 of requestJson. */
  requestHash?: string;
};

export type ProviderTaskStatePatch = {
  state: ArsenkinTaskState;
  attempts?: number;
  nextPollAt?: Date | null;
  errorCode?: string | null;
  limitsSpent?: number | null;
  submittedAt?: Date | null;
  latencyMs?: number | null;
  limitsBefore?: number | null;
  limitsAfter?: number | null;
  lockedBy?: string | null;
  lockedAt?: Date | null;
  leaseUntil?: Date | null;
  responseJson?: Record<string, unknown> | null;
  completedAt?: Date | null;
  externalTaskId?: string | null;
};

export type ProviderTaskUpdateOptions = {
  /** When set, update only succeeds if lockedBy matches. */
  ownerId?: string;
  /** When set, update only succeeds if current state is one of these. */
  expectStates?: ArsenkinTaskState[];
};

export type ProviderTaskStore = {
  /** True for the database store; fixture stores intentionally avoid account DB state. */
  isPersistent?: boolean;
  findByRequestHash: (reportRunId: string, requestHash: string) => Promise<ProviderTaskRecord | null>;
  /**
   * Готовый ответ на тот же запрос в соседнем прогоне того же сбора.
   *
   * Дедупликация ограничена парой «прогон + хеш», а прогон агента заводится
   * заново при каждом дозапуске. Один и тот же запрос уходил в Arsenkin как
   * новый **платный**: замер на живом прогоне — 6 задач `ai-serp` на 3 хеша,
   * 6 задач `suggest` на 3 хеша, то есть каждый инструмент оплачен дважды.
   *
   * Ищется только `DONE` с сохранённой нагрузкой: незавершённую переиспользовать
   * нельзя — неизвестно, чем она кончится.
   */
  findDoneByRequestHashInRuns?: (
    reportRunIds: readonly string[],
    requestHash: string
  ) => Promise<ProviderTaskRecord | null>;
  findById: (id: string) => Promise<ProviderTaskRecord | null>;
  upsertPending: (input: UpsertProviderTaskInput) => Promise<ProviderTaskRecord>;
  /**
   * Atomic QUEUED -> SUBMITTING claim. Only the winning owner may call /set.
   * Returns null when another worker already owns the submit lease.
   */
  claimForSubmission: (
    id: string,
    workerId: string,
    leaseMs: number,
    now?: Date
  ) => Promise<ProviderTaskRecord | null>;
  markExternalId: (
    id: string,
    externalTaskId: string,
    options?: { ownerId?: string }
  ) => Promise<ProviderTaskRecord>;
  updateState: (
    id: string,
    patch: ProviderTaskStatePatch,
    options?: ProviderTaskUpdateOptions
  ) => Promise<ProviderTaskRecord>;
  listDue: (now?: Date, limit?: number) => Promise<ProviderTaskRecord[]>;
  /** Poll claim: RUNNING/RATE_LIMITED with externalTaskId only. */
  claimDue: (workerId: string, now: Date, limit: number, leaseMs: number) => Promise<ProviderTaskRecord[]>;
  releaseLease: (id: string) => Promise<ProviderTaskRecord>;
};

export function hashProviderRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

/**
 * Состояния, после которых опрашивать нечего.
 *
 * Три первых — исход задачи. `SUBMIT_UNKNOWN` и `SUBMIT_REJECTED_RETRYABLE`
 * исключены намеренно: неопределённый исход отправки разбирается отдельным
 * согласованием, а не слепым опросом.
 */
export const ARSENKIN_UNPOLLABLE_STATES: readonly ArsenkinTaskState[] = [
  "DONE",
  "FAILED",
  "CANCELLED",
  "SUBMIT_UNKNOWN",
  "SUBMIT_REJECTED_RETRYABLE",
];

/**
 * Можно ли опрашивать строку.
 *
 * Признак — данные, а не название состояния: есть внешний идентификатор,
 * значит в Arsenkin есть что спросить. Перечисление разрешённых состояний
 * (`RUNNING`/`RATE_LIMITED`) здесь уже стояло — и оно теряло задачи, которым
 * `/check` однажды ответил «в очереди»: такие записывались как `QUEUED` и
 * выпадали из выборки навсегда. Правило одно на оба хранилища.
 */
export function isPollableProviderTask(
  r: Pick<ProviderTaskRecord, "state" | "externalTaskId" | "nextPollAt">,
  now: Date
): boolean {
  return (
    !ARSENKIN_UNPOLLABLE_STATES.includes(r.state) &&
    r.externalTaskId != null &&
    String(r.externalTaskId).length > 0 &&
    (!r.nextPollAt || r.nextPollAt.getTime() <= now.getTime())
  );
}

const isPollable = isPollableProviderTask;

export function createMemoryProviderTaskStore(): ProviderTaskStore {
  const byId = new Map<string, ProviderTaskRecord>();
  const byHash = new Map<string, string>();

  function get(id: string): ProviderTaskRecord {
    const row = byId.get(id);
    if (!row) throw new Error(`ProviderTask not found: ${id}`);
    return row;
  }
  const scope = (reportRunId: string | null | undefined, requestHash: string) =>
    `${reportRunId ?? "__none__"}|${requestHash}`;

  return {
    isPersistent: false,
    async findByRequestHash(reportRunId, requestHash) {
      const id = byHash.get(scope(reportRunId, requestHash));
      return id ? byId.get(id) ?? null : null;
    },
    async findDoneByRequestHashInRuns(reportRunIds, requestHash) {
      for (const runId of reportRunIds) {
        const id = byHash.get(scope(runId, requestHash));
        const row = id ? byId.get(id) : null;
        if (row && row.state === "DONE" && row.responseJson) return row;
      }
      return null;
    },
    async findById(id) {
      return byId.get(id) ?? null;
    },
    async upsertPending(input) {
      const requestHash = input.requestHash ?? hashProviderRequest(input.requestJson);
      const existingId = byHash.get(scope(input.reportRunId, requestHash));
      if (existingId) {
        return get(existingId);
      }
      const now = new Date();
      const row: ProviderTaskRecord = {
        id: randomUUID(),
        caseId: input.caseId ?? null,
        reportRunId: input.reportRunId ?? null,
        provider: "arsenkin",
        toolName: input.toolName,
        externalTaskId: null,
        requestHash,
        state: "QUEUED",
        attempts: 0,
        nextPollAt: now,
        errorCode: null,
        limitsSpent: null,
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
        submittedAt: null,
        latencyMs: null,
        limitsBefore: null,
        limitsAfter: null,
        requestJson: input.requestJson,
        responseJson: null,
        createdAt: now,
        completedAt: null,
        updatedAt: now,
      };
      byId.set(row.id, row);
      byHash.set(scope(input.reportRunId, requestHash), row.id);
      return row;
    },
    async claimForSubmission(id, workerId, leaseMs, now = new Date()) {
      const prev = get(id);
      const leaseExpired = !prev.leaseUntil || prev.leaseUntil.getTime() <= now.getTime();
      if (prev.state !== "QUEUED" || !leaseExpired) return null;
      const row: ProviderTaskRecord = {
        ...prev,
        state: "SUBMITTING",
        lockedBy: workerId,
        lockedAt: now,
        leaseUntil: new Date(now.getTime() + leaseMs),
        errorCode: null,
        updatedAt: new Date(),
      };
      byId.set(id, row);
      return row;
    },
    async markExternalId(id, externalTaskId, options) {
      const prev = get(id);
      if (options?.ownerId && prev.lockedBy !== options.ownerId) {
        throw new Error(`ProviderTask markExternalId owner mismatch: ${id}`);
      }
      if (prev.state !== "SUBMITTING" && prev.state !== "RUNNING") {
        throw new Error(`ProviderTask markExternalId invalid state ${prev.state}: ${id}`);
      }
      const row = {
        ...prev,
        externalTaskId,
        state: "RUNNING" as const,
        updatedAt: new Date(),
      };
      byId.set(id, row);
      return row;
    },
    async updateState(id, patch, options) {
      const prev = get(id);
      if (options?.ownerId && prev.lockedBy !== options.ownerId) {
        throw new Error(`ProviderTask updateState owner mismatch: ${id}`);
      }
      if (options?.expectStates && !options.expectStates.includes(prev.state)) {
        throw new Error(`ProviderTask updateState unexpected state ${prev.state}: ${id}`);
      }
      const row: ProviderTaskRecord = {
        ...prev,
        state: patch.state,
        attempts: patch.attempts ?? prev.attempts,
        nextPollAt: patch.nextPollAt === undefined ? prev.nextPollAt : patch.nextPollAt,
        errorCode: patch.errorCode === undefined ? prev.errorCode : patch.errorCode,
        limitsSpent: patch.limitsSpent === undefined ? prev.limitsSpent : patch.limitsSpent,
        submittedAt: patch.submittedAt === undefined ? prev.submittedAt : patch.submittedAt,
        latencyMs: patch.latencyMs === undefined ? prev.latencyMs : patch.latencyMs,
        limitsBefore: patch.limitsBefore === undefined ? prev.limitsBefore : patch.limitsBefore,
        limitsAfter: patch.limitsAfter === undefined ? prev.limitsAfter : patch.limitsAfter,
        lockedBy: patch.lockedBy === undefined ? prev.lockedBy : patch.lockedBy,
        lockedAt: patch.lockedAt === undefined ? prev.lockedAt : patch.lockedAt,
        leaseUntil: patch.leaseUntil === undefined ? prev.leaseUntil : patch.leaseUntil,
        responseJson: patch.responseJson === undefined ? prev.responseJson : patch.responseJson,
        completedAt: patch.completedAt === undefined ? prev.completedAt : patch.completedAt,
        externalTaskId:
          patch.externalTaskId === undefined ? prev.externalTaskId : patch.externalTaskId,
        updatedAt: new Date(),
      };
      byId.set(id, row);
      return row;
    },
    async listDue(now = new Date(), limit = 20) {
      return [...byId.values()]
        .filter((r) => isPollable(r, now))
        .sort((a, b) => (a.nextPollAt?.getTime() ?? 0) - (b.nextPollAt?.getTime() ?? 0))
        .slice(0, limit);
    },
    async claimDue(workerId, now, limit, leaseMs) {
      const leaseUntil = new Date(now.getTime() + leaseMs);
      const claimed = [...byId.values()]
        .filter(
          (r) =>
            isPollable(r, now) && (!r.leaseUntil || r.leaseUntil.getTime() <= now.getTime())
        )
        .sort((a, b) => (a.nextPollAt?.getTime() ?? 0) - (b.nextPollAt?.getTime() ?? 0))
        .slice(0, limit)
        .map((r) => ({
          ...r,
          lockedBy: workerId,
          lockedAt: now,
          leaseUntil,
          updatedAt: new Date(),
        }));
      for (const row of claimed) byId.set(row.id, row);
      return claimed;
    },
    async releaseLease(id) {
      const row = { ...get(id), lockedBy: null, lockedAt: null, leaseUntil: null, updatedAt: new Date() };
      byId.set(id, row);
      return row;
    },
  };
}
