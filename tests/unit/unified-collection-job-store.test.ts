/**
 * File-mode unified collection job store (REMEDIATION §9.4).
 * NETWORK_CALLS=0 — no DB / network.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  claimUnifiedJobLease,
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  getUnifiedCollectionJobStoreMode,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  releaseUnifiedJobLease,
  saveUnifiedCollectionJob,
  writeUnifiedArtifact,
  readUnifiedArtifact,
  unifiedJobDir,
} from "../../src/modules/digital-profile/services/unified-collection-job-store";

const CASE = `unit-ucjs-${Date.now()}`;

describe("unified-collection-job-store (file mode)", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    expect(getUnifiedCollectionJobStoreMode()).toBe("file");
    await deleteUnifiedCollectionJobForTests(CASE);
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    try {
      rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("defaults store mode to file when unset", () => {
    const prev = process.env.UNIFIED_COLLECTION_JOB_STORE;
    delete process.env.UNIFIED_COLLECTION_JOB_STORE;
    expect(getUnifiedCollectionJobStoreMode()).toBe("file");
    if (prev !== undefined) process.env.UNIFIED_COLLECTION_JOB_STORE = prev;
    else process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
  });

  it("claim / release lease and reject foreign owner", async () => {
    const { job } = await findOrCreateUnifiedCollectionJob({
      caseId: CASE,
      requestedBy: "unit-tester",
    });
    expect(job.versionNum).toBeGreaterThanOrEqual(1);

    const ownerA = "owner-a";
    const ownerB = "owner-b";
    const claimed = await claimUnifiedJobLease({ caseId: CASE, ownerId: ownerA, leaseMs: 60_000 });
    expect(claimed?.leaseOwnerId).toBe(ownerA);
    expect(claimed?.leaseUntil).toBeTruthy();

    const blocked = await claimUnifiedJobLease({ caseId: CASE, ownerId: ownerB, leaseMs: 60_000 });
    expect(blocked).toBeNull();

    await releaseUnifiedJobLease(CASE, ownerA);
    const after = await loadUnifiedCollectionJob(CASE);
    expect(after?.leaseOwnerId).toBeNull();
    expect(after?.leaseUntil).toBeNull();

    const reclaimed = await claimUnifiedJobLease({ caseId: CASE, ownerId: ownerB, leaseMs: 60_000 });
    expect(reclaimed?.leaseOwnerId).toBe(ownerB);
  });

  it("bumps versionNum on save and patch", async () => {
    const { job: created } = await findOrCreateUnifiedCollectionJob({
      caseId: CASE,
      requestedBy: "unit-tester",
    });
    const v0 = created.versionNum;
    const saved = await saveUnifiedCollectionJob({
      ...created,
      progress: 0.5,
      warnings: ["unit-warn"],
    });
    expect(saved.versionNum).toBe(v0 + 1);
    expect(saved.progress).toBe(0.5);

    const patched = await patchUnifiedCollectionJob(CASE, { stage: "COMPOSITE_MERGE", status: "RUNNING" });
    expect(patched?.versionNum).toBe(saved.versionNum + 1);
    expect(patched?.stage).toBe("COMPOSITE_MERGE");
  });

  it("writes and reads artifacts on disk", async () => {
    const { job } = await findOrCreateUnifiedCollectionJob({
      caseId: CASE,
      requestedBy: "unit-tester",
    });
    const path = await writeUnifiedArtifact(CASE, job.unifiedJobId, "unit-probe.json", { ok: true });
    expect(path).toContain(join(CASE, job.unifiedJobId));
    const read = await readUnifiedArtifact<{ ok: boolean }>(CASE, job.unifiedJobId, "unit-probe.json");
    expect(read).toEqual({ ok: true });
  });
});

describe("unified-collection-job-store (db mode CAS)", () => {
  const dbEnabled =
    process.env.UNIFIED_COLLECTION_JOB_STORE === "db" && Boolean(process.env.DATABASE_URL);

  it.skipIf(!dbEnabled)("lease CAS with two owners", async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "db";
    // Requires a real Case row + DATABASE_URL — skipped in offline CI.
    const caseId = `db-ucjs-${Date.now()}`;
    const { job } = await findOrCreateUnifiedCollectionJob({
      caseId,
      requestedBy: "db-unit",
    });
    expect(job.caseId).toBe(caseId);
    const a = await claimUnifiedJobLease({ caseId, ownerId: "a", leaseMs: 60_000 });
    expect(a?.leaseOwnerId).toBe("a");
    const b = await claimUnifiedJobLease({ caseId, ownerId: "b", leaseMs: 60_000 });
    expect(b).toBeNull();
    await releaseUnifiedJobLease(caseId, "a");
    await deleteUnifiedCollectionJobForTests(caseId);
  });
});
