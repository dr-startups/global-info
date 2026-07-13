/**
 * Idempotent ProviderTask store for Arsenkin (memory + Prisma).
 */

import { createHash, randomUUID } from "node:crypto";
import type { ArsenkinTaskState, ProviderTaskRecord } from "./types";

export type UpsertProviderTaskInput = {
  caseId?: string | null;
  reportRunId?: string | null;
  toolName: string;
  requestJson: Record<string, unknown>;
  /** Optional precomputed hash; otherwise SHA-256 of requestJson. */
  requestHash?: string;
};

export type ProviderTaskStore = {
  findByRequestHash: (requestHash: string) => Promise<ProviderTaskRecord | null>;
  upsertPending: (input: UpsertProviderTaskInput) => Promise<ProviderTaskRecord>;
  markExternalId: (id: string, externalTaskId: string) => Promise<ProviderTaskRecord>;
  updateState: (
    id: string,
    patch: {
      state: ArsenkinTaskState;
      attempts?: number;
      nextPollAt?: Date | null;
      errorCode?: string | null;
      limitsSpent?: number | null;
      responseJson?: Record<string, unknown> | null;
      completedAt?: Date | null;
    }
  ) => Promise<ProviderTaskRecord>;
  listDue: (now?: Date, limit?: number) => Promise<ProviderTaskRecord[]>;
};

export function hashProviderRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

export function createMemoryProviderTaskStore(): ProviderTaskStore {
  const byId = new Map<string, ProviderTaskRecord>();
  const byHash = new Map<string, string>();

  function get(id: string): ProviderTaskRecord {
    const row = byId.get(id);
    if (!row) throw new Error(`ProviderTask not found: ${id}`);
    return row;
  }

  return {
    async findByRequestHash(requestHash) {
      const id = byHash.get(requestHash);
      return id ? byId.get(id) ?? null : null;
    },
    async upsertPending(input) {
      const requestHash = input.requestHash ?? hashProviderRequest(input.requestJson);
      const existingId = byHash.get(requestHash);
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
        requestJson: input.requestJson,
        responseJson: null,
        createdAt: now,
        completedAt: null,
        updatedAt: now,
      };
      byId.set(row.id, row);
      byHash.set(requestHash, row.id);
      return row;
    },
    async markExternalId(id, externalTaskId) {
      const row = { ...get(id), externalTaskId, state: "RUNNING" as const, updatedAt: new Date() };
      byId.set(id, row);
      return row;
    },
    async updateState(id, patch) {
      const prev = get(id);
      const row: ProviderTaskRecord = {
        ...prev,
        state: patch.state,
        attempts: patch.attempts ?? prev.attempts,
        nextPollAt: patch.nextPollAt === undefined ? prev.nextPollAt : patch.nextPollAt,
        errorCode: patch.errorCode === undefined ? prev.errorCode : patch.errorCode,
        limitsSpent: patch.limitsSpent === undefined ? prev.limitsSpent : patch.limitsSpent,
        responseJson: patch.responseJson === undefined ? prev.responseJson : patch.responseJson,
        completedAt: patch.completedAt === undefined ? prev.completedAt : patch.completedAt,
        updatedAt: new Date(),
      };
      byId.set(id, row);
      return row;
    },
    async listDue(now = new Date(), limit = 20) {
      return [...byId.values()]
        .filter(
          (r) =>
            (r.state === "QUEUED" || r.state === "RUNNING" || r.state === "RATE_LIMITED") &&
            (!r.nextPollAt || r.nextPollAt.getTime() <= now.getTime())
        )
        .sort((a, b) => (a.nextPollAt?.getTime() ?? 0) - (b.nextPollAt?.getTime() ?? 0))
        .slice(0, limit);
    },
  };
}
