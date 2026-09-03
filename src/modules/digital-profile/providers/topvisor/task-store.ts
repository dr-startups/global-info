/**
 * Строка задачи Topvisor в `dp_provider_tasks` — та же таблица, что у Arsenkin,
 * с `provider: "topvisor"`.
 *
 * Внешняя задача Topvisor — это проверка проекта за дату: `externalTaskId` =
 * `<проект>:<дата>`. В `responseJson` лежат снимки регионов, из которых
 * наблюдения пересобираются на каждом обороте после `DONE` — состояние это
 * данные, а не память тика. Хранилище памяти — для офлайн-контура и тестов.
 */

import type { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

/**
 * `QUEUED` — строка заведена, платный запуск ещё не подтверждён. Строка
 * заводится **до** `checker/go`: если оборот оборвётся между запуском и
 * записью, следующий найдёт строку без внешнего идентификатора и сверится с
 * проектом, а не запустит вторую оплаченную проверку.
 */
export type TopvisorTaskState = "QUEUED" | "RUNNING" | "DONE" | "FAILED";

export type TopvisorTaskRow = {
  id: string;
  caseId: string;
  reportRunId: string;
  toolName: "positions";
  externalTaskId: string | null;
  requestHash: string;
  state: TopvisorTaskState;
  attempts: number;
  nextPollAt: Date | null;
  errorCode: string | null;
  requestJson: Record<string, unknown>;
  responseJson: Record<string, unknown> | null;
  submittedAt: Date | null;
  completedAt: Date | null;
};

export type TopvisorTaskCreate = {
  caseId: string;
  reportRunId: string;
  /** `null` — запуск ещё не подтверждён (строка `QUEUED`). */
  externalTaskId: string | null;
  requestJson: Record<string, unknown>;
  submittedAt: Date;
};

export type TopvisorTaskPatch = Partial<
  Pick<
    TopvisorTaskRow,
    "state" | "attempts" | "nextPollAt" | "errorCode" | "responseJson" | "completedAt" | "externalTaskId"
  >
>;

export type TopvisorTaskStore = {
  findByReportRun: (reportRunId: string) => Promise<TopvisorTaskRow | null>;
  create: (input: TopvisorTaskCreate) => Promise<TopvisorTaskRow>;
  update: (id: string, patch: TopvisorTaskPatch) => Promise<TopvisorTaskRow>;
};

export const TOPVISOR_PROVIDER = "topvisor";

export function hashTopvisorRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

export function createMemoryTopvisorTaskStore(): TopvisorTaskStore {
  const rows = new Map<string, TopvisorTaskRow>();
  return {
    async findByReportRun(reportRunId) {
      return [...rows.values()].find((r) => r.reportRunId === reportRunId) ?? null;
    },
    async create(input) {
      // Одна строка на прогон: повторное заведение обновляет её, как upsert в базе.
      const existing = [...rows.values()].find((r) => r.reportRunId === input.reportRunId);
      if (existing) {
        const next: TopvisorTaskRow = {
          ...existing,
          externalTaskId: input.externalTaskId,
          requestJson: input.requestJson,
          requestHash: hashTopvisorRequest(input.requestJson),
          state: input.externalTaskId ? "RUNNING" : "QUEUED",
          submittedAt: input.submittedAt,
          errorCode: null,
        };
        rows.set(next.id, next);
        return next;
      }
      const row: TopvisorTaskRow = {
        id: `tv-${randomUUID().slice(0, 8)}`,
        caseId: input.caseId,
        reportRunId: input.reportRunId,
        toolName: "positions",
        externalTaskId: input.externalTaskId,
        requestHash: hashTopvisorRequest(input.requestJson),
        state: input.externalTaskId ? "RUNNING" : "QUEUED",
        attempts: 0,
        nextPollAt: null,
        errorCode: null,
        requestJson: input.requestJson,
        responseJson: null,
        submittedAt: input.submittedAt,
        completedAt: null,
      };
      rows.set(row.id, row);
      return row;
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error(`topvisor task ${id} not found`);
      const next = { ...row, ...patch };
      rows.set(id, next);
      return next;
    },
  };
}

type PrismaTaskRow = {
  id: string;
  caseId: string | null;
  reportRunId: string | null;
  externalTaskId: string | null;
  requestHash: string;
  state: string;
  attempts: number;
  nextPollAt: Date | null;
  errorCode: string | null;
  requestJson: unknown;
  responseJson: unknown;
  submittedAt: Date | null;
  completedAt: Date | null;
};

function fromPrisma(row: PrismaTaskRow): TopvisorTaskRow {
  return {
    id: row.id,
    caseId: String(row.caseId ?? ""),
    reportRunId: String(row.reportRunId ?? ""),
    toolName: "positions",
    externalTaskId: row.externalTaskId,
    requestHash: row.requestHash,
    state: (["QUEUED", "RUNNING", "DONE", "FAILED"].includes(row.state) ? row.state : "QUEUED") as TopvisorTaskState,
    attempts: row.attempts,
    nextPollAt: row.nextPollAt,
    errorCode: row.errorCode,
    requestJson: (row.requestJson ?? {}) as Record<string, unknown>,
    responseJson: (row.responseJson ?? null) as Record<string, unknown> | null,
    submittedAt: row.submittedAt,
    completedAt: row.completedAt,
  };
}

function toJson(value: unknown): never {
  return JSON.parse(JSON.stringify(value ?? null)) as never;
}

export function createPrismaTopvisorTaskStore(prisma: PrismaClient): TopvisorTaskStore {
  return {
    async findByReportRun(reportRunId) {
      const row = await prisma.providerTask.findFirst({
        where: { reportRunId, provider: TOPVISOR_PROVIDER, toolName: "positions" },
        orderBy: { createdAt: "desc" },
      });
      return row ? fromPrisma(row as PrismaTaskRow) : null;
    },
    async create(input) {
      // Строка прогона нужна внешнему ключу задачи — как у агентов Arsenkin.
      await prisma.orionReportRun.upsert({
        where: { id: input.reportRunId },
        create: {
          id: input.reportRunId,
          caseId: input.caseId,
          mode: "TOPVISOR_POSITIONS",
          storeMode: "db",
          status: "RUNNING",
          internalOnly: true,
          startedAt: input.submittedAt,
          metadataJson: toJson({ provider: TOPVISOR_PROVIDER, tool: "positions" }),
        },
        update: { status: "RUNNING", finishedAt: null },
      });
      const requestHash = hashTopvisorRequest(input.requestJson);
      const row = await prisma.providerTask.upsert({
        where: {
          reportRunId_provider_requestHash: {
            reportRunId: input.reportRunId,
            provider: TOPVISOR_PROVIDER,
            requestHash,
          },
        },
        create: {
          caseId: input.caseId,
          reportRunId: input.reportRunId,
          provider: TOPVISOR_PROVIDER,
          toolName: "positions",
          externalTaskId: input.externalTaskId,
          requestHash,
          state: input.externalTaskId ? "RUNNING" : "QUEUED",
          submittedAt: input.submittedAt,
          requestJson: toJson(input.requestJson),
        },
        update: {
          externalTaskId: input.externalTaskId,
          state: input.externalTaskId ? "RUNNING" : "QUEUED",
          submittedAt: input.submittedAt,
          errorCode: null,
        },
      });
      return fromPrisma(row as PrismaTaskRow);
    },
    async update(id, patch) {
      const row = await prisma.providerTask.update({
        where: { id },
        data: {
          ...(patch.state ? { state: patch.state } : {}),
          ...(patch.externalTaskId !== undefined ? { externalTaskId: patch.externalTaskId } : {}),
          ...(patch.attempts != null ? { attempts: patch.attempts } : {}),
          ...(patch.nextPollAt !== undefined ? { nextPollAt: patch.nextPollAt } : {}),
          ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
          ...(patch.responseJson !== undefined ? { responseJson: toJson(patch.responseJson) } : {}),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        },
      });
      if (patch.state === "DONE" || patch.state === "FAILED") {
        await prisma.orionReportRun
          .update({
            where: { id: String(row.reportRunId ?? "") },
            data: { status: patch.state === "DONE" ? "SUCCEEDED" : "FAILED", finishedAt: new Date() },
          })
          .catch(() => undefined);
      }
      return fromPrisma(row as PrismaTaskRow);
    },
  };
}
