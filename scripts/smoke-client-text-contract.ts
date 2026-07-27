/**
 * REMEDIATION §6.1 — client-text-contract parity (TS ↔ Python) + consumers.
 * NETWORK_CALLS=0 — no live API.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-client-text-contract.ts
 */

process.env.NETWORK_CALLS = "0";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pythonInterpreter } from "./lib/python";
import {
  evaluateClientText,
  getClientTextContract,
  getClientTextFieldBudgets,
} from "../src/modules/digital-profile/orion-golden/client/load-client-text-contract";
import { ORION_GOLDEN_FORBIDDEN_RAW_TOKENS } from "../src/modules/digital-profile/orion-golden/client/client-text-sanitizer";
import { GPT_SLIDE_COPY_FIELD_BUDGETS } from "../src/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import { toRendererPayload } from "../src/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import type { ReportDeckManifest } from "../src/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { RendererSlide } from "../src/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

const ROOT = join(__dirname, "..");

// Поиск интерпретатора переехал в scripts/lib/python.ts: тот же дефект чинился
// в трёх местах по отдельности, и копии начали расходиться.
const SRC_JSON = join(
  ROOT,
  "src/modules/digital-profile/orion-golden/client/client-text-contract.json"
);
const RENDERER_JSON = join(ROOT, "renderer/client_text_contract.json");

function issueKey(i: { code: string; detail?: string }): string {
  return `${i.code}:${i.detail ?? ""}`;
}

describe("client-text-contract §6.1", () => {
  it("loads and validates the bundled contract", () => {
    const c = getClientTextContract();
    assert.equal(c.version, "client-text-contract-v1");
    assert.ok(c.forbiddenRawTokens.includes("manifest"));
    assert.ok(c.allowedSnakeTokens.includes("lexis_nexis"));
    assert.equal(c.fieldBudgets.narrative, 1100);
    assert.equal(c.fieldBudgets.bullet, 900);
    // «API» / «движок» are not hard sidebar bans after §6.1 review.
    assert.ok(!c.sidebarBannedPattern.includes("\\bAPI\\b"));
    assert.ok(!c.sidebarBannedPattern.includes("движок"));
  });

  it("keeps src and renderer JSON copies byte-identical", () => {
    const a = readFileSync(SRC_JSON);
    const b = readFileSync(RENDERER_JSON);
    assert.equal(
      createHash("sha256").update(a).digest("hex"),
      createHash("sha256").update(b).digest("hex"),
      "renderer/client_text_contract.json must match the TS source of truth"
    );
  });

  it("sanitizer + GPT budgets read the same contract", () => {
    const c = getClientTextContract();
    assert.deepEqual([...ORION_GOLDEN_FORBIDDEN_RAW_TOKENS], c.forbiddenRawTokens);
    const budgets = getClientTextFieldBudgets();
    assert.equal(GPT_SLIDE_COPY_FIELD_BUDGETS.narrative, budgets.narrative);
    assert.equal(GPT_SLIDE_COPY_FIELD_BUDGETS.whatToCheck, budgets.whatToCheck);
  });

  it("toRendererPayload embeds clientTextContract", () => {
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
    const payload = toRendererPayload({
      deckManifest,
      rendererSlides: [slide],
      subjectName: "Тест",
    });
    assert.equal(payload.clientTextContractVersion, "client-text-contract-v1");
    assert.ok(payload.clientTextContract);
    assert.equal(
      (payload.clientTextContract as { version: string }).version,
      "client-text-contract-v1"
    );
  });

  it("TS ↔ Python evaluateClientText parity on fixtures", () => {
    const fixtures: Array<{ text: string; surface: "body" | "sidebar" }> = [
      { text: "Чистый клиентский вывод о субъекте.", surface: "body" },
      { text: "pipeline datasetId leaked", surface: "body" },
      { text: "requires_review status", surface: "body" },
      { text: "lexis_nexis screening ok", surface: "body" },
      { text: "См. таблицу…", surface: "sidebar" },
      { text: "Данные от provider X", surface: "sidebar" },
      { text: "synthetic reconstruction of SERP", surface: "sidebar" },
      { text: "Поисковый движок не вызывался", surface: "sidebar" },
      { text: "Сбор через API не запускался", surface: "sidebar" },
    ];

    const py = spawnSync(
      pythonInterpreter(),
      [
        join(ROOT, "scripts/smoke-client-text-contract.py"),
        "--json",
        JSON.stringify(fixtures),
      ],
      { encoding: "utf8", cwd: ROOT }
    );
    assert.equal(py.status, 0, `python smoke failed: ${py.stderr || py.stdout}`);
    const pyVerdicts = JSON.parse(py.stdout) as Array<{
      ok: boolean;
      issues: Array<{ code: string; detail?: string }>;
      contractVersion: string;
    }>;
    assert.equal(pyVerdicts.length, fixtures.length);

    for (let i = 0; i < fixtures.length; i += 1) {
      const ts = evaluateClientText(fixtures[i]!.text, { surface: fixtures[i]!.surface });
      const pyV = pyVerdicts[i]!;
      assert.equal(ts.contractVersion, pyV.contractVersion, `fixture ${i} version`);
      assert.equal(ts.ok, pyV.ok, `fixture ${i} ok mismatch for "${fixtures[i]!.text}"`);
      assert.deepEqual(
        [...ts.issues].map(issueKey).sort(),
        [...pyV.issues].map(issueKey).sort(),
        `fixture ${i} issues for "${fixtures[i]!.text}"`
      );
    }

    // After §6.1: API / движок alone must not fail sidebar.
    assert.equal(evaluateClientText("Поисковый движок не вызывался", { surface: "sidebar" }).ok, true);
    assert.equal(evaluateClientText("Сбор через API не запускался", { surface: "sidebar" }).ok, true);
    assert.equal(
      evaluateClientText("synthetic reconstruction of SERP", { surface: "sidebar" }).ok,
      false,
      "reconstruction still banned"
    );
  });
});
