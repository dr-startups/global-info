/**
 * REMEDIATION §6.3 — HTTP renderer cold-start health retries + one POST timeout retry.
 * NETWORK_CALLS=0 — fake fetch only, sleep injected as no-op.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-render-http-retry.ts
 */

process.env.NETWORK_CALLS = "0";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  renderDeckViaHttp,
  waitForRendererHealth,
} from "../src/modules/digital-profile/services/render-deck-artifacts";
import type { ReportDeckManifest } from "../src/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { RendererSlide } from "../src/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

function minimalInput(outputRoot: string) {
  const deckManifest = {
    version: "report-deck-manifest-v1",
    caseId: "c",
    reportRunId: "r",
    sourceDatasetId: "d",
    pageCount: 1,
    baseSlotCoverage: 0,
    slides: [],
    toc: [],
    sectionPageRanges: [],
    nonCanonicalPages: [],
  } as unknown as ReportDeckManifest;
  const slide: RendererSlide = {
    slideKey: "s1",
    sectionKey: "EXECUTIVE",
    template: "orion_golden_text",
    title: "Тест",
    pageNumber: 1,
    totalPageCount: 1,
    baseSlotId: "p01",
    isContinuation: false,
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
  };
  return {
    deckManifest,
    rendererSlides: [slide],
    subjectName: "Тест",
    outputRoot,
  };
}

function okRenderResponse(): Response {
  return new Response(
    JSON.stringify({
      slideCount: 1,
      pptxBase64: Buffer.from("pptx").toString("base64"),
      pdfBase64: Buffer.from("pdf").toString("base64"),
      pages: [{ pageNumber: 1, contentBase64: Buffer.from("p1").toString("base64") }],
      pdfExportMode: "libreoffice",
      warnings: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("REMEDIATION §6.3 HTTP renderer retry", () => {
  it("health 503→503→200 then one successful POST", async () => {
    const dir = mkdtempSync(join(tmpdir(), "render-http-retry-"));
    const sleeps: number[] = [];
    let healthCalls = 0;
    let postCalls = 0;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? "GET").toUpperCase();
      if (u.includes("/health")) {
        healthCalls += 1;
        if (healthCalls < 3) return new Response("cold", { status: 503 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      assert.equal(method, "POST");
      postCalls += 1;
      return okRenderResponse();
    }) as typeof fetch;

    try {
      const result = await renderDeckViaHttp(minimalInput(dir), {
        fetchImpl,
        rendererBaseUrl: "http://renderer.test:8080",
        sleepMs: async (ms) => {
          sleeps.push(ms);
        },
        healthAttempts: 3,
        healthBackoffMs: [15_000, 45_000],
      });
      assert.equal(healthCalls, 3);
      assert.equal(postCalls, 1);
      assert.deepEqual(sleeps, [15_000, 45_000]);
      assert.equal(result.renderer, "http:orion/render-golden");
      assert.ok(result.pptx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST network timeout → one retry → success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "render-http-post-retry-"));
    let postCalls = 0;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      postCalls += 1;
      if (postCalls === 1) {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      }
      assert.equal(String(init?.method ?? "").toUpperCase(), "POST");
      return okRenderResponse();
    }) as typeof fetch;

    try {
      await renderDeckViaHttp(minimalInput(dir), {
        fetchImpl,
        rendererBaseUrl: "http://renderer.test:8080",
        sleepMs: async () => {},
      });
      assert.equal(postCalls, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("permanent health refusal → fails without POST", async () => {
    let healthCalls = 0;
    let postCalls = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).includes("/health")) {
        healthCalls += 1;
        return new Response("down", { status: 503 });
      }
      postCalls += 1;
      return okRenderResponse();
    }) as typeof fetch;

    await assert.rejects(
      () =>
        waitForRendererHealth("http://renderer.test:8080", {
          fetchImpl,
          sleepMs: async () => {},
          healthAttempts: 3,
          healthBackoffMs: [0, 0],
        }),
      (err: unknown) =>
        err instanceof Error && /health check failed after 3 attempts/i.test(err.message)
    );
    assert.equal(healthCalls, 3);
    assert.equal(postCalls, 0);
  });
});
