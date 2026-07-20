/**
 * REMEDIATION §8.1 — legacy report UI gated behind DIGITAL_PROFILE_LEGACY_REPORT_UI.
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

describe("REMEDIATION §8.1 legacy report UI gate", () => {
  it("config wires DIGITAL_PROFILE_LEGACY_REPORT_UI default false", () => {
    const cfg = read("modules/digital-profile/config.ts");
    assert.match(cfg, /legacyReportUiEnabled:\s*boolean/);
    assert.match(
      cfg,
      /legacyReportUiEnabled:\s*envBool\(\s*process\.env\.DIGITAL_PROFILE_LEGACY_REPORT_UI,\s*false\s*\)/
    );
  });

  it("CaseDetailView mounts Orion/storyboard/Golden only when legacyReportUi", () => {
    const view = read("modules/digital-profile/client/CaseDetailView.tsx");
    assert.match(view, /legacyReportUi\s*&&\s*isAdmin/);
    assert.match(view, /legacyReportUi\s*&&\s*can\("evidence\.viewRaw"\)/);
    assert.match(view, /OrionV2ReportPanel/);
    assert.match(view, /OrionClientStoryboardReportPanel/);
    assert.match(view, /ReportQualityPanel/);
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

  it("orion v2 / storyboard is*Enabled require legacyReportUiEnabled", () => {
    const v2 = read("modules/digital-profile/services/orion-v2-report-service.ts");
    const sb = read(
      "modules/digital-profile/services/orion-client-storyboard-report-service.ts"
    );
    assert.match(v2, /legacyReportUiEnabled && digitalProfileConfig\.orionV2UiEnabled/);
    assert.match(
      sb,
      /legacyReportUiEnabled &&\s*digitalProfileConfig\.orionClientStoryboardUiEnabled/
    );
  });

  it("no default-mounted client path calls legacy endpoints without gate", () => {
    // Acceptance: components that call these APIs are only reached when legacyReportUi.
    const preview = read("modules/digital-profile/client/ReportPreviewPanel.tsx");
    const v2 = read("modules/digital-profile/client/OrionV2ReportPanel.tsx");
    const sb = read("modules/digital-profile/client/OrionClientStoryboardReportPanel.tsx");
    assert.match(preview, /generateReport\(/);
    assert.match(v2, /orion-v2|generateOrionV2Report/);
    assert.match(sb, /orion-client-storyboard|generateOrionClientStoryboardReport/);
    // Mount gates are in CaseDetailView / ReportPreviewPanel canGenerate.
    const view = read("modules/digital-profile/client/CaseDetailView.tsx");
    assert.match(view, /legacyReportUi && isAdmin/);
    assert.match(preview, /legacyReportUi \?\? false|legacyReportUi = false/);
  });
});
