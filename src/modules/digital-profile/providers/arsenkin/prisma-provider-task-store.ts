import { prisma } from "@/server/prisma/client";
import { Prisma, type ProviderTask } from "@prisma/client";
import type { ArsenkinTaskState, ProviderTaskRecord } from "./types";
import {
  hashProviderRequest,
  type ProviderTaskStore,
  ARSENKIN_UNPOLLABLE_STATES,
  type ProviderTaskStatePatch,
  type ProviderTaskUpdateOptions,
  type UpsertProviderTaskInput,
} from "./provider-task-store";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function map(row: ProviderTask): ProviderTaskRecord {
  return {
    ...row,
    provider: "arsenkin",
    state: row.state as ProviderTaskRecord["state"],
    requestJson: asRecord(row.requestJson),
    responseJson: row.responseJson ? asRecord(row.responseJson) : null,
  };
}

function patchToData(patch: ProviderTaskStatePatch): Prisma.ProviderTaskUpdateInput {
  return {
    state: patch.state,
    attempts: patch.attempts,
    nextPollAt: patch.nextPollAt === undefined ? undefined : patch.nextPollAt,
    errorCode: patch.errorCode === undefined ? undefined : patch.errorCode,
    limitsSpent: patch.limitsSpent === undefined ? undefined : patch.limitsSpent,
    submittedAt: patch.submittedAt === undefined ? undefined : patch.submittedAt,
    latencyMs: patch.latencyMs === undefined ? undefined : patch.latencyMs,
    limitsBefore: patch.limitsBefore === undefined ? undefined : patch.limitsBefore,
    limitsAfter: patch.limitsAfter === undefined ? undefined : patch.limitsAfter,
    lockedBy: patch.lockedBy === undefined ? undefined : patch.lockedBy,
    lockedAt: patch.lockedAt === undefined ? undefined : patch.lockedAt,
    leaseUntil: patch.leaseUntil === undefined ? undefined : patch.leaseUntil,
    completedAt: patch.completedAt === undefined ? undefined : patch.completedAt,
    externalTaskId: patch.externalTaskId === undefined ? undefined : patch.externalTaskId,
    responseJson:
      patch.responseJson === undefined
        ? undefined
        : patch.responseJson === null
          ? Prisma.JsonNull
          : toJson(patch.responseJson),
  };
}

