/**
 * REMEDIATION §8.3 — unified diagnostics zip (no binaries, secrets redacted).
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-unified-diagnostics-bundle.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import JSZip from "jszip";

import {
  buildUnifiedDiagnosticsBundle,
  redactDiagnosticsJson,
} from "../src/modules/digital-profile/services/unified-diagnostics-bundle";
import {
  findOrCreateUnifiedCollectionJob,
  deleteUnifiedCollectionJobForTests,
  writeUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";

describe("REMEDIATION §8.3 unified diagnostics bundle", () => {
  it("redactDiagnosticsJson strips api keys / tokens", () => {
    const out = redactDiagnosticsJson({
      title: "ok",
      apiKey: "sk-live-secret",
      nested: { openAiApiKey: "sk-xxx", note: "fine" },
      Authorization: "Bearer abc.def",
    }) as Record<string, unknown>;
    assert.equal(out.apiKey, "[REDACTED]");
    assert.equal((out.nested as { openAiApiKey: string }).openAiApiKey, "[REDACTED]");
    assert.equal((out.nested as { note: string }).note, "fine");
    assert.equal(out.Authorization, "[REDACTED]");
  });

  it("builds zip with JSON, skips PDF/PNG, contains no secret literals", async () => {
    const prevCwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "diag-bundle-"));
    try {
      process.chdir(root);
      const caseId = `case-diag-${Date.now()}`;
      const { job } = findOrCreateUnifiedCollectionJob({
        caseId,
        requestedBy: "smoke",
      });
      const jobId = job.unifiedJobId;

      writeUnifiedArtifact(caseId, jobId, "report-quality-summary.json", {
        version: "report-quality-summary-v1",
        apiKey: "SHOULD_NOT_LEAK",
        counts: { compositeObservations: 3 },
      });
      writeUnifiedArtifact(caseId, jobId, "composite-serp-observations.json", {
        observations: [{ key: "k1", title: "Hello" }],
      });
      // Binaries must be skipped.
      const jobDir = join(root, "storage", "digital-profile", "unified-orion-collection", caseId, jobId);
      writeFileSync(join(jobDir, "report.pdf"), "%PDF-1.4 fake");
      writeFileSync(join(jobDir, "page.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      mkdirSync(join(jobDir, "analytics"), { recursive: true });
      writeFileSync(
        join(jobDir, "analytics", "notes.txt"),
        "token=Bearer sk-abcdef and OPENAI_API_KEY=sk-zzz\n"
      );

      const bundle = await buildUnifiedDiagnosticsBundle({ caseId, jobId });
      assert.ok(bundle.zipBuffer.length > 40);
      assert.match(bundle.fileName, /^diagnostics-.*\.zip$/);

      const zip = await JSZip.loadAsync(bundle.zipBuffer);
      const names = Object.keys(zip.files).filter((n) => !zip.files[n]?.dir);
      assert.ok(names.includes("report-quality-summary.json"));
      assert.ok(names.includes("composite-serp-observations.json"));
      assert.ok(names.includes("analytics/notes.txt"));
      assert.ok(names.includes("bundle-manifest.json"));
      assert.ok(!names.some((n) => n.endsWith(".pdf") || n.endsWith(".png")));

      const quality = await zip.file("report-quality-summary.json")!.async("string");
      assert.ok(!/SHOULD_NOT_LEAK/.test(quality));
      assert.match(quality, /\[REDACTED\]/);

      const notes = await zip.file("analytics/notes.txt")!.async("string");
      assert.ok(!/sk-abcdef|sk-zzz/i.test(notes));
      assert.match(notes, /\[REDACTED\]|Bearer \[REDACTED\]/i);

      const allText = (
        await Promise.all(names.map(async (n) => zip.file(n)!.async("string")))
      ).join("\n");
      assert.ok(!/sk-live|OPENAI_API_KEY=sk-|apiKey":\s*"SHOULD/i.test(allText));

      deleteUnifiedCollectionJobForTests(caseId);
    } finally {
      process.chdir(prevCwd);
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("route + panel wiring exist", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join: j } = await import("node:path");
    const src = j(process.cwd(), "src");
    assert.ok(
      existsSync(
        j(src, "app/api/digital-profile/cases/[id]/unified-collection/diagnostics-bundle/route.ts")
      )
    );
    const panel = readFileSync(
      j(src, "modules/digital-profile/client/ReportQualityPanel.tsx"),
      "utf8"
    );
    assert.match(panel, /diagnostics-bundle-download/);
    assert.match(panel, /Скачать diagnostics bundle/);
  });
});
