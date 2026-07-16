/**
 * Offline smoke: report evidence provenance snapshot shape + gap detection.
 * NETWORK_CALLS=0 — no live API.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import {
  buildReportEvidenceProvenance,
  writeReportEvidenceProvenance,
} from "../src/modules/digital-profile/services/report-evidence-provenance";
import {
  appendCaseAgentEnrichmentToReportBinding,
  coveredSurfacesForCaseAgentTools,
  listArsenkinObservationAuditRunIds,
  loadArsenkinReportBinding,
  saveArsenkinReportBinding,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-report-binding";

process.env.NETWORK_CALLS = "0";

describe("report evidence provenance", () => {
  before(() => {
    process.env.NETWORK_CALLS = "0";
  });

  it("NETWORK_CALLS=0", () => {
    assert.equal(process.env.NETWORK_CALLS, "0");
  });

  it("coveredSurfacesForCaseAgentTools maps tools to cells", () => {
    const cells = coveredSurfacesForCaseAgentTools(["check-top", "paa"]);
    assert.ok(cells.some((c) => c.surface === "organic"));
    assert.ok(cells.some((c) => c.surface === "paa"));
  });

  it("appendCaseAgentEnrichmentToReportBinding appends without dropping canary effective id", () => {
    const caseId = `prov-bind-${Date.now()}`;
    saveArsenkinReportBinding({
      caseId,
      sourceReportRunId: "orion-r10-base-smoke",
      effectiveReportRunId: "orion-arsenkin-suggest-canary-smoke",
      provider: "arsenkin",
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      status: "REPORT_BOUND",
      transferredAt: new Date().toISOString(),
      providerTaskCount: 2,
      observationCount: 18,
      coverageCount: 2,
      version: "arsenkin-report-binding-v2",
      enrichmentRuns: [
        {
          reportRunId: "orion-arsenkin-suggest-canary-smoke",
          provider: "arsenkin",
          workflow: "suggest-canary",
          stage: "SUGGEST_RU_CANARY",
          coveredSurfaces: [
            { region: "RU", engine: "YANDEX", surface: "autocomplete", status: "COLLECTED" },
          ],
        },
      ],
      compositeDigest: "cmp-test",
    });

    const reg = appendCaseAgentEnrichmentToReportBinding({
      caseId,
      enrichmentReportRunId: "orion-arsenkin-agent-search-top-smoke",
      baseReportRunId: "orion-r10-base-smoke",
      agentId: "ARSENKIN_SEARCH_TOP_REAL",
      tools: ["check-top"],
      observationCount: 199,
    });
    assert.equal(reg.ok, true);
    assert.equal(reg.reason, "appended-enrichment-run");
    const binding = loadArsenkinReportBinding(caseId)!;
    assert.equal(binding.effectiveReportRunId, "orion-arsenkin-suggest-canary-smoke");
    assert.ok(
      (binding.enrichmentRuns ?? []).some(
        (r) => r.reportRunId === "orion-arsenkin-agent-search-top-smoke"
      )
    );

    const obsRuns = listArsenkinObservationAuditRunIds({
      caseId,
      primaryAuditRunId: binding.effectiveReportRunId,
    });
    assert.ok(obsRuns.includes("orion-arsenkin-suggest-canary-smoke"));
    assert.ok(obsRuns.includes("orion-arsenkin-agent-search-top-smoke"));
    assert.equal(obsRuns[0], "orion-arsenkin-suggest-canary-smoke");
  });

  it("buildReportEvidenceProvenance returns v1 snapshot even without DB", async () => {
    const caseId = `prov-snap-${Date.now()}`;
    const snap = await buildReportEvidenceProvenance({
      caseId,
      phase: "DIAGNOSTIC",
      trigger: "smoke",
    });
    assert.equal(snap.version, "report-evidence-provenance-v1");
    assert.equal(snap.caseId, caseId);
    assert.equal(snap.phase, "DIAGNOSTIC");
    assert.ok(Array.isArray(snap.gaps));
    assert.ok(Array.isArray(snap.notes));
    assert.ok(snap.notes.some((n) => n.includes("phase=DIAGNOSTIC")));
  });

  it("writeReportEvidenceProvenance writes JSON under storage", async () => {
    const caseId = `prov-write-${Date.now()}`;
    const { path, snapshot } = await writeReportEvidenceProvenance({
      caseId,
      phase: "ORION_PREPARE",
      trigger: "smoke-write",
    });
    assert.match(path, /report-provenance/);
    assert.equal(snapshot.phase, "ORION_PREPARE");
    const fs = await import("node:fs");
    assert.ok(fs.existsSync(path));
  });
});
