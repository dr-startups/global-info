/**
 * Offline acceptance for REMEDIATION_PLAN §0.4 — report quality UI wiring.
 *
 * Run: npm run smoke:report-quality-panel
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  describeEmptyStateReason,
  describeGptStage1Status,
  gptStage1Tone,
} from "../src/modules/digital-profile/client/report-quality-labels";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

describe("report-quality empty-state / GPT labels (§0.4)", () => {
  it("maps known empty-state codes to Russian client text", () => {
    assert.match(describeEmptyStateReason("no-suggestions"), /Подсказки/);
    assert.match(describeEmptyStateReason("VISUAL_ASSET_UNAVAILABLE"), /Визуальный/);
    assert.match(describeEmptyStateReason("no-identity-data"), /Wikipedia|идентич/i);
    assert.match(describeEmptyStateReason("mystery-code"), /mystery-code/);
  });

  it("maps GPT stage1 statuses to traffic-light tones", () => {
    assert.equal(gptStage1Tone("APPLIED"), "ok");
    assert.equal(gptStage1Tone("FAILED"), "danger");
    assert.equal(gptStage1Tone("SKIPPED"), "neutral");
    assert.match(describeGptStage1Status("FAILED"), /Fallback/i);
  });
});

describe("report-quality panel wiring (§0.4)", () => {
  it("GET unified-collection already exposes reportQuality", () => {
    const route = read("app/api/digital-profile/cases/[id]/unified-collection/route.ts");
    assert.match(route, /reportQuality:\s*job\.reportQuality/);
  });

  it("client type + CaseDetailView mount ReportQualityPanel", () => {
    const api = read("modules/digital-profile/client/api.ts");
    const view = read("modules/digital-profile/client/CaseDetailView.tsx");
    const panel = read("modules/digital-profile/client/ReportQualityPanel.tsx");
    assert.match(api, /export type JobReportQualityDTO/);
    assert.match(api, /reportQuality\?:/);
    assert.match(view, /ReportQualityPanel/);
    assert.match(view, /unifiedJob\?\.reportQuality/);
    assert.match(panel, /data-testid="report-quality-panel"/);
    assert.match(panel, /Качество отчёта/);
    assert.doesNotMatch(panel, /onClick|button/);
  });

  it("JobReportQuality carries emptyState list for the panel", () => {
    const summary = read("modules/digital-profile/services/report-quality-summary.ts");
    assert.match(summary, /emptyState:\s*Array<\{\s*slotId:\s*string;\s*reason:\s*string\s*\}>/);
    assert.match(summary, /emptyState:\s*summary\.slides\.emptyState\.map/);
  });
});
