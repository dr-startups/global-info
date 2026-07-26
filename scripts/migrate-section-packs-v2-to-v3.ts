/**
 * OFFLINE-ONLY migration: legacy v2 SectionPacks -> self-contained v3.
 *
 * Production build/assembly accept ONLY v3 self-contained packs. This one-shot
 * tool exists solely to upgrade already-persisted legacy packs and is guarded
 * by an explicit `--allow-legacy-packs` flag that is never wired into any
 * production runtime path.
 *
 * Lineage safety (fail-closed): a legacy pack is migrated only when it proves
 * it belongs to the owning report-section-manifest.json —
 *   - pack.reportRunId   === manifest.reportRunId
 *   - pack.sourceDatasetId === manifest.sourceDatasetId
 *   - recomputed content hash === pack.contentHash
 *   - the manifest entry for the fragment exists and its contentHash matches
 * Any mismatch REJECTS the pack (it is left untouched, reported as an error).
 * On success we backfill caseId (from the manifest) + datasetId +
 * sourceFindingIds/evidenceRefs, re-stamp schemaVersion v3, recompute the
 * content hash and write a complete v3 pack.
 *
 * Usage:
 *   npx tsx scripts/migrate-section-packs-v2-to-v3.ts --allow-legacy-packs <deckOutputRoot>
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRAGMENT_ARTIFACT_PATHS,
  LegacySectionPackV2Schema,
  ReportSectionManifestSchema,
  SECTION_PACK_SCHEMA_VERSION,
  SectionPackV2Schema,
  type LegacySectionPackV2,
  type SectionPackV2,
} from "../src/modules/digital-profile/orion-golden/deck-sections";

function contentHashOf(slides: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(slides)).digest("hex")}`;
}

type MigrationOutcome = {
  fragmentKey: string;
  path: string;
  result: "MIGRATED" | "ALREADY_V3" | "REJECTED";
  reason?: string;
};

function migratePack(input: {
  legacy: LegacySectionPackV2;
  manifest: {
    caseId: string;
    reportRunId: string;
    sourceDatasetId: string;
    entries: Array<{ fragmentKey: string; contentHash: string }>;
  };
}): { pack?: SectionPackV2; reject?: string } {
  const { legacy, manifest } = input;

  if (legacy.reportRunId !== manifest.reportRunId) {
    return { reject: `foreign reportRunId ${legacy.reportRunId} != ${manifest.reportRunId}` };
  }
  if (legacy.sourceDatasetId !== manifest.sourceDatasetId) {
    return { reject: `stale sourceDatasetId ${legacy.sourceDatasetId} != ${manifest.sourceDatasetId}` };
  }
  const recomputed = contentHashOf(legacy.slides);
  if (recomputed !== legacy.contentHash) {
    return { reject: `content hash mismatch (tampered): ${legacy.contentHash} != ${recomputed}` };
  }
  const entry = manifest.entries.find((e) => e.fragmentKey === legacy.fragmentKey);
  if (!entry) {
    return { reject: `no owning manifest entry for ${legacy.fragmentKey}` };
  }
  if (entry.contentHash !== legacy.contentHash) {
    return { reject: `manifest entry hash mismatch for ${legacy.fragmentKey}` };
  }

  const migrated: SectionPackV2 = {
    ...legacy,
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    caseId: manifest.caseId,
    datasetId: legacy.sourceDatasetId,
    sourceFindingIds: [...legacy.inputs.findingIds],
    evidenceRefs: [...legacy.inputs.evidenceRefs],
    // Re-stamp the content hash from the (unchanged) slides for a complete pack.
    contentHash: recomputed,
  };
  const parsed = SectionPackV2Schema.safeParse(migrated);
  if (!parsed.success) {
    return { reject: `migrated pack failed v3 schema: ${parsed.error.issues[0]?.message}` };
  }
  return { pack: parsed.data };
}

function main(): void {
  const args = process.argv.slice(2);
  if (!args.includes("--allow-legacy-packs")) {
    console.error(
      "refusing to run without --allow-legacy-packs (offline migration only; never available in production runtime)"
    );
    process.exit(2);
  }
  const outputRoot = args.find((a) => !a.startsWith("--"));
  if (!outputRoot) {
    console.error("usage: migrate-section-packs-v2-to-v3.ts --allow-legacy-packs <deckOutputRoot>");
    process.exit(2);
  }

  const manifestPath = join(outputRoot, "report-section-manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`owning manifest not found: ${manifestPath}`);
    process.exit(2);
  }
  const manifest = ReportSectionManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8"))
  );

  const outcomes: MigrationOutcome[] = [];
  for (const [key, rel] of Object.entries(FRAGMENT_ARTIFACT_PATHS)) {
    const path = join(outputRoot, rel);
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, "utf8"));

    if (SectionPackV2Schema.safeParse(raw).success) {
      outcomes.push({ fragmentKey: key, path, result: "ALREADY_V3" });
      continue;
    }
    const legacy = LegacySectionPackV2Schema.safeParse(raw);
    if (!legacy.success) {
      outcomes.push({
        fragmentKey: key,
        path,
        result: "REJECTED",
        reason: `not a recognizable v2 or v3 pack: ${legacy.error.issues[0]?.message}`,
      });
      continue;
    }
    const { pack, reject } = migratePack({ legacy: legacy.data, manifest });
    if (reject || !pack) {
      outcomes.push({ fragmentKey: key, path, result: "REJECTED", reason: reject });
      continue;
    }
    writeFileSync(path, JSON.stringify(pack, null, 2), "utf8");
    outcomes.push({ fragmentKey: key, path, result: "MIGRATED" });
  }

  const migrated = outcomes.filter((o) => o.result === "MIGRATED").length;
  const already = outcomes.filter((o) => o.result === "ALREADY_V3").length;
  const rejected = outcomes.filter((o) => o.result === "REJECTED");
  console.log(JSON.stringify({ migrated, already, rejected: rejected.length, outcomes }, null, 2));
  if (rejected.length > 0) {
    console.error(`REJECTED ${rejected.length} pack(s) — see reasons above (fail-closed).`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();

export { migratePack };
