/**
 * Lightweight production readiness probe (cached 5–10 min).
 * Not a full destructive arsenkin:db-readiness smoke.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isArsenkinConfigured } from "./flags";
import { resolveBuildIdentity, computeSchemaContentHash } from "./arsenkin-db-readiness";

type PrismaClientLike = {
  $queryRaw: (args: TemplateStringsArray) => Promise<unknown>;
  providerTask: { count: (args?: unknown) => Promise<number> };
  surfaceCollectionCoverage: { count: (args?: unknown) => Promise<number> };
  orionArsenkinStageRun: { count: (args?: unknown) => Promise<number> };
};

export type LightweightReadinessResult = {
  ok: boolean;
  code: "READY" | "WAITING_INFRASTRUCTURE" | "NOT_CONFIGURED" | "SCHEMA_MISMATCH";
  blockers: string[];
  cached: boolean;
  checkedAt: string;
  buildCommit: string;
  schemaFingerprint: string;
};

type CacheFile = {
  ok: boolean;
  code: LightweightReadinessResult["code"];
  blockers: string[];
  checkedAt: string;
  buildCommit: string;
  schemaFingerprint: string;
  expiresAt: string;
};

const CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.ARSENKIN_LIGHT_READINESS_TTL_MS ?? 7 * 60_000) || 7 * 60_000
);

function cachePath(): string {
  return join(
    process.cwd(),
    "storage",
    "digital-profile",
    "arsenkin-orchestration",
    "light-readiness-cache.json"
  );
}

export async function probeArsenkinLightweightReadiness(input?: {
  prisma?: PrismaClientLike;
  now?: Date;
  force?: boolean;
}): Promise<LightweightReadinessResult> {
  const now = input?.now ?? new Date();
  const build = resolveBuildIdentity();
  const schemaFingerprint = createHash("sha256")
    .update(computeSchemaContentHash())
    .digest("hex")
    .slice(0, 16);

  if (!input?.force && existsSync(cachePath())) {
    try {
      const cached = JSON.parse(readFileSync(cachePath(), "utf-8")) as CacheFile;
      if (
        cached.ok &&
        cached.buildCommit === build.buildCommit &&
        cached.schemaFingerprint === schemaFingerprint &&
        new Date(cached.expiresAt).getTime() > now.getTime()
      ) {
        return {
          ok: true,
          code: "READY",
          blockers: [],
          cached: true,
          checkedAt: cached.checkedAt,
          buildCommit: cached.buildCommit,
          schemaFingerprint: cached.schemaFingerprint,
        };
      }
    } catch {
      /* ignore bad cache */
    }
  }

  const blockers: string[] = [];
  if (!isArsenkinConfigured()) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      blockers: ["arsenkin-token-missing"],
      cached: false,
      checkedAt: now.toISOString(),
      buildCommit: build.buildCommit,
      schemaFingerprint,
    };
  }

  try {
    const prisma = (input?.prisma ??
      (await import("@/server/prisma/client")).prisma) as PrismaClientLike;
    await prisma.$queryRaw`SELECT 1`;
    await prisma.providerTask.count({ take: 1 });
    await prisma.surfaceCollectionCoverage.count({ take: 1 });
    await prisma.orionArsenkinStageRun.count({ take: 1 });
  } catch (err) {
    blockers.push(err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      code: "WAITING_INFRASTRUCTURE",
      blockers,
      cached: false,
      checkedAt: now.toISOString(),
      buildCommit: build.buildCommit,
      schemaFingerprint,
    };
  }

  const result: LightweightReadinessResult = {
    ok: true,
    code: "READY",
    blockers: [],
    cached: false,
    checkedAt: now.toISOString(),
    buildCommit: build.buildCommit,
    schemaFingerprint,
  };

  try {
    mkdirSync(dirname(cachePath()), { recursive: true });
    const cache: CacheFile = {
      ok: true,
      code: "READY",
      blockers: [],
      checkedAt: result.checkedAt,
      buildCommit: build.buildCommit,
      schemaFingerprint,
      expiresAt: new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
    };
    writeFileSync(cachePath(), JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    /* cache best-effort */
  }

  return result;
}
