/**
 * Offline UI/API smoke: Unified REPORT_READY download buttons use job-scoped
 * canonical keys; foreign jobId fails closed; URL build does not start a pipeline.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-unified-canonical-downloads-ui.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { getCanonicalArtifactDownloadUrl } from "../src/modules/digital-profile/client/api";
import {
  CanonicalArtifactError,
  getCanonicalDownloadAvailability,
  resolveCanonicalArtifactForDownload,
} from "../src/modules/digital-profile/services/canonical-report-artifacts";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedArtifactsDir,
  unifiedJobDir,
} from "../src/modules/digital-profile/services/unified-collection-job-store";

const CASE_ID = "case-unified-downloads-ui-smoke";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

after(() => {
  deleteUnifiedCollectionJobForTests(CASE_ID);
  try {
    rmSync(unifiedJobDir(CASE_ID), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seedReportReadyJob(): { jobId: string; renderDir: string } {
  deleteUnifiedCollectionJobForTests(CASE_ID);
  try {
    rmSync(unifiedJobDir(CASE_ID), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const { job } = findOrCreateUnifiedCollectionJob({ caseId: CASE_ID, requestedBy: "tester" });
  const renderDir = join(unifiedArtifactsDir(CASE_ID, job.unifiedJobId), "render");
  mkdirSync(renderDir, { recursive: true });
  const pdfPath = join(renderDir, "rendered-client.pdf");
  const pptxPath = join(renderDir, "rendered-client.pptx");
  const contactPath = join(renderDir, "contact-sheet.png");
  writeFileSync(pdfPath, "%PDF-1.4 fake\n", "utf8");
  writeFileSync(pptxPath, "PK fake pptx\n", "utf8");
  writeFileSync(contactPath, "PNG fake\n", "utf8");
  patchUnifiedCollectionJob(CASE_ID, {
    stage: "REPORT_READY",
    status: "COMPLETED",
    reportLinks: { pdf: pdfPath, pptx: pptxPath, contactSheet: contactPath },
  });
  return { jobId: job.unifiedJobId, renderDir };
}

function expectError(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`expected CanonicalArtifactError(${code})`);
  } catch (err) {
    assert.ok(err instanceof CanonicalArtifactError);
    assert.equal(err.reasonCode, code);
    assert.ok(err.status === 404 || err.status === 403 || err.status === 409 || err.status === 400);
  }
}

describe("Unified canonical downloads UI/API (offline)", () => {
  it("REPORT_READY → pdf/pptx/contactSheet keys resolve and URL uses unified-collection/download", () => {
    const { jobId } = seedReportReadyJob();
    const avail = getCanonicalDownloadAvailability({ caseId: CASE_ID, jobId });
    assert.deepEqual(avail, { pdf: true, pptx: true, contactSheet: true });

    for (const artifact of ["pdf", "pptx", "contactSheet"] as const) {
      const meta = resolveCanonicalArtifactForDownload({ caseId: CASE_ID, jobId, artifact });
      assert.equal(meta.jobId, jobId);
      assert.equal(meta.caseId, CASE_ID);
      const url = getCanonicalArtifactDownloadUrl(CASE_ID, jobId, artifact);
      assert.match(url, /\/cases\/case-unified-downloads-ui-smoke\/unified-collection\/download\?/);
      assert.match(url, new RegExp(`jobId=${jobId}`));
      assert.match(url, new RegExp(`artifact=${artifact}`));
      assert.doesNotMatch(url, /orion-v2|storyboard|report\/orion/i);
      assert.doesNotMatch(url, /unified-collection\/recover|confirmPaidRecollection/);
    }
  });

  it("foreign jobId → FOREIGN_JOB_LINEAGE (404 fail-closed)", () => {
    seedReportReadyJob();
    expectError(
      () =>
        resolveCanonicalArtifactForDownload({
          caseId: CASE_ID,
          jobId: "unified-foreign-job",
          artifact: "pdf",
        }),
      "FOREIGN_JOB_LINEAGE"
    );
    const avail = getCanonicalDownloadAvailability({
      caseId: CASE_ID,
      jobId: "unified-foreign-job",
    });
    assert.deepEqual(avail, { pdf: false, pptx: false, contactSheet: false });
  });

  it("well-known contact-sheet path works without reportLinks.contactSheet", () => {
    const { jobId, renderDir } = seedReportReadyJob();
    const pdfPath = join(renderDir, "rendered-client.pdf");
    const pptxPath = join(renderDir, "rendered-client.pptx");
    patchUnifiedCollectionJob(CASE_ID, {
      reportLinks: { pdf: pdfPath, pptx: pptxPath },
    });
    const meta = resolveCanonicalArtifactForDownload({
      caseId: CASE_ID,
      jobId,
      artifact: "contactSheet",
    });
    assert.ok(meta.path.endsWith(`${join("render", "contact-sheet.png")}`) || meta.path.includes("contact-sheet.png"));
  });

  it("building download URLs does not imply pipeline start (no POST side effects in helper)", () => {
    const { jobId } = seedReportReadyJob();
    const before = getCanonicalDownloadAvailability({ caseId: CASE_ID, jobId });
    // Repeated "clicks" = repeated URL builds + resolve; still read-only.
    for (let i = 0; i < 3; i++) {
      getCanonicalArtifactDownloadUrl(CASE_ID, jobId, "pdf");
      getCanonicalArtifactDownloadUrl(CASE_ID, jobId, "pptx");
      resolveCanonicalArtifactForDownload({ caseId: CASE_ID, jobId, artifact: "pdf" });
    }
    const after = getCanonicalDownloadAvailability({ caseId: CASE_ID, jobId });
    assert.deepEqual(after, before);
    assert.equal(after.pdf, true);
  });

  it("missing contact sheet → availability false (button omitted)", () => {
    const { jobId, renderDir } = seedReportReadyJob();
    rmSync(join(renderDir, "contact-sheet.png"), { force: true });
    patchUnifiedCollectionJob(CASE_ID, {
      reportLinks: {
        pdf: join(renderDir, "rendered-client.pdf"),
        pptx: join(renderDir, "rendered-client.pptx"),
      },
    });
    const avail = getCanonicalDownloadAvailability({ caseId: CASE_ID, jobId });
    assert.equal(avail.pdf, true);
    assert.equal(avail.pptx, true);
    assert.equal(avail.contactSheet, false);
  });
});
