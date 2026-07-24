/**
 * C — canonical artifact download resolver (NETWORK_CALLS=0, offline).
 *
 * Proves the lineage-safe download resolver: happy path + fail-closed on foreign
 * jobId, wrong kind, in-flight state, out-of-lineage path (traversal),
 * and missing-on-disk. COMPLETED_PARTIAL remains downloadable.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-canonical-artifact-download.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  findOrCreateUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedArtifactsDir,
  unifiedJobDir,
  deleteUnifiedCollectionJobForTests,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  CanonicalArtifactError,
  resolveCanonicalArtifactForDownload,
} from "../src/modules/digital-profile/services/canonical-report-artifacts";

const CASE_ID = "case-download-smoke-1";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

after(async () => {
  await deleteUnifiedCollectionJobForTests(CASE_ID);
  try {
    rmSync(unifiedJobDir(CASE_ID), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function seedAcceptedJob(): Promise<{ jobId: string; pdfPath: string }> {
  await deleteUnifiedCollectionJobForTests(CASE_ID);
  try {
    rmSync(unifiedJobDir(CASE_ID), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const { job } = await findOrCreateUnifiedCollectionJob({ caseId: CASE_ID, requestedBy: "tester" });
  const renderDir = join(unifiedArtifactsDir(CASE_ID, job.unifiedJobId), "render");
  mkdirSync(renderDir, { recursive: true });
  const pdfPath = join(renderDir, "rendered-client.pdf");
  const pptxPath = join(renderDir, "rendered-client.pptx");
  writeFileSync(pdfPath, "%PDF-1.4 fake\n", "utf8");
  writeFileSync(pptxPath, "PK fake pptx\n", "utf8");
  await patchUnifiedCollectionJob(CASE_ID, {
    stage: "REPORT_READY",
    status: "COMPLETED",
    reportLinks: { pdf: pdfPath, pptx: pptxPath },
  });
  return { jobId: job.unifiedJobId, pdfPath };
}

async function expectError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    assert.fail(`expected CanonicalArtifactError(${code}) but none thrown`);
  } catch (err) {
    assert.ok(err instanceof CanonicalArtifactError, `expected CanonicalArtifactError, got ${String(err)}`);
    assert.equal(err.reasonCode, code);
  }
}

describe("C — canonical artifact download resolver", () => {
  it("happy path: resolves the accepted PDF within job lineage", async () => {
    const { jobId, pdfPath } = await seedAcceptedJob();
    const meta = await resolveCanonicalArtifactForDownload({ caseId: CASE_ID, jobId, artifact: "pdf" });
    assert.equal(meta.path, pdfPath);
    assert.equal(meta.mimeType, "application/pdf");
    assert.equal(meta.jobId, jobId);
  });

  it("foreign jobId is rejected", async () => {
    await seedAcceptedJob();
    await expectError(
      () =>
        resolveCanonicalArtifactForDownload({
          caseId: CASE_ID,
          jobId: "unified-does-not-exist",
          artifact: "pdf",
        }),
      "FOREIGN_JOB_LINEAGE"
    );
  });

  it("invalid artifact kind is rejected", async () => {
    const { jobId } = await seedAcceptedJob();
    await expectError(
      () => resolveCanonicalArtifactForDownload({ caseId: CASE_ID, jobId, artifact: "docx" }),
      "ARTIFACT_KIND_INVALID"
    );
  });

  it("contactSheet resolves from well-known render path when present", async () => {
    const { jobId } = await seedAcceptedJob();
    const contactPath = join(unifiedArtifactsDir(CASE_ID, jobId), "render", "contact-sheet.png");
    writeFileSync(contactPath, "PNG fake\n", "utf8");
    const meta = await resolveCanonicalArtifactForDownload({
      caseId: CASE_ID,
      jobId,
      artifact: "contactSheet",
    });
    assert.equal(meta.mimeType, "image/png");
    assert.equal(meta.path, contactPath);
  });

  it("unaccepted job (mid-flow) is rejected", async () => {
    const { jobId } = await seedAcceptedJob();
    await patchUnifiedCollectionJob(CASE_ID, { stage: "COMPOSITE_MERGE", status: "RUNNING" });
    await expectError(
      () => resolveCanonicalArtifactForDownload({ caseId: CASE_ID, jobId, artifact: "pdf" }),
      "REPORT_NOT_ACCEPTED"
    );
  });

  it("partial completed job is downloadable", async () => {
    const { jobId } = await seedAcceptedJob();
    await patchUnifiedCollectionJob(CASE_ID, { stage: "COMPLETED_PARTIAL", status: "COMPLETED" });
    const meta = await resolveCanonicalArtifactForDownload({
      caseId: CASE_ID,
      jobId,
      artifact: "pdf",
    });
    assert.equal(meta.mimeType, "application/pdf");
  });

  it("out-of-lineage path (traversal) is rejected", async () => {
    const { jobId } = await seedAcceptedJob();
    await patchUnifiedCollectionJob(CASE_ID, {
      reportLinks: { pdf: join(process.cwd(), "package.json") },
    });
    await expectError(
      () => resolveCanonicalArtifactForDownload({ caseId: CASE_ID, jobId, artifact: "pdf" }),
      "ARTIFACT_OUT_OF_LINEAGE"
    );
  });

  it("missing-on-disk artifact is rejected", async () => {
    const { jobId } = await seedAcceptedJob();
    await patchUnifiedCollectionJob(CASE_ID, {
      reportLinks: { pdf: join(unifiedArtifactsDir(CASE_ID, jobId), "render", "does-not-exist.pdf") },
    });
    await expectError(
      () => resolveCanonicalArtifactForDownload({ caseId: CASE_ID, jobId, artifact: "pdf" }),
      "ARTIFACT_MISSING_ON_DISK"
    );
  });
});
