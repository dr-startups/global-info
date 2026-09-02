/**
 * Отказ сборки доезжает до оператора сам, а не под видом отказа рендерера.
 *
 * Живой прогон 20.08 (кейс Прохоров): ворота отказали обязательной секции,
 * сборка остановилась, дека вышла пустой — 0 слайдов, `pageCount: 0`. Пустой
 * манифест уехал в мерный прогон, и рендерер законно ответил 500
 * «deckManifest.finalSlides is empty». Оператор прочитал четвёртое звено
 * цепочки: ни кода сборки, ни имени отказавшей секции.
 *
 * Проверка сборки в подготовке была и до этого (`acceptAssembledDeck`), но
 * стоит она **после** цикла меры, а цикл живёт внутри самой сборки — спросить
 * «собралась ли дека» было некому до того, как её пошли мерить.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDeckInputsFromAnalyticsDir,
  runDeckBuildMeasured,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import { DECK_CONTENT_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/content-version";
import {
  CanonicalPrepareBlockedError,
  runCanonicalReportPrepare,
} from "@/modules/digital-profile/services/canonical-report-prepare";
import type { BulletMeasureAdapter } from "@/modules/digital-profile/orion-golden/deck-sections/measured-bullet-fit";
import { runTinyAnalytics, tinyPrepareInput } from "../fixtures/tiny-canonical-prepare";

/** Дословный отказ рендерера с живого прогона 20.08. */
const LIVE_MEASURE_500 =
  'HTTP renderer measure failed (500): {"detail":"ORION Golden measure failed: ' +
  'deckManifest.finalSlides is empty"}';

const { failing } = vi.hoisted(() => ({ failing: { on: false } }));

/**
 * Обязательная секция, не прошедшая проверку.
 *
 * Слайд ссылается на доказательство, которого в наборе нет, — секционная
 * проверка отказывает, манифест блокирует сборку, слайдов не остаётся. Живой
 * отказ пришёл от других ворот (противоречие отрицания Википедии), но чинится
 * здесь не причина отказа, а состояние: обязательная секция отказала, и дека
 * пуста.
 */
vi.mock("@/modules/digital-profile/orion-golden/deck-sections/section-builders", async (
  importOriginal
) => {
  const actual =
    await importOriginal<
      typeof import("@/modules/digital-profile/orion-golden/deck-sections/section-builders")
    >();
  return {
    ...actual,
    buildAllSections: (ctx: Parameters<typeof actual.buildAllSections>[0]) => {
      const packs = actual.buildAllSections(ctx);
      if (!failing.on) return packs;
      return packs.map((pack) =>
        pack.fragmentKey === "EXECUTIVE_SUMMARY"
          ? {
              ...pack,
              slides: pack.slides.map((slide, i) =>
                i === 0
                  ? { ...slide, evidenceRefs: [...slide.evidenceRefs, "evidence:absent-ref"] }
                  : slide
              ),
            }
          : pack
      );
    },
  };
});

/** Мера, ведущая себя как рендерер на пустом манифесте. */
function measureThatAnswers500(): { adapter: BulletMeasureAdapter; calls: () => number } {
  let calls = 0;
  return {
    adapter: async () => {
      calls += 1;
      throw new Error(LIVE_MEASURE_500);
    },
    calls: () => calls,
  };
}

/** Сборка корпуса tiny под данной мерой: результат и каталог артефактов деки. */
async function tinyMeasuredBuild(
  measure: BulletMeasureAdapter,
  prefix: string
): Promise<{ result: Awaited<ReturnType<typeof runDeckBuildMeasured>>; deckRoot: string }> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const analyticsDir = join(root, "analytics");
  await runTinyAnalytics(analyticsDir);
  const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir);
  const deckRoot = join(root, "deck");
  const result = await runDeckBuildMeasured({
    ctx: {
      caseId: inputs.caseId,
      reportRunId: inputs.reportRunId,
      sourceDatasetId: inputs.sourceDatasetId,
      contentVersion: DECK_CONTENT_VERSION,
      subject: { displayName: "Anders Holmström", aliases: [] },
      bundle: inputs.mergedBundle,
      surfaceUnits: inputs.surfaceUnits,
      metricSnapshot: inputs.metricSnapshot,
      evidenceIndex: inputs.evidenceIndex,
      extras: {
        executiveSummary: inputs.executiveSummary as never,
        surfaceCollectionHints: inputs.surfaceCollectionHints,
        complianceScreenings: inputs.complianceScreenings,
        visualAssets: {},
      },
    },
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot: deckRoot,
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
    subjectName: "Anders Holmström",
    measure,
  });
  return { result, deckRoot };
}

beforeEach(() => {
  failing.on = false;
});

describe("несобравшаяся дека не подменяется отказом рендерера", () => {
  it("мерный прогон не запускается на деке, которая не собралась", async () => {
    const measure = measureThatAnswers500();
    failing.on = true;

    const { result } = await tinyMeasuredBuild(measure.adapter, "assembly-failure-measure-");

    // Мерить нечего: слайдов нет. Спрашивать об этом рендерер — значит
    // получить его отказ вместо своего.
    expect(measure.calls()).toBe(0);
    expect(result.assembly.deckManifest.pageCount).toBe(0);
    expect(result.assembly.errors.join(" ")).toContain("EXECUTIVE/EXECUTIVE_SUMMARY");
  });

  it("артефакт разбора цикла говорит, что меры не было и почему", async () => {
    /*
     * `bullet-fit-report.json` — файл, в который лезут разбираться, когда всё
     * сломалось, и врать ему нельзя тем более. Умолчания отчёта («мера
     * выполнялась и сошлась») на этом пути ложны: рендерера не звали ни разу.
     */
    const measure = measureThatAnswers500();
    failing.on = true;

    const { deckRoot } = await tinyMeasuredBuild(measure.adapter, "assembly-failure-report-");

    const raw = JSON.parse(
      readFileSync(join(deckRoot, "bullet-fit-report.json"), "utf8")
    ) as Record<string, unknown>;
    expect(raw.outcome).toBe("NOT_MEASURED_ASSEMBLY_FAILED");
    expect(raw.iterations).toEqual([]);
    expect(raw.builds).toBe(1);
    // Ответ о сходимости один — исход. Отдельного признака, который здесь
    // значил бы «мера сошлась», в отчёте нет вовсе.
    expect(Object.keys(raw)).not.toContain("converged");
  });

  it("оператор видит код сборки и отказавшую секцию, а не 500 рендерера", async () => {
    const root = mkdtempSync(join(tmpdir(), "assembly-failure-prepare-"));
    const measure = measureThatAnswers500();
    failing.on = true;

    const failure = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, { measureBulletFit: measure.adapter })
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CanonicalPrepareBlockedError);
    const blocked = failure as CanonicalPrepareBlockedError;
    expect(blocked.code).toBe("ASSEMBLY_FAILED");
    expect(blocked.message).toContain("EXECUTIVE/EXECUTIVE_SUMMARY");
    expect(blocked.message).not.toContain("finalSlides is empty");
    expect(measure.calls()).toBe(0);
  });
});
