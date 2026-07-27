import { randomUUID } from "node:crypto";
import { prisma } from "@/server/prisma/client";

const WINDOW_MS = 60_000;
const DEFAULT_LEASE_MS = 30_000;

export type ArsenkinAccountLease = { release: () => Promise<void>; leaseId: string };

export type ArsenkinAccountLimiterConfig = {
  id: string;
  maxConcurrent: number;
  maxRpm: number;
  leaseMs: number;
  windowMs: number;
};

export function arsenkinAccountLimiterConfig(env: NodeJS.ProcessEnv = process.env): ArsenkinAccountLimiterConfig {
  const httpTimeoutMs = Math.max(1_000, Number(env.ARSENKIN_HTTP_TIMEOUT_MS ?? 25_000) || 25_000);
  const configuredLease = Math.max(5_000, Number(env.ARSENKIN_ACCOUNT_LEASE_MS ?? DEFAULT_LEASE_MS) || DEFAULT_LEASE_MS);
  return {
    id: "arsenkin",
    /*
     * Аккаунт допускает пять задач одновременно; приложение использовало две.
     *
     * Из-за этого восемь поверхностей первой стадии шли четырьмя волнами
     * вместо двух, и прогон ждал вдвое дольше без всякой причины со стороны
     * провайдера. Ставим четыре, а не пять: один слот оставлен про запас —
     * ограничитель общий на аккаунт, и в него упираются и веб, и воркер, так
     * что выбирать предел под ноль значит ловить 429 на стыке.
     */
    maxConcurrent: Math.max(1, Number(env.ARSENKIN_MAX_CONCURRENT ?? 4) || 4),
    // Conservative default below provider soft-cap to avoid minute-boundary bursts.
    maxRpm: Math.max(1, Math.min(30, Number(env.ARSENKIN_REQUESTS_PER_MINUTE ?? 24) || 24)),
    // Lease must outlive per-request HTTP timeout (AbortSignal).
    leaseMs: Math.max(configuredLease, httpTimeoutMs + 5_000),
    windowMs: WINDOW_MS,
  };
}

/** In-memory limiter for offline unit tests (sliding window + lease TTL). */
export function createMemoryArsenkinAccountLimiter(options?: Partial<ArsenkinAccountLimiterConfig>) {
  const settings: ArsenkinAccountLimiterConfig = {
    ...arsenkinAccountLimiterConfig(),
    ...options,
  };
  type Row = { id: string; ownerId: string; createdAt: number; expiresAt: number; releasedAt: number | null };
  const rows: Row[] = [];

  function purge(nowMs: number) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i]!.createdAt < nowMs - settings.windowMs) rows.splice(i, 1);
    }
  }

  return {
    settings,
    async acquire(ownerId = `mem-${randomUUID()}`, now = new Date()): Promise<ArsenkinAccountLease> {
      for (;;) {
        const lease = await this.tryAcquire(ownerId, now);
        if (lease) return lease;
        await new Promise<void>((r) => setTimeout(r, 10));
        now = new Date();
      }
    },
    async tryAcquire(ownerId = `mem-${randomUUID()}`, now = new Date()): Promise<ArsenkinAccountLease | null> {
      const nowMs = now.getTime();
      purge(nowMs);
      const inFlight = rows.filter((r) => r.releasedAt == null && r.expiresAt > nowMs).length;
      const rpm = rows.filter((r) => r.createdAt > nowMs - settings.windowMs).length;
      if (inFlight >= settings.maxConcurrent || rpm >= settings.maxRpm) return null;
      const id = randomUUID();
      rows.push({
        id,
        ownerId,
        createdAt: nowMs,
        expiresAt: nowMs + settings.leaseMs,
        releasedAt: null,
      });
      return {
        leaseId: id,
        async release() {
          const row = rows.find((r) => r.id === id);
          if (row && row.releasedAt == null) {
            row.releasedAt = Date.now();
            row.expiresAt = Math.min(row.expiresAt, row.releasedAt);
          }
        },
      };
    },
    /** Test helper: count active (non-expired, non-released) slots. */
    activeCount(now = new Date()) {
      const nowMs = now.getTime();
      purge(nowMs);
      return rows.filter((r) => r.releasedAt == null && r.expiresAt > nowMs).length;
    },
    /** Test helper: expire all active leases as if the process crashed. */
    expireAll(now = new Date()) {
      const nowMs = now.getTime();
      for (const row of rows) {
        if (row.releasedAt == null) row.expiresAt = nowMs - 1;
      }
    },
    rpmCount(now = new Date()) {
      const nowMs = now.getTime();
      purge(nowMs);
      return rows.filter((r) => r.createdAt > nowMs - settings.windowMs).length;
    },
  };
}

