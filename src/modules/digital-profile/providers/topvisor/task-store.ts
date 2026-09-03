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

/**
 * Инструменты Topvisor — по строке задачи на каждый: проверка позиций идёт
 * минуты, подбор подсказок — секунды, и оплачиваются они порознь.
 */
export type TopvisorToolName = "positions" | "collect";

export type TopvisorTaskRow = {
  id: string;
  caseId: string;
  reportRunId: string;
  toolName: TopvisorToolName;
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
  toolName: TopvisorToolName;
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
  findByReportRun: (reportRunId: string, toolName?: TopvisorToolName) => Promise<TopvisorTaskRow | null>;
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
    async findByReportRun(reportRunId, toolName = "positions") {
      return (
        [...rows.values()].find((r) => r.reportRunId === reportRunId && r.toolName === toolName) ?? null
      );
    },
    async create(input) {
      // Одна строка на прогон и инструмент: повтор обновляет её, как upsert в базе.
      const existing = [...rows.values()].find(
        (r) => r.reportRunId === input.reportRunId && r.toolName === input.toolName
      );
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
        toolName: input.toolName,
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

function fromPrisma(row: PrismaTaskRow & { toolName?: unknown }): TopvisorTaskRow {
  return {
    id: row.id,
    caseId: String(row.caseId ?? ""),
    reportRunId: String(row.reportRunId ?? ""),
    toolName: row.toolName === "collect" ? "collect" : "positions",
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
    async findByReportRun(reportRunId, toolName = "positions") {
      const row = await prisma.providerTask.findFirst({
        where: { reportRunId, provider: TOPVISOR_PROVIDER, toolName },
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
      /*
       * Одна строка на прогон и инструмент — как в хранилище памяти. Уникальный
       * ключ таблицы — по хешу запроса, а запрос подбора дописывается после
       * каждого платного вызова (в него ложатся идентификаторы групп), и
       * upsert по хешу заводил новую строку на каждое дополнение: живой прогон
       * 03.09.2026 оставил три строки `collect` — QUEUED, RUNNING и DONE — из
       * которых две устаревшие, и диагностика читала их как три задачи.
       */
      const existing = await prisma.providerTask.findFirst({
        where: { reportRunId: input.reportRunId, provider: TOPVISOR_PROVIDER, toolName: input.toolName },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        const updated = await prisma.providerTask.update({
          where: { id: existing.id },
          data: {
            externalTaskId: input.externalTaskId,
            state: input.externalTaskId ? "RUNNING" : "QUEUED",
            submittedAt: input.submittedAt,
            requestHash,
            requestJson: toJson(input.requestJson),
            errorCode: null,
          },
        });
        return fromPrisma(updated as PrismaTaskRow);
      }
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
          toolName: input.toolName,
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
