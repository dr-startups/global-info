import { prisma } from "@/server/prisma/client";

const WINDOW_MS = 60_000;

export type ArsenkinAccountLease = { release: () => Promise<void> };

function config(env: NodeJS.ProcessEnv = process.env) {
  return {
    id: "arsenkin",
    maxConcurrent: Math.max(1, Number(env.ARSENKIN_MAX_CONCURRENT ?? 2) || 2),
    maxRpm: Math.max(1, Math.min(30, Number(env.ARSENKIN_REQUESTS_PER_MINUTE ?? 30) || 30)),
  };
}

/**
 * Acquire one account-wide Arsenkin request slot. Row-level locking makes the
 * concurrency and rolling minute budget shared by all application processes.
 */
export async function acquireArsenkinAccountSlot(options?: {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ArsenkinAccountLease> {
  const now = options?.now ?? (() => new Date());
  const sleep = options?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const settings = config();

  for (;;) {
    const acquired = await prisma.$transaction(async (tx) => {
      const at = now();
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
      const row = await tx.providerAccountLimiter.findUniqueOrThrow({ where: { id: settings.id } });
      const windowExpired = at.getTime() - row.windowStartedAt.getTime() >= WINDOW_MS;
      const requestCount = windowExpired ? 0 : row.requestCount;
      if (row.inFlight >= settings.maxConcurrent || requestCount >= settings.maxRpm) return false;
      await tx.providerAccountLimiter.update({
        where: { id: settings.id },
        data: {
          windowStartedAt: windowExpired ? at : row.windowStartedAt,
          requestCount: requestCount + 1,
          inFlight: row.inFlight + 1,
        },
      });
      return true;
    });
    if (acquired) {
      return {
        async release() {
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
