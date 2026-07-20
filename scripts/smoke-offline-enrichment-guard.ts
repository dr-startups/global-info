/**
 * REMEDIATION §8.2 — offline enrichment guard in deploy-like envs.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-offline-enrichment-guard.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureOfflineEnrichmentJobWarning,
  isDeployLikeEnv,
  isOfflineEnrichmentMode,
  OFFLINE_ENRICHMENT_CLIENT_MESSAGE,
  OFFLINE_ENRICHMENT_WARNING,
  offlineEnrichmentEnvWarning,
} from "../src/modules/digital-profile/config/offline-enrichment-guard";
import { validateDigitalProfileEnv } from "../src/modules/digital-profile/config/env-validation";

describe("REMEDIATION §8.2 offline enrichment guard", () => {
  it("isDeployLikeEnv covers production / vercel / explicit flag", () => {
    assert.equal(isDeployLikeEnv({ NODE_ENV: "production" }), true);
    assert.equal(isDeployLikeEnv({ VERCEL_ENV: "preview" }), true);
    assert.equal(isDeployLikeEnv({ DIGITAL_PROFILE_DEPLOY_LIKE: "1" }), true);
    assert.equal(isDeployLikeEnv({ NODE_ENV: "development" }), false);
  });

  it("offline mode only in deploy-like when NETWORK_CALLS=0 or Arsenkin off", () => {
    assert.equal(
      isOfflineEnrichmentMode({
        NODE_ENV: "development",
        NETWORK_CALLS: "0",
      }),
      false
    );
    assert.equal(
      isOfflineEnrichmentMode({
        NODE_ENV: "production",
        NETWORK_CALLS: "0",
        ARSENKIN_ENABLED: "true",
      }),
      true
    );
    assert.equal(
      isOfflineEnrichmentMode({
        NODE_ENV: "production",
        ARSENKIN_ENABLED: "false",
      }),
      true
    );
    assert.equal(
      isOfflineEnrichmentMode({
        NODE_ENV: "production",
        ARSENKIN_ENABLED: "true",
      }),
      false
    );
  });

  it("env-validation emits WARN text for offline enrichment", () => {
    const result = validateDigitalProfileEnv({
      NODE_ENV: "production",
      DIGITAL_PROFILE_ENABLED: "true",
      DATABASE_URL: "postgres://local/db",
      DIGITAL_PROFILE_SIGNED_URL_SECRET: "strong-secret-value-16+",
      DIGITAL_PROFILE_AUTH_ENABLED: "false",
      NETWORK_CALLS: "0",
      ARSENKIN_ENABLED: "false",
    });
    assert.ok(result.warnings.some((w) => /offline enrichment mode/i.test(w)));
    assert.ok(offlineEnrichmentEnvWarning({ NODE_ENV: "production", NETWORK_CALLS: "0" }));
  });

  it("ensureOfflineEnrichmentJobWarning is idempotent", () => {
    const once = ensureOfflineEnrichmentJobWarning([]);
    assert.deepEqual(once, [OFFLINE_ENRICHMENT_WARNING]);
    assert.deepEqual(ensureOfflineEnrichmentJobWarning(once), once);
  });

  it("startUnifiedOrionCollection stamps offline-enrichment-mode warning", async () => {
    const prevCwd = process.cwd();
    const prevNode = process.env.NODE_ENV;
    const prevNet = process.env.NETWORK_CALLS;
    const prevArs = process.env.ARSENKIN_ENABLED;
    const root = mkdtempSync(join(tmpdir(), "offline-guard-"));
    try {
      process.chdir(root);
      process.env.NODE_ENV = "production";
      process.env.NETWORK_CALLS = "0";
      process.env.ARSENKIN_ENABLED = "false";

      const { startUnifiedOrionCollection } = await import(
        "../src/modules/digital-profile/services/unified-orion-collection-orchestrator"
      );
      const { loadUnifiedCollectionJob, deleteUnifiedCollectionJobForTests } = await import(
        "../src/modules/digital-profile/services/unified-collection-job-store"
      );

      const caseId = `case-offline-${Date.now()}`;
      await startUnifiedOrionCollection({
        caseId,
        requestedBy: "smoke",
        deps: { autoSchedule: false },
      });
      const job = loadUnifiedCollectionJob(caseId);
      assert.ok(job);
      assert.ok((job!.warnings ?? []).includes(OFFLINE_ENRICHMENT_WARNING));
      deleteUnifiedCollectionJobForTests(caseId);
    } finally {
      process.chdir(prevCwd);
      if (prevNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNode;
      if (prevNet === undefined) delete process.env.NETWORK_CALLS;
      else process.env.NETWORK_CALLS = prevNet;
      if (prevArs === undefined) delete process.env.ARSENKIN_ENABLED;
      else process.env.ARSENKIN_ENABLED = prevArs;
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("client copy constant is the planned Russian sentence", () => {
    assert.match(
      OFFLINE_ENRICHMENT_CLIENT_MESSAGE,
      /офлайн-режиме.*подсказок\/AI будут пустыми/i
    );
  });
});
