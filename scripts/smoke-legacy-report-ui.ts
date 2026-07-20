/**
 * REMEDIATION §8.1 / 9.3 — legacy report UI gated; v2/storyboard panels retired.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-legacy-report-ui.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const SRC = join(process.cwd(), "src");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

describe("REMEDIATION §8.1 / 9.3 legacy report UI gate", () => {
  it("config wires DIGITAL_PROFILE_LEGACY_REPORT_UI default false", () => {
    const cfg = read("modules/digital-profile/config.ts");
    assert.match(cfg, /legacyReportUiEnabled:\s*boolean/);
    assert.match(
      cfg,
      /legacyReportUiEnabled:\s*envBool\(\s*process\.env\.DIGITAL_PROFILE_LEGACY_REPORT_UI,\s*false\s*\)/
    );
  });

  it("CaseDetailView mounts Golden manual review only when legacyReportUi; v2/storyboard panels gone", () => {
    const view = read("modules/digital-profile/client/CaseDetailView.tsx");
    assert.match(view, /legacyReportUi\s*&&\s*can\("evidence\.viewRaw"\)/);
    assert.match(view, /ReportQualityPanel/);
    assert.doesNotMatch(view, /OrionV2ReportPanel/);
    assert.doesNotMatch(view, /OrionClientStoryboardReportPanel/);
  });

  it("default-visible surfaces gate legacy generate CTAs; one unified CTA remains", () => {
    const header = read("modules/digital-profile/client/CaseHeader.tsx");
    const tabs = read("modules/digital-profile/client/CaseTabs.tsx");
    const preview = read("modules/digital-profile/client/ReportPreviewPanel.tsx");
    const agents = read("modules/digital-profile/client/AgentsTab.tsx");

    assert.match(header, /legacyReportUi && can\("report\.generateInternal"\)/);
    assert.match(header, /unified-orion-collection-cta/);
    assert.match(preview, /legacyReportUi && \(canGenerateInternal/);
    assert.match(agents, /showUnifiedCta = false/);
    assert.match(tabs, /showUnifiedCta=\{false\}/);
  });

  it("page passes config.legacyReportUiEnabled into CaseDetailView", () => {
    const page = read("app/admin/digital-profile/[caseId]/page.tsx");
    assert.match(page, /legacyReportUi=\{digitalProfileConfig\.legacyReportUiEnabled\}/);
  });

  it("legacy report routes return LEGACY_REPORT_PATH_RETIRED helper", () => {
    const helper = read("modules/digital-profile/http/legacy-report-retired.ts");
    assert.match(helper, /LEGACY_REPORT_PATH_RETIRED/);
    for (const rel of [
      "app/api/digital-profile/cases/[id]/report/orion-v2/route.ts",
      "app/api/digital-profile/cases/[id]/report/orion-client-storyboard/route.ts",
      "app/api/digital-profile/cases/[id]/report/generate/route.ts",
      "app/api/digital-profile/cases/[id]/report/render/route.ts",
    ]) {
      const src = read(rel);
      assert.match(src, /legacyReportPathRetired/);
      assert.match(src, /RETIRED/);
    }
  });

  it("no default-mounted client path calls legacy generate without gate", () => {
    const preview = read("modules/digital-profile/client/ReportPreviewPanel.tsx");
    assert.match(preview, /generateReport\(/);
    assert.match(preview, /legacyReportUi \?\? false|legacyReportUi = false/);
  });
});
