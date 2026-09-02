/**
 * Диагностический бандл называет пропущенное поимённо.
 *
 * Молчаливый счётчик уже стоил неверного диагноза: по `skippedOversizeCount ≥ 2`
 * разбор живого прогона решил, что телеметрию рендерера «срезал лимит 2 МБ», —
 * хотя файла на живом пути не было вовсе. Счётчик не отвечает на вопрос «чего
 * в бандле нет», а имя отвечает.
 *
 * Лимит при этом остаётся: он защищает поддержку от base64-вложений в JSON
 * (`render-payload.json`, `report-assets.json` — около 3 МБ, почти целиком
 * картинки). Телеметрия проходит общими правилами — она весит десятки КБ.
 *
 * Офлайн: прогон живёт в файловом хранилище во временном каталоге репозитория.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const CASE = `unit-bundle-${Date.now()}`;

type BundleManifest = {
  version: string;
  includedCount: number;
  skippedBinaryCount: number;
  skippedOversizeCount: number;
  skippedOversize: Array<{ path: string; sizeBytes: number }>;
  skippedBinary: string[];
  skippedFileCap: string[];
  fileCapReached: boolean;
};

async function jobDirs(): Promise<{ jobId: string; artifacts: string }> {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const artifacts = unifiedArtifactsDir(CASE, job.unifiedJobId);
  mkdirSync(artifacts, { recursive: true });
  return { jobId: job.unifiedJobId, artifacts };
}

function writeFile(root: string, rel: string, body: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

/** Телеметрия живого прогона: десятки записей, десятки килобайт. */
function telemetryEntries(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    page: i + 1,
    name: `orion_text_body_p${i + 1}`,
    role: "text",
    fontFamily: "Inter",
    fontSizePt: 11,
    boxWidth: 10_744_320,
    boxHeight: 237_815,
    availableHeight: 1_100_000,
    requiredHeight: 197_815,
    measuredLines: 1,
    textLength: 34,
    clipped: false,
    measurementUncertain: false,
  }));
}

async function buildAndRead(jobId: string): Promise<{
  zip: JSZip;
  manifest: BundleManifest;
  result: Awaited<ReturnType<typeof buildUnifiedDiagnosticsBundle>>;
}> {
  const result = await buildUnifiedDiagnosticsBundle({ caseId: CASE, jobId });
  const zip = await JSZip.loadAsync(result.zipBuffer);
  const manifest = JSON.parse(
    await zip.file("bundle-manifest.json")!.async("string")
  ) as BundleManifest;
  return { zip, manifest, result };
}

