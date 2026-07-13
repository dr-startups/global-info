import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectFirst36Acceptance } from "../src/modules/digital-profile/orion-golden/classic/first36-acceptance-gate";
import { ORION_FIRST36_REGISTRY_V1 } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-registry.v1";
import { missingMandatoryArsenkinCoverage } from "../src/modules/digital-profile/orion-golden/classic/enrich-report-run-with-arsenkin";
import { createMemoryProviderTaskStore } from "../src/modules/digital-profile/providers/arsenkin/provider-task-store";

describe("first36 acceptance hardening", () => {
  it("rejects an empty deck even when slideCount is 36", () => {
    const result = inspectFirst36Acceptance({
      slideCount: 36,
      slides: [],
      runScopedMerge: { usedRunScoped: false, observationCount: 0 },
    });
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((issue) => issue.code === "slide-object-count"));
  });

  it("requires concrete selected Arsenkin surface coverage", () => {
    const missing = missingMandatoryArsenkinCoverage(
      [{ surface: "autocomplete", engine: "GOOGLE", region: "RU" }],
      ["suggest"]
    );
    assert.deepEqual(missing.sort(), ["suggest:google:UAE", "suggest:yandex:RU"]);
  });

  it("accepts successful NO_RESULTS coverage as mandatory surface present", () => {
    const missing = missingMandatoryArsenkinCoverage([], ["paa"], [
      { surface: "paa", engine: "GOOGLE", region: "RU", status: "OK" },
      { surface: "paa", engine: "GOOGLE", region: "UAE", status: "NO_RESULTS" },
    ]);
    assert.deepEqual(missing, []);
  });

  it("maps p12 exclusively to Google suggestions", () => {
    const p12 = ORION_FIRST36_REGISTRY_V1.find((slot) => slot.slotId === "p12_ru_suggestions_google");
    assert.ok(p12?.match.assetRefRe?.test("ru_suggestions_google"));
    assert.equal(p12?.match.assetRefRe?.test("ru_url_audit") ?? false, false);
  });

  it("identical provider requests remain isolated by report run", async () => {
    const store = createMemoryProviderTaskStore();
    const requestJson = { queries: ["subject"], se: 2 };
    const a = await store.upsertPending({ reportRunId: "run-A", toolName: "suggest", requestJson });
    const b = await store.upsertPending({ reportRunId: "run-B", toolName: "suggest", requestJson });
    assert.notEqual(a.id, b.id);
  });

  it("does not double-lease a due RUNNING provider task", async () => {
    const store = createMemoryProviderTaskStore();
    const row = await store.upsertPending({
      reportRunId: "run-A",
      toolName: "suggest",
      requestJson: { q: "subject" },
    });
    await store.updateState(row.id, {
      state: "RUNNING",
      externalTaskId: "ext-1",
      nextPollAt: new Date(0),
    });
    const now = new Date();
    const first = await store.claimDue("worker-1", now, 1, 30_000);
    const second = await store.claimDue("worker-2", now, 1, 30_000);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
  });

  it("claimDue ignores QUEUED without externalTaskId", async () => {
    const store = createMemoryProviderTaskStore();
    await store.upsertPending({ reportRunId: "run-A", toolName: "suggest", requestJson: { q: "queued" } });
    const claimed = await store.claimDue("worker-1", new Date(), 5, 30_000);
    assert.equal(claimed.length, 0);
  });
});
