/**
 * Шаг 12 плана (docs/rework/12-durable-step-execution.md).
 *
 * Хранилище шагов. Оно же — очередь: воркер забирает готовые к исполнению шаги
 * через `FOR UPDATE SKIP LOCKED`. Отдельного брокера нет намеренно. Брокер дал
 * бы вторую правду о том, что делать дальше (сообщение против `nextRunAt`), а
 * состояние всё равно осталось бы здесь — платные отправки требуют
 * exactly-once, которого доставка сообщений не даёт.
 */

import type { PrismaClient } from "@prisma/client";
import { UNIFIED_PIPELINE, applyStepOutcome } from "./step-plan";
import type { StepOutcome, WorkflowStepRow } from "./step-types";

async function getPrisma(): Promise<PrismaClient> {
  const { prisma } = await import("@/server/prisma/client");
  return prisma;
}

function toRow(r: {
  id: string;
  caseId: string;
  jobId: string;
  name: string;
  position: number;
  state: string;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  inputHash: string | null;
  outputRef: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
}): WorkflowStepRow {
  return { ...r, state: r.state as WorkflowStepRow["state"] };
}

const SELECT = {
  id: true,
  caseId: true,
  jobId: true,
  name: true,
  position: true,
  state: true,
  attempts: true,
  maxAttempts: true,
  nextRunAt: true,
  leaseOwner: true,
  leaseUntil: true,
  inputHash: true,
  outputRef: true,
  lastError: true,
  lastErrorCode: true,
  // Начало исполнения: от него отсчитывается право шага ждать (шаг 15).
  startedAt: true,
} as const;

/**
 * Создаёт конвейер для прогона. Идемпотентно: повторный старт того же прогона
 * не плодит вторых шагов и не сбрасывает уже сделанное.
 */
export async function ensurePipelineSteps(input: {
  caseId: string;
  jobId: string;
  now?: Date;
  prisma?: PrismaClient;
}): Promise<WorkflowStepRow[]> {
  const prisma = input.prisma ?? (await getPrisma());
  const now = input.now ?? new Date();
  await prisma.workflowStep.createMany({
    data: UNIFIED_PIPELINE.map((d) => ({
      caseId: input.caseId,
      jobId: input.jobId,
      name: d.name,
      position: d.position,
      maxAttempts: d.maxAttempts ?? 40,
      // Готов к исполнению только первый: конвейер последовательный.
      nextRunAt: d.position === 1 ? now : null,
    })),
    skipDuplicates: true,
  });
  return await listPipelineSteps(input.jobId, prisma);
}

export async function listPipelineSteps(
  jobId: string,
  prismaClient?: PrismaClient
): Promise<WorkflowStepRow[]> {
  const prisma = prismaClient ?? (await getPrisma());
  const rows = await prisma.workflowStep.findMany({
    where: { jobId },
    orderBy: { position: "asc" },
    select: SELECT,
  });
  return rows.map(toRow);
}

/**
 * Забирает один готовый шаг и ставит на него лизу — одной командой, чтобы два
 * процесса не могли выбрать один и тот же.
 *
 * `SKIP LOCKED` пропускает строки, заблокированные другим воркером, вместо
 * ожидания: очередь не выстраивается за первым же занятым шагом.
 *
 * Условие «предыдущие шаги завершены» проверяется здесь же, в SQL — иначе
 * между выбором и захватом оставалось бы окно, в котором конвейер мог уйти
 * вперёд.
 */
