/**
 * Реплей деки настоящего прогона — офлайн, от артефактов аналитики до суда
 * телеметрии рендерера.
 *
 * Заведён шагом 0056 после прогона DPA-2026-0053: четыре отказа подряд
 * открывались только в проде, каждый — выкатом и получасовой попыткой, и две
 * правки из четырёх были не туда. Дефект деки обязан воспроизводиться на столе.
 *
 * Вход — каталог джобы, снятый с тома (`analytics/`, `visual-assets-by-slot.json`,
 * `report-assets.json`). В репозиторий такие каталоги не идут: там материалы по
 * делам живых людей. Стадий модели здесь нет: пакеты строятся детерминированно,
 * а `gpt-case-analysis.json` прогона подаётся как есть.
 *
 *   npx tsx scripts/replay-deck-from-job.ts <каталог-джобы> [--out <каталог>]
 *
 * Код возврата 1 — сборка отвергнута, обязательная секция упала, ворота сборки
 * заблокировали или рендерер потерял содержимое. Всё названо словами.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pythonInterpreter } from "./lib/python";
import {
  loadDeckInputsFromAnalyticsDir,
  runDeckBuildMeasured,
  toRendererPayload,
  type RendererAssetEntry,
  type VisualAssetsBySlot,
} from "../src/modules/digital-profile/orion-golden/deck-sections";
import { createLocalPythonMeasureAdapter } from "../src/modules/digital-profile/services/render-deck-artifacts";
import { DECK_CONTENT_VERSION } from "../src/modules/digital-profile/orion-golden/deck-sections/content-version";
import { judgeRenderTelemetry, compliancePagesOf } from "../src/modules/digital-profile/services/render-telemetry-gate";
import type { ExecutiveSummaryExtras } from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ComposedClientSummary } from "../src/modules/digital-profile/orion-golden/contracts/composed-client-summary";
import type { ReportDeckManifest } from "../src/modules/digital-profile/orion-golden/deck-sections/contracts";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export type DeckReplayVerdict = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  pages: number;
  outDir: string;
};

/** Собрать и отрисовать деку прогона; ответ — словами, без исключений. */
export async function replayDeckFromJob(jobDir: string, outDir: string): Promise<DeckReplayVerdict> {
  const analyticsDir = join(jobDir, "analytics");
  const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir);
  const visualAssets = readJson<{ visualAssets: VisualAssetsBySlot }>(
    join(jobDir, "visual-assets-by-slot.json")
  ).visualAssets;
  const rawAssets = readJson<RendererAssetEntry[] | { assets: RendererAssetEntry[] }>(
    join(jobDir, "report-assets.json")
  );
  const assets = Array.isArray(rawAssets) ? rawAssets : rawAssets.assets;
  const caseAnalysisPath = join(analyticsDir, "gpt-case-analysis.json");
  const gptCaseAnalysis = existsSync(caseAnalysisPath)
    ? readJson<Record<string, unknown>>(caseAnalysisPath)
    : undefined;
  const subjectName = String(
    (inputs.executiveSummary as { subjectName?: string }).subjectName ??
      (readJson<{ subjectName?: string }>(join(analyticsDir, "report-data-binding.json")).subjectName ??
        inputs.caseId)
  );

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const blockers: string[] = [];
  const warnings: string[] = [];

  const result = await runDeckBuildMeasured({
    ctx: {
      caseId: inputs.caseId,
      reportRunId: inputs.reportRunId,
      sourceDatasetId: inputs.sourceDatasetId,
      contentVersion: DECK_CONTENT_VERSION,
      subject: { displayName: subjectName, aliases: [], anchors: inputs.subjectAnchors },
      bundle: inputs.mergedBundle,
      surfaceUnits: inputs.surfaceUnits,
      metricSnapshot: inputs.metricSnapshot,
      evidenceIndex: inputs.evidenceIndex,
      extras: {
        executiveSummary: inputs.executiveSummary as unknown as ExecutiveSummaryExtras,
        composedClientSummary:
          (inputs.composedClientSummary as unknown as ComposedClientSummary) ?? undefined,
        surfaceCollectionHints: inputs.surfaceCollectionHints,
        complianceScreenings: inputs.complianceScreenings,
        personaDecision: inputs.personaDecision ?? undefined,
        uncategorizedMaterials: (inputs.uncategorizedMaterials as never) ?? undefined,
        gptCaseAnalysis: gptCaseAnalysis as never,
        visualAssets,
      },
    },
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot: outDir,
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
    serpObservations: inputs.serpObservations,
    subjectName,
    assets,
    measure: createLocalPythonMeasureAdapter(pythonInterpreter()),
  });

  for (const e of result.assembly.errors) blockers.push(`сборка: ${e}`);
  for (const f of result.manifest.requiredSectionsFailed) blockers.push(`обязательная секция: ${f}`);
  for (const b of result.assemblyValidation?.blocking ?? []) blockers.push(`ворота сборки: ${b}`);
  for (const p of result.packs) {
    if (!p.validation.passed) {
      for (const issue of p.validation.issues.slice(0, 5)) warnings.push(`секция ${p.fragmentKey}: ${issue}`);
    }
  }
  if (result.bulletFit.outcome !== "CONVERGED") {
    warnings.push(`мера буллетов: ${result.bulletFit.outcome}`);
  }
  if (blockers.length > 0) {
    return { ok: false, blockers, warnings, pages: 0, outDir };
  }

  const payload = toRendererPayload({
    deckManifest: result.assembly.deckManifest,
    rendererSlides: result.assembly.rendererSlides,
    subjectName,
    assets,
  });
  const payloadPath = join(outDir, "render-payload.json");
  writeFileSync(payloadPath, JSON.stringify(payload), "utf8");
  const pagesDir = join(outDir, "pages-png");
  execFileSync(
    pythonInterpreter(),
    [
      "scripts/render-orion-golden-artifacts.py",
      payloadPath,
      join(outDir, "rendered-client.pptx"),
      join(outDir, "rendered-client.pdf"),
      pagesDir,
    ],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, stdio: "pipe" }
  );
  const manifest = readJson<ReportDeckManifest>(join(outDir, "report-deck-manifest.json"));
  const verdict = judgeRenderTelemetry(outDir, { compliancePages: compliancePagesOf(manifest) });
  if (verdict.blocker) blockers.push(`рендер: ${verdict.blocker} — ${verdict.detail}`);
  warnings.push(...verdict.warnings.map((w) => `рендер: ${w}`));
  const meta = readJson<{ warnings?: string[]; slideCount?: number }>(join(outDir, "golden-render-meta.json"));
  for (const w of meta.warnings ?? []) if (w.startsWith("sidebar-qa")) warnings.push(`рендер: ${w}`);

  return { ok: blockers.length === 0, blockers, warnings, pages: Number(meta.slideCount ?? 0), outDir };
}

async function main(): Promise<void> {
  const [jobDirArg, ...rest] = process.argv.slice(2);
  if (!jobDirArg) {
    console.error("usage: replay-deck-from-job.ts <каталог-джобы> [--out <каталог>]");
    process.exit(2);
  }
  const jobDir = resolve(jobDirArg);
  const outFlag = rest.indexOf("--out");
  const outDir = resolve(outFlag >= 0 && rest[outFlag + 1] ? rest[outFlag + 1]! : join(jobDir, "replay-out"));
  const verdict = await replayDeckFromJob(jobDir, outDir);
  console.log(`страниц: ${verdict.pages}; каталог: ${verdict.outDir}`);
  for (const w of verdict.warnings) console.log(`  предупреждение: ${w}`);
  for (const b of verdict.blockers) console.log(`  БЛОКЕР: ${b}`);
  console.log(verdict.ok ? "РЕПЛЕЙ: отчёт собран и отрисован без потерь" : "РЕПЛЕЙ: отчёт не выдан");
  process.exitCode = verdict.ok ? 0 : 1;
}

const isDirectRun = process.argv[1]?.replace(/\\/gu, "/").endsWith("replay-deck-from-job.ts");
if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
