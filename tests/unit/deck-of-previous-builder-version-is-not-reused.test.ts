/**
 * Дека, собранная построителем прежней версии, повторно не рендерится.
 *
 * Живой прогон 19.08 остановлен воротами `CONTENT_DROPPED_BY_RENDERER`. Ровно
 * на этот код ошибки восстановление предлагает кнопку «Повторить рендер», и до
 * этого шага она переиспользовала бы **ту же переполненную деку** и приводила
 * бы к тому же блокеру бесконечно. Дека — продукт построителя, а построитель
 * версионирован; значит, годность деки зависит и от версии.
 *
 * Отсутствие поля версии — тоже отказ, и намеренно: все деки, собранные до
 * этого шага (включая деку Мордашова), поля не несут и реюзу не подлежат по
 * построению. Отказ слышимый: причина доезжает до предупреждений попытки, и
 * прогон честно падает в полную пересборку.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadReusableAssembledDeck,
  runCanonicalReportPrepare,
} from "@/modules/digital-profile/services/canonical-report-prepare";
import { DECK_CONTENT_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/content-version";
import type { GptJsonCaller } from "@/modules/digital-profile/orion-golden/gpt/gpt-case-analysis";
import {
  CLEAN_TELEMETRY_ENTRY,
  renderAdapterWithTelemetry,
  seedAssembledDeckDir,
  tinyPrepareInput,
} from "../fixtures/tiny-canonical-prepare";

function manifestPath(root: string): string {
  return join(root, "deck", "report-deck-manifest.json");
}

function patchManifest(root: string, fields: Record<string, unknown>): void {
  const current = JSON.parse(readFileSync(manifestPath(root), "utf8")) as Record<string, unknown>;
  const patched = { ...current, ...fields };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete patched[key];
  }
  writeFileSync(manifestPath(root), JSON.stringify(patched, null, 2), "utf8");
}

async function seedDeck(): Promise<{ root: string; caseId: string; datasetId: string }> {
  const root = mkdtempSync(join(tmpdir(), "deck-version-reuse-"));
  const ids = await seedAssembledDeckDir({ artifactsDir: root });
  return { root, ...ids };
}

function load(seeded: { root: string; caseId: string; datasetId: string }) {
  return loadReusableAssembledDeck({
    artifactsDir: seeded.root,
    caseId: seeded.caseId,
    expectedDatasetId: seeded.datasetId,
  });
}

describe("реюз собранной деки сверяет версию построителя", () => {
  it("сборка пишет версию содержимого в манифест деки", async () => {
    const seeded = await seedDeck();
    const manifest = JSON.parse(readFileSync(manifestPath(seeded.root), "utf8")) as {
      contentVersion?: string;
    };
    expect(manifest.contentVersion).toBe(DECK_CONTENT_VERSION);
  });

  it("дека текущей версии реюзится как прежде", async () => {
    const seeded = await seedDeck();
    const res = load(seeded);
    expect(res.refusedReason).toBeNull();
    expect(res.reused?.datasetId).toBe(seeded.datasetId);
  });

  it("дека прежней версии построителя получает названный отказ", async () => {
    const seeded = await seedDeck();
    patchManifest(seeded.root, { contentVersion: "deck-sections-v95" });
    const res = load(seeded);
    expect(res.reused).toBeNull();
    expect(res.refusedReason).toBe("stale-content-version");
  });

  it("дека без поля версии — все деки до этого шага — тоже отказ", async () => {
    const seeded = await seedDeck();
    patchManifest(seeded.root, { contentVersion: undefined });
    const res = load(seeded);
    expect(res.reused).toBeNull();
    expect(res.refusedReason).toBe("stale-content-version");
  });

  it("причина отказа доезжает до предупреждений попытки", async () => {
    const root = mkdtempSync(join(tmpdir(), "deck-version-resume-"));
    const gpt: GptJsonCaller = async () => ({});
    const seed = renderAdapterWithTelemetry([CLEAN_TELEMETRY_ENTRY]);
    const first = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, { render: seed.adapter, gptCaller: gpt })
    );
    expect(first.ok).toBe(true);
    // Дека собрана построителем прошлой версии — ровно состояние прогона,
    // который сегодня уходит на «Повторить рендер».
    patchManifest(root, { contentVersion: "deck-sections-v1" });

    const resume = renderAdapterWithTelemetry([CLEAN_TELEMETRY_ENTRY]);
    const res = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, {
        render: resume.adapter,
        gptCaller: gpt,
        resumeFrom: "render",
      })
    );
    expect(res.qualityWarnings ?? []).toContain(
      "render-resume-reassembly:stale-content-version"
    );
    // Отказ слышимый и ведёт в полную пересборку, а не в повторный рендер той
    // же деки.
    expect(res.assemblyCount).toBe(1);
  });
});
