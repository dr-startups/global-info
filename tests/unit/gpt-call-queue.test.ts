/**
 * Ported from smoke-gpt-call-queue — offline GPT queue retries.
 * NETWORK_CALLS=0 (vitest.config env); all callers are fakes.
 */

import { describe, expect, it } from "vitest";
import {
  classifyOpenAiError,
  OpenAiCallError,
  runGptCallQueue,
} from "../../src/modules/digital-profile/orion-golden/gpt/gpt-call-queue";

describe("gpt-call-queue classifyOpenAiError", () => {
  it("marks 429 / 5xx / timeout as retryable", () => {
    expect(classifyOpenAiError(new OpenAiCallError("openai-429", { retryable: true, status: 429 })).retryable).toBe(
      true
    );
    expect(classifyOpenAiError(new Error("openai-http-503")).retryable).toBe(true);
    expect(classifyOpenAiError(new Error("openai-timeout")).retryable).toBe(true);
    expect(classifyOpenAiError(new Error("openai-invalid-json")).retryable).toBe(false);
  });
});

describe("gpt-call-queue retries", () => {
  it("retries 429 then succeeds → all tasks ok", async () => {
    const attemptsByKey = new Map<string, number>();
    const sleepLog: number[] = [];
    const tasks = ["a", "b", "c"].map((key) => ({
      key,
      run: async () => {
        const n = (attemptsByKey.get(key) ?? 0) + 1;
        attemptsByKey.set(key, n);
        if (key === "c" && n <= 2) {
          throw new OpenAiCallError("openai-429", { retryable: true, status: 429 });
        }
        return { key, n };
      },
    }));

    const results = await runGptCallQueue({
      tasks,
      options: {
        concurrency: 2,
        maxAttempts: 5,
        deadlineMs: 60_000,
        sleep: async (ms) => {
          sleepLog.push(ms);
        },
      },
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(attemptsByKey.get("c")).toBe(3);
    expect(sleepLog.length).toBeGreaterThanOrEqual(2);
    expect(results.map((r) => r.key)).toEqual(["a", "b", "c"]);
  });

  it("deadline before start → FALLBACK_TIMEOUT with 0 attempts", async () => {
    const results = await runGptCallQueue({
      tasks: [{ key: "late", run: async () => "ok" }],
      options: {
        concurrency: 1,
        maxAttempts: 3,
        deadlineMs: 0,
        now: () => 0,
        sleep: async () => undefined,
      },
    });
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) {
      expect(results[0]!.reason).toBe("FALLBACK_TIMEOUT");
      expect(results[0]!.attempts).toBe(0);
    }
  });
});
