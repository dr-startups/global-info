/**
 * Файл, который обход увидел, а прочитать не смог, тоже назван.
 *
 * `bundle-manifest.json` обещает полноту: каждый увиденный обходом файл либо в
 * зипе, либо назван в одном из списков пропущенного. Обещание было неправдой —
 * отказ чтения (файл исчез между обходом и чтением, права, сбой диска) уводил
 * файл в `continue`: ни в зип, ни в счётчики, ни в списки. Ровно эта форма
 * молчания уже дала неверный диагноз блокера H3, только на другом счётчике.
 *
 * Отказ чтения не подделаешь под root'ом, поэтому он подставляется на
 * `readFileSync` для одного пути; всё остальное — настоящая файловая система.
 *
 * Офлайн: прогон живёт в файловом хранилище во временном каталоге репозитория.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { buildUnifiedDiagnosticsBundle } from "@/modules/digital-profile/services/unified-diagnostics-bundle";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  unifiedArtifactsDir,
  unifiedJobDir,
} from "@/modules/digital-profile/services/unified-collection-job-store";

/**
 * Имя файла, чтение которого отказывает; всё прочее читается по-настоящему.
 * Через `vi.hoisted`, потому что подмену модуля vitest поднимает выше объявлений.
 */
const { UNREADABLE_BASENAME } = vi.hoisted(() => ({
  UNREADABLE_BASENAME: "vanished-mid-bundle.json",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (String(path).endsWith(UNREADABLE_BASENAME)) {
        const err: NodeJS.ErrnoException = new Error(
          `EACCES: permission denied, open '${String(path)}'`
        );
        err.code = "EACCES";
        throw err;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const CASE = `unit-bundle-unreadable-${Date.now()}`;

type BundleManifest = {
  includedCount: number;
  skippedBinary: string[];
  skippedOversize: Array<{ path: string; sizeBytes: number }>;
  skippedFileCap: string[];
  skippedUnreadable: string[];
  skippedUnreadableCount: number;
};

describe("диагностический бандл и нечитаемый файл", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("нечитаемый файл назван, а не выброшен молча", async () => {
    const { job } = await findOrCreateUnifiedCollectionJob({
      caseId: CASE,
      requestedBy: "unit-tester",
    });
    const artifacts = unifiedArtifactsDir(CASE, job.unifiedJobId);
    mkdirSync(join(artifacts, "analytics"), { recursive: true });
    writeFileSync(join(artifacts, "canonical-prepare-summary.json"), `{"ok":true}`, "utf8");
    writeFileSync(join(artifacts, "analytics", UNREADABLE_BASENAME), `{"a":1}`, "utf8");

    const result = await buildUnifiedDiagnosticsBundle({
      caseId: CASE,
      jobId: job.unifiedJobId,
    });
    const zip = await JSZip.loadAsync(result.zipBuffer);
    const manifest = JSON.parse(
      await zip.file("bundle-manifest.json")!.async("string")
    ) as BundleManifest;

    expect(zip.file(`analytics/${UNREADABLE_BASENAME}`)).toBeNull();
    expect(manifest.skippedUnreadable).toEqual([`analytics/${UNREADABLE_BASENAME}`]);
    expect(manifest.skippedUnreadableCount).toBe(1);
    // Полнота обещана манифестом: два файла обхода плюс внешний job.json.
    const accounted =
      result.includedCount +
      manifest.skippedBinary.length +
      manifest.skippedOversize.length +
      manifest.skippedFileCap.length +
      manifest.skippedUnreadable.length;
    expect(accounted).toBe(3);
  });

  it("на читаемом каталоге список пуст", async () => {
    const { job } = await findOrCreateUnifiedCollectionJob({
      caseId: CASE,
      requestedBy: "unit-tester",
    });
    const artifacts = unifiedArtifactsDir(CASE, job.unifiedJobId);
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "canonical-prepare-summary.json"), `{"ok":true}`, "utf8");

    const result = await buildUnifiedDiagnosticsBundle({
      caseId: CASE,
      jobId: job.unifiedJobId,
    });
    const zip = await JSZip.loadAsync(result.zipBuffer);
    const manifest = JSON.parse(
      await zip.file("bundle-manifest.json")!.async("string")
    ) as BundleManifest;

    expect(manifest.skippedUnreadable).toEqual([]);
    expect(manifest.skippedUnreadableCount).toBe(0);
  });
});