describe("диагностический бандл", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("файл сверх лимита назван по имени и размеру, а не только сосчитан", async () => {
    const { jobId, artifacts } = await jobDirs();
    const fat = `{"assets":"${"A".repeat(2_100_000)}"}`;
    writeFile(artifacts, "report-assets.json", fat);
    writeFile(artifacts, join("render", "render-payload.json"), fat);
    writeFile(artifacts, "canonical-prepare-summary.json", `{"ok":true}`);

    const { zip, manifest } = await buildAndRead(jobId);

    expect(zip.file("report-assets.json")).toBeNull();
    expect(zip.file("render/render-payload.json")).toBeNull();
    expect(manifest.version).toBe("unified-diagnostics-bundle-v2");
    expect(manifest.skippedOversize.map((f) => f.path)).toEqual([
      "render/render-payload.json",
      "report-assets.json",
    ]);
    expect(manifest.skippedOversize.every((f) => f.sizeBytes > 2_000_000)).toBe(true);
    expect(manifest.skippedOversizeCount).toBe(manifest.skippedOversize.length);
    expect(manifest.fileCapReached).toBe(false);
  });

  it("пропущенные двоичные файлы тоже названы и отсортированы", async () => {
    const { jobId, artifacts } = await jobDirs();
    writeFile(artifacts, "rendered-client.pdf", "%PDF-1.4");
    writeFile(artifacts, join("pages-png", "page-01.png"), "PNG");
    writeFile(artifacts, "canonical-prepare-summary.json", `{"ok":true}`);

    const { manifest } = await buildAndRead(jobId);

    expect(manifest.skippedBinary).toEqual(["pages-png/page-01.png", "rendered-client.pdf"]);
    expect(manifest.skippedBinaryCount).toBe(manifest.skippedBinary.length);
  });

  it("телеметрия рендерера типового размера входит в бандл целиком", async () => {
    const { jobId, artifacts } = await jobDirs();
    const entries = telemetryEntries(60);
    writeFile(
      artifacts,
      join("render", "layout-telemetry.json"),
      JSON.stringify({ version: "orion-layout-telemetry-v1", entries }, null, 2)
    );

    const { zip, manifest } = await buildAndRead(jobId);

    const inZip = zip.file("render/layout-telemetry.json");
    expect(inZip).not.toBeNull();
    const parsed = JSON.parse(await inZip!.async("string")) as {
      version: string;
      entries: unknown[];
    };
    expect(parsed.version).toBe("orion-layout-telemetry-v1");
    expect(parsed.entries).toEqual(entries);
    expect(manifest.skippedOversize).toEqual([]);
  });

  it("достигнутый потолок числа файлов слышен", async () => {
    // Потолок бандла — 400 файлов; при 420 часть не попадёт, и манифест обязан
    // об этом сказать, иначе неполный бандл неотличим от полного.
    const { jobId, artifacts } = await jobDirs();
    for (let i = 0; i < 420; i += 1) {
      writeFile(artifacts, `artifact-${String(i).padStart(3, "0")}.json`, `{"i":${i}}`);
    }

    const { manifest } = await buildAndRead(jobId);

    expect(manifest.fileCapReached).toBe(true);
  });

  it("не вошедшее из-за потолка названо, а не потеряно", async () => {
    // Ради этого шаг и заводил манифест: счётчик, который не отвечает, чего в
    // бандле нет. `break` по потолку молча выбрасывал остаток обхода — ни в
    // зип, ни в списки пропущенного.
    const { jobId, artifacts } = await jobDirs();
    for (let i = 0; i < 405; i += 1) {
      writeFile(artifacts, `artifact-${String(i).padStart(3, "0")}.json`, `{"i":${i}}`);
    }

    const { manifest, result } = await buildAndRead(jobId);

    expect(manifest.skippedFileCap.length).toBe(5);
    expect([...manifest.skippedFileCap].sort()).toEqual(manifest.skippedFileCap);
    expect(manifest.skippedFileCap.length + result.includedCount).toBe(406);
    expect(manifest.fileCapReached).toBe(true);
  });

  it("за потолком ничего не исчезает бесследно", async () => {
    // Свойство не зависит от порядка обхода: каждый увиденный файл либо в
    // зипе, либо назван в одном из списков пропущенного.
    const { jobId, artifacts } = await jobDirs();
    for (let i = 0; i < 402; i += 1) {
      writeFile(artifacts, `artifact-${String(i).padStart(3, "0")}.json`, `{"i":${i}}`);
    }
    writeFile(artifacts, "zz-late.png", "PNG");
    writeFile(artifacts, "zz-late-fat.json", `{"a":"${"A".repeat(2_100_000)}"}`);

    const { manifest, result } = await buildAndRead(jobId);

    const accounted =
      result.includedCount +
      manifest.skippedBinary.length +
      manifest.skippedOversize.length +
      manifest.skippedFileCap.length;
    // 404 файла обхода плюс внешний job.json.
    expect(accounted).toBe(405);
    expect(manifest.skippedBinary).toContain("zz-late.png");
    expect(manifest.skippedOversize.map((f) => f.path)).toContain("zz-late-fat.json");
    expect(manifest.skippedBinaryCount).toBe(manifest.skippedBinary.length);
    expect(manifest.skippedOversizeCount).toBe(manifest.skippedOversize.length);
  });

  it("ровно потолок — это не переполнение", async () => {
    // `job.json` лежит вне корня обхода и включается всегда; занимать место в
    // бюджете обхода он не должен, иначе потолок значит две разные вещи.
    const { jobId, artifacts } = await jobDirs();
    for (let i = 0; i < 400; i += 1) {
      writeFile(artifacts, `artifact-${String(i).padStart(3, "0")}.json`, `{"i":${i}}`);
    }

    const { manifest } = await buildAndRead(jobId);

    expect(manifest.skippedFileCap).toEqual([]);
    expect(manifest.fileCapReached).toBe(false);
  });
});
