import { prisma } from "@/server/prisma/client";
import { Prisma, type ProviderTask } from "@prisma/client";
import type { ProviderTaskRecord } from "./types";
import {
  hashProviderRequest,
  type ProviderTaskStore,
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

export function createPrismaProviderTaskStore(): ProviderTaskStore {
  return {
    isPersistent: true,
    async findByRequestHash(reportRunId, requestHash) {
      const row = await prisma.providerTask.findUnique({
        where: { reportRunId_provider_requestHash: { reportRunId, provider: "arsenkin", requestHash } },
      });
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
    async markExternalId(id, externalTaskId) {
      return map(
        await prisma.providerTask.update({
          where: { id },
          data: { externalTaskId, state: "RUNNING" },
        })
      );
    },
    async updateState(id, patch) {
      const data: Prisma.ProviderTaskUpdateInput = {
        ...patch,
        responseJson:
          patch.responseJson === undefined
            ? undefined
            : patch.responseJson === null
              ? Prisma.JsonNull
              : toJson(patch.responseJson),
      };
      return map(await prisma.providerTask.update({ where: { id }, data }));
    },
    async listDue(now = new Date(), limit = 20) {
      return (
        await prisma.providerTask.findMany({
          where: {
            state: { in: ["QUEUED", "RUNNING", "RATE_LIMITED"] },
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
            state: { in: ["QUEUED", "RUNNING", "RATE_LIMITED"] },
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
              OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
              AND: [{ OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }] }],
            },
            data: { lockedBy: workerId, lockedAt: now, leaseUntil },
          });
          if (result.count) {
            claimed.push(
              (await tx.providerTask.findUniqueOrThrow({ where: { id: candidate.id } }))
            );
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