/**
 * Acquire one account-wide Arsenkin request slot.
 * Uses TTL lease rows so a crashed process cannot permanently consume concurrency.
 * RPM uses a sliding 60s window of lease createdAt timestamps (no fixed-minute burst).
 */
export async function acquireArsenkinAccountSlot(options?: {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  ownerId?: string;
  leaseMs?: number;
}): Promise<ArsenkinAccountLease> {
  const nowFn = options?.now ?? (() => new Date());
  const sleep = options?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const settings = arsenkinAccountLimiterConfig();
  const leaseMs = options?.leaseMs ?? settings.leaseMs;
  const ownerId = options?.ownerId ?? `arsenkin-${process.pid}-${randomUUID().slice(0, 8)}`;

  for (;;) {
    const acquired = await prisma.$transaction(async (tx) => {
      const at = nowFn();
      const windowStart = new Date(at.getTime() - settings.windowMs);
      await tx.providerAccountRequestLease.deleteMany({
        where: { limiterId: settings.id, createdAt: { lt: windowStart } },
      });
      await tx.providerAccountLimiter.upsert({
        where: { id: settings.id },
        create: {
          id: settings.id,
          windowStartedAt: at,
          requestCount: 0,
          inFlight: 0,
          maxConcurrent: settings.maxConcurrent,
          maxRpm: settings.maxRpm,
        },
        update: { maxConcurrent: settings.maxConcurrent, maxRpm: settings.maxRpm },
      });
      await tx.$queryRaw`SELECT "id" FROM "dp_provider_account_limiter" WHERE "id" = ${settings.id} FOR UPDATE`;

      const inFlight = await tx.providerAccountRequestLease.count({
        where: {
          limiterId: settings.id,
          releasedAt: null,
          expiresAt: { gt: at },
        },
      });
      const rpm = await tx.providerAccountRequestLease.count({
        where: {
          limiterId: settings.id,
          createdAt: { gt: windowStart },
        },
      });
      if (inFlight >= settings.maxConcurrent || rpm >= settings.maxRpm) return null;

      const lease = await tx.providerAccountRequestLease.create({
        data: {
          limiterId: settings.id,
          ownerId,
          createdAt: at,
          expiresAt: new Date(at.getTime() + leaseMs),
        },
      });
      // Keep legacy counters loosely in sync for observability only.
      await tx.providerAccountLimiter.update({
        where: { id: settings.id },
        data: {
          windowStartedAt: at,
          requestCount: rpm + 1,
          inFlight: inFlight + 1,
        },
      });
      return lease.id;
    });

    if (acquired) {
      return {
        leaseId: acquired,
        async release() {
          const releasedAt = nowFn();
          await prisma.providerAccountRequestLease.updateMany({
            where: { id: acquired, releasedAt: null },
            data: { releasedAt, expiresAt: releasedAt },
          });
          await prisma.providerAccountLimiter.updateMany({
            where: { id: settings.id, inFlight: { gt: 0 } },
            data: { inFlight: { decrement: 1 } },
          });
        },
      };
    }
    await sleep(250);
  }
}
