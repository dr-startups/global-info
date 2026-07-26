/**
 * Single-flight Arsenkin DB readiness refresh for server lazy self-healing.
 * NETWORK_CALLS must remain 0 — DB checks only.
 */

import { readFileSync, existsSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import type { ArsenkinDbReadinessArtifact } from "./arsenkin-db-readiness";
import {
  evaluateStoredReadinessArtifact,
  getDefaultReadinessArtifactPath,
  humanizeReadinessCode,
  resolveCurrentReadinessIdentity,
  runArsenkinDbReadiness,
  shouldRunStartupDbReadiness,
  type ArsenkinDbReadinessRunResult,
  type ArsenkinReadinessCode,
} from "./arsenkin-db-readiness-service";

export type EnsureArsenkinDbReadinessResult = {
  running: boolean;
  readinessCode: ArsenkinReadinessCode;
  blockers: string[];
  artifactPath: string;
  networkCalls: number;
  verdict: "PASS" | "FAIL" | "SKIPPED" | null;
};

let inFlight: Promise<ArsenkinDbReadinessRunResult> | null = null;
let lastValidCacheKey: string | null = null;

function readArtifact(path: string): ArsenkinDbReadinessArtifact | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ArsenkinDbReadinessArtifact;
  } catch {
    return null;
  }
}

function outcomeFromRun(
  run: ArsenkinDbReadinessRunResult,
  artifactPath: string
): EnsureArsenkinDbReadinessResult {
  return {
    running: false,
    readinessCode: run.readinessCode,
    blockers: run.blockers,
    artifactPath,
    networkCalls: run.networkCalls,
    verdict: run.verdict,
  };
}

function outcomeFromEvaluation(
  readinessCode: ArsenkinReadinessCode,
  blockers: string[],
  artifactPath: string
): EnsureArsenkinDbReadinessResult {
  return {
    running: false,
    readinessCode,
    blockers,
    artifactPath,
    networkCalls: 0,
    verdict: readinessCode === "READINESS_PASS" ? "PASS" : readinessCode === "READINESS_SKIPPED" ? "SKIPPED" : "FAIL",
  };
}

export function isArsenkinDbReadinessRunning(): boolean {
  return inFlight !== null;
}

export function getLastValidReadinessCacheKey(): string | null {
  return lastValidCacheKey;
}

export function resetArsenkinDbReadinessRunnerForTests(): void {
  inFlight = null;
  lastValidCacheKey = null;
}

/**
 * Ensure DB readiness artifact is valid. Runs refresh at most once concurrently.
 * Valid cached artifact → instant return without DB work.
 */
function runningOutcome(artifactPath: string): EnsureArsenkinDbReadinessResult {
  return {
    running: true,
    readinessCode: "READINESS_RUNNING",
    blockers: ["readiness-running"],
    artifactPath,
    networkCalls: 0,
    verdict: null,
  };
}

export async function ensureArsenkinDbReadiness(input: {
  outPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  prisma?: PrismaClient;
  force?: boolean;
  wait?: boolean;
  /** Test hook — override DB readiness execution. */
  run?: typeof runArsenkinDbReadiness;
} = {}): Promise<EnsureArsenkinDbReadinessResult> {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const artifactPath = input.outPath ?? getDefaultReadinessArtifactPath(cwd);
  const wait = input.wait !== false;

  if (!shouldRunStartupDbReadiness(env)) {
    return {
      running: false,
      readinessCode: "READINESS_NOT_REQUIRED",
      blockers: [],
      artifactPath,
      networkCalls: 0,
      verdict: "SKIPPED",
    };
  }

  const identity = resolveCurrentReadinessIdentity(env, cwd);
  const artifact = readArtifact(artifactPath);

  if (!input.force) {
    const evaluated = evaluateStoredReadinessArtifact({ artifact, env, cwd });
    if (evaluated.ok) {
      lastValidCacheKey = identity.cacheKey;
      return outcomeFromEvaluation("READINESS_PASS", [], artifactPath);
    }
  }

  if (inFlight) {
    if (!wait) return runningOutcome(artifactPath);
    const result = await inFlight;
    return outcomeFromRun(result, artifactPath);
  }

  const promise = (input.run ?? runArsenkinDbReadiness)({
    outPath: artifactPath,
    env,
    cwd,
    prisma: input.prisma,
    resetNetworkGuard: !input.force,
  });
  inFlight = promise;
  promise
    .then((result) => {
      if (result.verdict === "PASS" && result.readinessCode === "READINESS_PASS") {
        lastValidCacheKey = identity.cacheKey;
      }
    })
    .finally(() => {
      if (inFlight === promise) inFlight = null;
    });

  if (!wait) return runningOutcome(artifactPath);

  try {
    return outcomeFromRun(await promise, artifactPath);
  } catch (e) {
    return {
      running: false,
      readinessCode: "READINESS_FAILED",
      blockers: [e instanceof Error ? e.message : String(e)],
      artifactPath,
      networkCalls: 0,
      verdict: "FAIL",
    };
  }
}

/** Force refresh — used by admin «Повторить проверку БД» action. */
export async function refreshArsenkinDbReadiness(input: {
  outPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  prisma?: PrismaClient;
  run?: typeof runArsenkinDbReadiness;
} = {}): Promise<EnsureArsenkinDbReadinessResult> {
  return ensureArsenkinDbReadiness({ ...input, force: true, wait: true });
}

export function syncReadinessBlockers(
  artifactPath: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): { blockers: string[]; readinessCode: ArsenkinReadinessCode } {
  if (!shouldRunStartupDbReadiness(env)) {
    return { blockers: [], readinessCode: "READINESS_NOT_REQUIRED" };
  }
  if (inFlight) {
    return { blockers: ["readiness-running"], readinessCode: "READINESS_RUNNING" };
  }
  const artifact = readArtifact(artifactPath);
  const evaluated = evaluateStoredReadinessArtifact({ artifact, env, cwd });
  return {
    blockers: evaluated.blockers,
    readinessCode: evaluated.readinessCode,
  };
}

export function readinessHumanMessage(
  readinessCode: ArsenkinReadinessCode,
  blockers: string[] = []
): string {
  return humanizeReadinessCode(readinessCode, blockers);
}