export function createPrismaProviderTaskStore(): ProviderTaskStore {
  return {
    isPersistent: true,
    async findByRequestHash(reportRunId, requestHash) {
      const row = await prisma.providerTask.findUnique({
        where: { reportRunId_provider_requestHash: { reportRunId, provider: "arsenkin", requestHash } },
      });
      return row ? map(row) : null;
    },
    async findDoneByRequestHashInRuns(reportRunIds, requestHash) {
      const runIds = [...reportRunIds].filter(Boolean);
      if (runIds.length === 0) return null;
      const row = await prisma.providerTask.findFirst({
        where: {
          provider: "arsenkin",
          requestHash,
          reportRunId: { in: runIds },
          state: "DONE",
          NOT: { responseJson: { equals: Prisma.DbNull } },
        },
        orderBy: { completedAt: "desc" },
      });
      return row ? map(row) : null;
    },
    async findById(id) {
      const row = await prisma.providerTask.findUnique({ where: { id } });
      return row ? map(row) : null;
    },
    async upsertPending(input: UpsertProviderTaskInput) {
      if (!input.reportRunId) {
        throw new Error("ProviderTask persistence requires reportRunId");
      }
      const requestHash = input.requestHash ?? hashProviderRequest(input.requestJson);
      const row = await prisma.providerTask.upsert({
        where: {
          reportRunId_provider_requestHash: {
            reportRunId: input.reportRunId,
            provider: "arsenkin",
            requestHash,
          },
        },
        create: {
          caseId: input.caseId ?? null,
          reportRunId: input.reportRunId,
          provider: "arsenkin",
          toolName: input.toolName,
          requestHash,
          state: "QUEUED",
          nextPollAt: new Date(),
          requestJson: toJson(input.requestJson),
        },
        update: {},
      });
      return map(row);
    },
    async claimForSubmission(id, workerId, leaseMs, now = new Date()) {
      const leaseUntil = new Date(now.getTime() + leaseMs);
      const result = await prisma.providerTask.updateMany({
        where: {
          id,
          state: "QUEUED",
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        },
        data: {
          state: "SUBMITTING",
          lockedBy: workerId,
          lockedAt: now,
          leaseUntil,
          errorCode: null,
        },
      });
      if (!result.count) return null;
      return map(await prisma.providerTask.findUniqueOrThrow({ where: { id } }));
    },
    async markExternalId(id, externalTaskId, options) {
      const where: Prisma.ProviderTaskWhereInput = {
        id,
        state: { in: ["SUBMITTING", "RUNNING"] },
      };
      if (options?.ownerId) where.lockedBy = options.ownerId;
      const result = await prisma.providerTask.updateMany({
        where,
        data: { externalTaskId, state: "RUNNING" },
      });
      if (!result.count) {
        throw new Error(`ProviderTask markExternalId rejected: ${id}`);
      }
      return map(await prisma.providerTask.findUniqueOrThrow({ where: { id } }));
    },
    async updateState(id, patch, options?: ProviderTaskUpdateOptions) {
      const where: Prisma.ProviderTaskWhereInput = { id };
      if (options?.ownerId) where.lockedBy = options.ownerId;
      if (options?.expectStates?.length) where.state = { in: options.expectStates };
      const result = await prisma.providerTask.updateMany({
        where,
        data: patchToData(patch) as Prisma.ProviderTaskUpdateManyMutationInput,
      });
      if (!result.count) {
        throw new Error(`ProviderTask updateState rejected: ${id}`);
      }
      return map(await prisma.providerTask.findUniqueOrThrow({ where: { id } }));
    },
    async listDue(now = new Date(), limit = 20) {
      return (
        await prisma.providerTask.findMany({
          where: {
            // Признак — наличие внешнего идентификатора, а не название
            // состояния: см. `isPollableProviderTask`.
            state: { notIn: [...ARSENKIN_UNPOLLABLE_STATES] },
            externalTaskId: { not: null },
            OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }],
          },
          orderBy: { nextPollAt: "asc" },
          take: limit,
        })
      ).map(map);
    },
    async claimDue(workerId, now, limit, leaseMs) {
      const leaseUntil = new Date(now.getTime() + leaseMs);
      return prisma.$transaction(async (tx) => {
        const candidates = await tx.providerTask.findMany({
          where: {
            // Признак — наличие внешнего идентификатора, а не название
            // состояния: см. `isPollableProviderTask`.
            state: { notIn: [...ARSENKIN_UNPOLLABLE_STATES] },
            externalTaskId: { not: null },
            OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }],
            AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }],
          },
          orderBy: { nextPollAt: "asc" },
          take: limit,
        });
        const claimed: ProviderTask[] = [];
        for (const candidate of candidates) {
          const result = await tx.providerTask.updateMany({
            where: {
              id: candidate.id,
              state: { notIn: [...ARSENKIN_UNPOLLABLE_STATES] },
              externalTaskId: { not: null },
              OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
              AND: [{ OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }] }],
            },
            data: { lockedBy: workerId, lockedAt: now, leaseUntil },
          });
          if (result.count) {
            claimed.push(await tx.providerTask.findUniqueOrThrow({ where: { id: candidate.id } }));
          }
        }
        return claimed.map(map);
      });
    },
    async releaseLease(id) {
      return map(
        await prisma.providerTask.update({
          where: { id },
          data: { lockedBy: null, lockedAt: null, leaseUntil: null },
        })
      );
    },
  };
}

/** @internal for typed expectStates helpers */
export type { ArsenkinTaskState };
