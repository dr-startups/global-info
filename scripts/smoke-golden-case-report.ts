/**
 * Offline acceptance for REMEDIATION_PLAN §0.3 — golden-case harness.
 *
 * Asserts: fixture size band, prepare succeeds, two runs match, baseline matches.
 * Run: npm run smoke:golden-case
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before } from "node:test";

import { buildGoldenCaseObservations } from "../fixtures/golden-case/build-observations";
import { main as runGoldenCaseCli } from "./run-golden-case-report";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "fixtures", "golden-case", "baseline.json");

describe("golden-case fixtures", () => {
  it("builds ~300 composite observations with required surfaces", () => {
    const rows = buildGoldenCaseObservations();
    assert.ok(rows.length >= 280 && rows.length <= 340, `count=${rows.length}`);
    assert.ok(rows.some((r) => r.kind === "organic" && r.region === "RU"));
    assert.ok(rows.some((r) => r.kind === "organic" && r.region === "UAE"));
    assert.ok(rows.some((r) => r.kind === "suggestion"));
    assert.ok(rows.some((r) => r.kind === "paa"));
    assert.ok(rows.some((r) => r.surface === "images"));
    assert.ok(rows.some((r) => r.surface === "ai_answer"));
    assert.ok(rows.some((r) => r.surface === "wikipedia"));
    assert.ok(rows.some((r) => r.surface === "serp_screenshot"));
    const compliance = rows.filter((r) => /lexisnexis|dow jones|worldcompliance/i.test(r.title ?? ""));
    assert.equal(compliance.length, 2);
    assert.ok(rows.some((r) => /hockey|nhl|goaltender|хоккей|вратарь/i.test(`${r.title} ${r.snippet}`)));
  });

  it("baseline file is committed", () => {
    assert.ok(existsSync(BASELINE), "fixtures/golden-case/baseline.json must exist");
  });
});

describe("golden-case report harness", () => {
  it("is deterministic and matches baseline", async () => {
    const code = await runGoldenCaseCli([]);
    assert.equal(code, 0, "golden-case CLI must exit 0 against baseline");
  });
});