export async function claimNextStep(input: {
  ownerId: string;
  leaseMs?: number;
  now?: Date;
  jobId?: string;
  prisma?: PrismaClient;
}): Promise<WorkflowStepRow | null> {
  const prisma = input.prisma ?? (await getPrisma());
  const now = input.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 120_000));

  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    UPDATE "dp_workflow_steps" AS s
       SET "state" = 'RUNNING',
           "leaseOwner" = ${input.ownerId},
           "leaseUntil" = ${leaseUntil},
           "startedAt" = COALESCE(s."startedAt", ${now}),
           "updatedAt" = ${now}
     WHERE s."id" = (
       SELECT c."id"
         FROM "dp_workflow_steps" AS c
        WHERE c."state" IN ('PENDING', 'WAITING', 'RUNNING')
          AND c."nextRunAt" IS NOT NULL
          AND c."nextRunAt" <= ${now}
          AND (c."leaseUntil" IS NULL OR c."leaseUntil" <= ${now})
          AND (${input.jobId ?? null}::text IS NULL OR c."jobId" = ${input.jobId ?? null})
          AND NOT EXISTS (
            SELECT 1
              FROM "dp_workflow_steps" AS p
             WHERE p."jobId" = c."jobId"
               AND p."position" < c."position"
               AND p."state" NOT IN ('DONE', 'SKIPPED')
          )
        ORDER BY c."nextRunAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING s."id", s."caseId", s."jobId", s."name", s."position", s."state",
              s."attempts", s."maxAttempts", s."nextRunAt", s."leaseOwner",
              s."leaseUntil", s."inputHash", s."outputRef", s."lastError",
              s."lastErrorCode"
  `;
  const row = rows[0];
  return row ? toRow(row as Parameters<typeof toRow>[0]) : null;
}

/**
 * Записывает исход исполнения и, при успехе, открывает следующий шаг.
 *
 * Оба действия в одной транзакции: иначе рестарт между ними оставил бы
 * конвейер с завершённым шагом и никем не разбуженным следующим — ровно тот
 * класс потери работы, ради которого всё затевалось.
 */
export async function completeStep(input: {
  step: WorkflowStepRow;
  outcome: StepOutcome;
  now?: Date;
  prisma?: PrismaClient;
}): Promise<void> {
  const prisma = input.prisma ?? (await getPrisma());
  const now = input.now ?? new Date();
  const t = applyStepOutcome(input.step, input.outcome, now);

  await prisma.$transaction(async (tx) => {
    await tx.workflowStep.update({
      where: { id: input.step.id },
      data: {
        state: t.state,
        attempts: t.attempts,
        nextRunAt: t.nextRunAt,
        ...(t.outputRef !== undefined ? { outputRef: t.outputRef } : {}),
        lastError: t.lastError,
        lastErrorCode: t.lastErrorCode,
        leaseOwner: null,
        leaseUntil: null,
        finishedAt: t.finished ? now : null,
      },
    });

    if (t.state !== "DONE" && t.state !== "SKIPPED") return;
    const next = await tx.workflowStep.findFirst({
      where: { jobId: input.step.jobId, position: { gt: input.step.position } },
      orderBy: { position: "asc" },
      select: { id: true, state: true, nextRunAt: true },
    });
    if (!next || next.state !== "PENDING" || next.nextRunAt) return;
    await tx.workflowStep.update({ where: { id: next.id }, data: { nextRunAt: now } });
  });
}

/** Освобождает лизу, не меняя состояния — для аварийного выхода из тика. */
export async function releaseStepLease(stepId: string, ownerId: string, prismaClient?: PrismaClient): Promise<void> {
  const prisma = prismaClient ?? (await getPrisma());
  await prisma.workflowStep.updateMany({
    where: { id: stepId, leaseOwner: ownerId },
    data: { leaseOwner: null, leaseUntil: null },
  });
}

/**
 * Ставит упавший шаг обратно в очередь — путь ручного восстановления.
 * Сбрасывает счётчик попыток: оператор подтвердил, что причина устранена.
 */
/**
 * Возвращает шаги в очередь для пересборки отчёта (шаг 15, E12).
 *
 * Пересборка меняла стадию джобы и выполняла **один** тик в веб-процессе.
 * Шаги при этом оставались `DONE`, воркеру брать было нечего, и джоба зависала
 * в `ORION_PREPARE RUNNING` без лизы и расписания — ровно та потеря работы,
 * ради которой делался шаг 12, оставшаяся в пути пересборки.
 *
 * Сбрасываются только шаги сборки отчёта: платный сбор не повторяется.
 */
export async function requeueStepsForRebuild(input: {
  jobId: string;
  names: readonly string[];
  now?: Date;
  prisma?: PrismaClient;
}): Promise<number> {
  const prisma = input.prisma ?? (await getPrisma());
  const now = input.now ?? new Date();
  const res = await prisma.workflowStep.updateMany({
    where: { jobId: input.jobId, name: { in: [...input.names] } },
    data: {
      state: "PENDING",
      attempts: 0,
      nextRunAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      lastErrorCode: null,
      // Право ждать отсчитывается заново: это новая работа, а не продолжение
      // прежней (шаг 15, D1).
      startedAt: null,
      finishedAt: null,
    },
  });
  return res.count;
}

export async function requeueStep(input: {
  jobId: string;
  name: string;
  now?: Date;
  prisma?: PrismaClient;
}): Promise<boolean> {
  const prisma = input.prisma ?? (await getPrisma());
  const now = input.now ?? new Date();
  const res = await prisma.workflowStep.updateMany({
    where: { jobId: input.jobId, name: input.name, state: "FAILED" },
    data: {
      state: "PENDING",
      attempts: 0,
      nextRunAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      lastErrorCode: null,
      finishedAt: null,
    },
  });
  return res.count > 0;
}
