/**
 * Contract smoke for Arsenkin client (fixtures only — no live limits spent).
 *
 *   npm run smoke:arsenkin-client
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  ArsenkinClient,
  createMemoryProviderTaskStore,
  ensureArsenkinTask,
  pollArsenkinTask,
  isArsenkinEnabled,
  arsenkinTools,
  redactSecrets,
  hashProviderRequest,
} from "../src/modules/digital-profile/providers/arsenkin";

const FIX = join(
  process.cwd(),
  "src/modules/digital-profile/providers/arsenkin/fixtures"
);

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIX, name), "utf-8")) as Record<string, unknown>;
}

async function main() {
  assert.equal(isArsenkinEnabled({}), false);
  assert.equal(isArsenkinEnabled({ ARSENKIN_ENABLED: "1" }), true);
  assert.deepEqual(arsenkinTools({ ARSENKIN_TOOLS: "check-top,paa" }), ["check-top", "paa"]);

  const setOk = load("set-task-ok.json");
  const checkPending = load("check-pending.json");
  const checkDone = load("check-done.json");
  const getTop = load("get-check-top.json");
  const limits = load("limits.json");

  let calls = 0;
  let checkCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    const url = String(input);
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    assert.match(auth, /^Bearer\s+/);
    assert.doesNotMatch(JSON.stringify(init?.body ?? ""), /super-secret-token/);
    if (url.endsWith("/set")) {
      return new Response(JSON.stringify(setOk), { status: 200 });
    }
    if (url.endsWith("/check")) {
      checkCalls += 1;
      return new Response(JSON.stringify(checkCalls < 2 ? checkPending : checkDone), { status: 200 });
    }
    if (url.endsWith("/get")) {
      return new Response(JSON.stringify(getTop), { status: 200 });
    }
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify(limits), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  };

  const client = new ArsenkinClient({
    token: "super-secret-token-do-not-log",
    fetchImpl,
    requestsPerMinute: 30,
    sleep: async () => undefined,
  });

  const lim = await client.getLimits();
  assert.equal(lim.limitsTotal, 85000);
  assert.equal(lim.limitsLeft, 84880);

  const store = createMemoryProviderTaskStore();
  const pending = await ensureArsenkinTask(client, store, {
    toolName: "check-top",
    data: { queries: ["Глинка Сергей Михайлович"], depth: 10, is_snippet: true },
    caseId: "case-demo",
    reportRunId: "run-demo",
  });
  assert.equal(String(pending.externalTaskId), "3944");
  assert.equal(pending.state, "RUNNING");

  // Idempotent: same requestHash returns same row
  const again = await ensureArsenkinTask(client, store, {
    toolName: "check-top",
    data: { queries: ["Глинка Сергей Михайлович"], depth: 10, is_snippet: true },
    reportRunId: "run-demo",
  });
  assert.equal(again.id, pending.id);

  let row = await store.updateState(pending.id, { state: "RUNNING", nextPollAt: new Date(0) });
  row = await pollArsenkinTask(client, store, row);
  assert.ok(row.state === "RUNNING" || row.state === "QUEUED");
  row = await store.updateState(row.id, { state: row.state, nextPollAt: new Date(0) });
  row = await pollArsenkinTask(client, store, row);
  assert.equal(row.state, "DONE");
  assert.ok(row.responseJson);

  const redact = redactSecrets("Authorization: Bearer super-secret-token-do-not-log");
  assert.ok(!redact.includes("super-secret-token"));
  assert.ok(hashProviderRequest({ a: 1 }).length === 64);

  // 429 retry path
  let hit429 = false;
  const client429 = new ArsenkinClient({
    token: "tok",
    maxRetries: 2,
    sleep: async () => undefined,
    fetchImpl: async () => {
      if (!hit429) {
        hit429 = true;
        return new Response(JSON.stringify({ status: "Error", code: "429", error: "Too Many Requests" }), {
          status: 429,
        });
      }
      return new Response(JSON.stringify(setOk), { status: 200 });
    },
  });
  const set = await client429.setTask({ tools_name: "suggest", data: { queries: ["x"] } });
  assert.equal(String(set.task_id), "3944");

  console.log(
    JSON.stringify(
      {
        ok: true,
        calls,
        taskId: row.externalTaskId,
        state: row.state,
        toolsDefault: arsenkinTools({}),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
