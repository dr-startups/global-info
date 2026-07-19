/**
 * REMEDIATION §4.5 — offline acceptance for adaptive max_output_tokens retry.
 * Fake fetch only; NETWORK_CALLS=0.
 *
 * Run: npm run smoke:openai-truncation-retry
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

before(() => {
  process.env.NETWORK_CALLS = "0";
  process.env.DIGITAL_PROFILE_AI_ANALYST_ENABLED = "true";
  process.env.OPENAI_API_KEY = "test-key-not-real";
});

describe("openai-json-client truncation retry (§4.5)", () => {
  it("looksLikeTruncatedOpenAiJson detects incomplete / near-budget / unclosed JSON", async () => {
    const { looksLikeTruncatedOpenAiJson } = await import(
      "../src/modules/digital-profile/orion-golden/gpt/openai-json-client"
    );
    assert.equal(
      looksLikeTruncatedOpenAiJson({
        text: '{"a":1',
        maxOutputTokens: 1000,
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      }),
      true
    );
    assert.equal(
      looksLikeTruncatedOpenAiJson({
        text: "{" + "x".repeat(3000),
        maxOutputTokens: 1000,
      }),
      true
    );
    assert.equal(
      looksLikeTruncatedOpenAiJson({
        text: '{"ok":true}',
        maxOutputTokens: 8000,
        response: { status: "completed", usage: { output_tokens: 120 } },
      }),
      false
    );
  });

  it("invalid truncated JSON → second call with doubled max_output_tokens", async () => {
    // Import after env is set so config sees the key/enabled flags.
    const {
      callOpenAiStrictJsonOnce,
      getLastOpenAiJsonCallDiagnostics,
      consumeOpenAiTruncationRetryCount,
    } = await import("../src/modules/digital-profile/orion-golden/gpt/openai-json-client");

    consumeOpenAiTruncationRetryCount(); // reset
    const budgets: number[] = [];
    let calls = 0;

    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { max_output_tokens?: number };
      const max = Number(body.max_output_tokens ?? 0);
      budgets.push(max);
      if (calls === 1) {
        // Truncated / invalid JSON near budget.
        const text = '{"overallRiskLevel":"высокий","executiveConclusion":"' + "я".repeat(Math.max(50, Math.floor(max * 2)));
        return new Response(
          JSON.stringify({
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { output_tokens: max },
            output: [{ content: [{ type: "output_text", text }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          usage: { output_tokens: 200 },
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    overallRiskLevel: "высокий",
                    executiveConclusion: "Ок после расширения бюджета.",
                    keyRisks: [],
                    positiveSignals: [],
                    recommendations: ["Проверить первоисточники."],
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const parsed = (await callOpenAiStrictJsonOnce({
      systemPrompt: "test",
      userPayload: { x: 1 },
      maxOutputTokens: 1000,
      fetchImpl,
    })) as { executiveConclusion?: string };

    assert.equal(calls, 2);
    assert.deepEqual(budgets, [1000, 2000]);
    assert.ok(parsed.executiveConclusion?.includes("расширения бюджета"));
    const diag = getLastOpenAiJsonCallDiagnostics();
    assert.ok(diag?.truncationRetry);
    assert.equal(diag?.firstMaxOutputTokens, 1000);
    assert.equal(diag?.finalMaxOutputTokens, 2000);
    assert.equal(consumeOpenAiTruncationRetryCount(), 1);
  });

  it("invalid JSON that is not truncated → no retry", async () => {
    const { callOpenAiStrictJsonOnce } = await import(
      "../src/modules/digital-profile/orion-golden/gpt/openai-json-client"
    );
    const { OpenAiCallError } = await import(
      "../src/modules/digital-profile/orion-golden/gpt/gpt-call-queue"
    );

    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          status: "completed",
          usage: { output_tokens: 20 },
          output: [{ content: [{ type: "output_text", text: "not-json-at-all" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    await assert.rejects(
      () =>
        callOpenAiStrictJsonOnce({
          systemPrompt: "test",
          userPayload: {},
          maxOutputTokens: 8000,
          fetchImpl,
        }),
      (err: unknown) =>
        err instanceof OpenAiCallError && err.message === "openai-invalid-json"
    );
    assert.equal(calls, 1);
  });

  it("doubled budget is capped at 32000", async () => {
    const {
      callOpenAiStrictJsonOnce,
      OPENAI_MAX_OUTPUT_TOKENS_CAP,
      getLastOpenAiJsonCallDiagnostics,
      consumeOpenAiTruncationRetryCount,
    } = await import("../src/modules/digital-profile/orion-golden/gpt/openai-json-client");
    consumeOpenAiTruncationRetryCount();

    const budgets: number[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { max_output_tokens?: number };
      budgets.push(Number(body.max_output_tokens ?? 0));
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { output_tokens: 20000 },
            output: [{ content: [{ type: "output_text", text: '{"a":' }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    await callOpenAiStrictJsonOnce({
      systemPrompt: "test",
      userPayload: {},
      maxOutputTokens: 20000,
      fetchImpl,
    });
    assert.deepEqual(budgets, [20000, OPENAI_MAX_OUTPUT_TOKENS_CAP]);
    assert.equal(getLastOpenAiJsonCallDiagnostics()?.finalMaxOutputTokens, 32000);
  });
});
