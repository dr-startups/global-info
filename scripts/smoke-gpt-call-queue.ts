/**
 * REMEDIATION §4.2 — offline tests for the GPT call queue.
 * NETWORK_CALLS=0; all callers are fakes.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  classifyOpenAiError,
  OpenAiCallError,
  runGptCallQueue,
} from "../src/modules/digital-profile/orion-golden/gpt/gpt-call-queue";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

describe("gpt-call-queue classifyOpenAiError", () => {
  it("marks 429 / 5xx / timeout as retryable", () => {
    assert.equal(classifyOpenAiError(new OpenAiCallError("openai-429", { retryable: true, status: 429 })).retryable, true);
    assert.equal(classifyOpenAiError(new Error("openai-http-503")).retryable, true);
    assert.equal(classifyOpenAiError(new Error("openai-timeout")).retryable, true);
    assert.equal(classifyOpenAiError(new Error("openai-invalid-json")).retryable, false);
  });
});

describe("gpt-call-queue retries", () => {
  it("3rd call 429 twice then success → all tasks APPLIED", async () => {
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

    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.ok));
    assert.equal(attemptsByKey.get("c"), 3);
    assert.ok(sleepLog.length >= 2);
    assert.deepEqual(
      results.map((r) => r.key),
      ["a", "b", "c"]
    );
  });

  it("persistent 429 → FALLBACK within deadline", async () => {
    let now = 0;
    const results = await runGptCallQueue({
      tasks: [
        {
          key: "x",
          run: async () => {
            throw new OpenAiCallError("openai-429", { retryable: true, status: 429 });
          },
        },
      ],
      options: {
        concurrency: 1,
        maxAttempts: 5,
        deadlineMs: 10_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
    if (!results[0]!.ok) {
      assert.ok(
        results[0]!.reason === "FALLBACK_ERROR" || results[0]!.reason === "FALLBACK_TIMEOUT"
      );
    }
    assert.ok(now <= 10_000);
  });

  it("deadline before start → FALLBACK_TIMEOUT with 0 attempts", async () => {
    const results = await runGptCallQueue({
      tasks: [{ key: "late", run: async () => "ok" }],
      options: {
        concurrency: 1,
        maxAttempts: 3,
        // Elapsed (0) >= deadline (0) → task never starts.
        deadlineMs: 0,
        now: () => 0,
        sleep: async () => undefined,
      },
    });
    assert.equal(results[0]!.ok, false);
    if (!results[0]!.ok) {
      assert.equal(results[0]!.reason, "FALLBACK_TIMEOUT");
      assert.equal(results[0]!.attempts, 0);
    }
  });
});
