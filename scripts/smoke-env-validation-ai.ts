/**
 * REMEDIATION §4.1 — AI env-validation branches (offline).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateDigitalProfileEnv } from "../src/modules/digital-profile/config/env-validation";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  DIGITAL_PROFILE_ENABLED: "true",
  DIGITAL_PROFILE_SIGNED_URL_SECRET: "strong-secret-value-32chars",
  DIGITAL_PROFILE_AUTH_ENABLED: "false",
};

describe("env-validation AI (§4.1)", () => {
  it("production + AI off → WARN about deterministic client reports", () => {
    const r = validateDigitalProfileEnv({
      ...base,
      NODE_ENV: "production",
      DIGITAL_PROFILE_AI_ANALYST_ENABLED: "false",
    });
    assert.ok(
      r.warnings.some((w) => /клиентские отчёты будут детерминированными/.test(w)),
      r.warnings.join(" | ")
    );
  });

  it("AI on without key → WARN", () => {
    const r = validateDigitalProfileEnv({
      ...base,
      NODE_ENV: "development",
      DIGITAL_PROFILE_AI_ANALYST_ENABLED: "true",
      OPENAI_API_KEY: "",
    });
    assert.ok(r.warnings.some((w) => /OPENAI_API_KEY is missing/.test(w)));
  });

  it("REQUIRE_AI_REPORT in production without AI → error", () => {
    const r = validateDigitalProfileEnv({
      ...base,
      NODE_ENV: "production",
      DIGITAL_PROFILE_AI_ANALYST_ENABLED: "false",
      DIGITAL_PROFILE_REQUIRE_AI_REPORT: "true",
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /REQUIRE_AI_REPORT/.test(e)));
  });

  it("REQUIRE_AI_REPORT with AI+key → ok", () => {
    const r = validateDigitalProfileEnv({
      ...base,
      NODE_ENV: "production",
      DIGITAL_PROFILE_AI_ANALYST_ENABLED: "true",
      OPENAI_API_KEY: "sk-test",
      DIGITAL_PROFILE_REQUIRE_AI_REPORT: "true",
      DIGITAL_PROFILE_ORION_V2_REQUIRE_AI: "false",
    });
    assert.equal(r.ok, true);
    assert.ok(!r.errors.some((e) => /REQUIRE_AI_REPORT/.test(e)));
  });
});

describe("report-ready AI gate helper", () => {
  it("gptLayerAppliedFromQuality reads JobReportQuality shape", async () => {
    const { gptLayerAppliedFromQuality, assertReportReadyGates } = await import(
      "../src/modules/digital-profile/services/report-ready-gates"
    );
    assert.equal(
      gptLayerAppliedFromQuality({
        gpt: { stage2Applied: 2, caseAnalysisUsed: false, stage1Status: "SKIPPED" },
      }),
      true
    );
    assert.equal(
      gptLayerAppliedFromQuality({
        gpt: { stage2Applied: 0, caseAnalysisUsed: true, stage1Status: "APPLIED" },
      }),
      true
    );
    assert.equal(
      gptLayerAppliedFromQuality({
        gpt: { stage2Applied: 0, caseAnalysisUsed: false, stage1Status: "SKIPPED" },
      }),
      false
    );

    const blocked = assertReportReadyGates({
      binding: null,
      manifest: null,
      merge: null,
      prepareDatasetId: null,
      realCollectionSufficient: true,
      allowMockReport: true,
      skipBaseCoverage: true,
      requireAiReport: true,
      gptLayerApplied: false,
    });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.errors.some((e) => /REQUIRE_AI_REPORT/.test(e)));
  });
});
