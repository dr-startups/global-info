/**
 * Цикл «сборка → мера → перекладка → пересборка» сходится сам и молча не сдаётся.
 *
 * Ёмкость страницы знает только код отрисовки рендерера. Построитель перестал
 * её пересказывать числами и спрашивает мерным прогоном: пока вердикт говорит о
 * потере, дека пересобирается по измеренным высотам. Пересборка идёт на готовых
 * паках — ни одного вызова модели, — а не сошедшийся за отведённые итерации
 * цикл останавливает прогон тем же кодом, которым сегодня останавливают ворота.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDeckInputsFromAnalyticsDir,
  runDeckBuildMeasured,
  BulletFitNotConvergedError,
  type BulletMeasureAdapter,
  type BulletMeasureVerdict,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import { DECK_CONTENT_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/content-version";
import { runDeckBuildWithGptCopy } from "@/modules/digital-profile/orion-golden/deck-sections/gpt-enhanced-deck-build";
import type { GptJsonCaller } from "@/modules/digital-profile/orion-golden/gpt/gpt-case-analysis";
import { loadReport72DeckInputs } from "../../scripts/run-orion-deck-sections-report72";
import { runTinyAnalytics } from "../fixtures/tiny-canonical-prepare";

type PayloadSlide = {
  slideKey: string;
  bullets?: string[];
  keyFindings?: Array<{ detail?: string }>;
};

function slidesOf(payload: Record<string, unknown>): PayloadSlide[] {
  return (payload.deckManifest as { finalSlides: PayloadSlide[] }).finalSlides;
}

/** Мера, которая ничего не теряет: цикл обязан завершиться первой итерацией. */
const cleanMeasure = (payload: Record<string, unknown>): BulletMeasureVerdict => ({
  version: "orion-bullet-measure-v1",
  pages: slidesOf(payload)
    .filter((s) => (s.bullets ?? s.keyFindings ?? []).length > 0)
    .map((s, i) => {
      const items = s.keyFindings ? s.keyFindings.map((f) => String(f.detail ?? "")) : s.bullets ?? [];
      return {
        slideKey: s.slideKey,
        page: i + 1,
        availableHeight: 4_000_000,
        maxItems: 9,
        itemHeights: items.map(() => 100_000),
        keptItems: items.length,
        droppedBullets: 0,
        droppedLines: 0,
      };
    }),
});

/** Вход сборки на корпусе tiny — общий для прямого вызова и вызова через GPT-слой. */
async function tinyBuildInput(): Promise<{
  ctx: Record<string, unknown>;
  rest: Record<string, unknown>;
}> {
  const root = mkdtempSync(join(tmpdir(), "measured-deck-"));
  const analyticsDir = join(root, "analytics");
  await runTinyAnalytics(analyticsDir);
  const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir);
  return {
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
    rest: {
      bundleForValidation: inputs.mergedBundle,
      knownEvidenceRefs: inputs.knownEvidenceRefs,
      outputRoot: join(root, "deck"),
      baseObservationCountBefore: inputs.baseCountBefore,
      baseObservationCountAfter: inputs.baseCountAfter,
      subjectName: "Anders Holmström",
    },
  };
}

/** Сборка через слой GPT — им же считаются вызовы модели внутри цикла. */
async function tinyDeckBuildWithGpt(input: {
  measure: BulletMeasureAdapter;
  caller: GptJsonCaller;
}) {
  const { ctx, rest } = await tinyBuildInput();
  return runDeckBuildWithGptCopy({
    ...rest,
    ctx,
    gpt: { caller: input.caller, caseAnalysis: null },
    measure: input.measure,
  } as unknown as Parameters<typeof runDeckBuildWithGptCopy>[0]);
}

async function tinyDeckBuildLegacy(input: {
  measure: BulletMeasureAdapter | null;
  maxIterations?: number;
}) {
  const root = mkdtempSync(join(tmpdir(), "measured-deck-"));
  const analyticsDir = join(root, "analytics");
  await runTinyAnalytics(analyticsDir);
  const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir);
  return runDeckBuildMeasured({
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
    outputRoot: join(root, "deck"),
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
    subjectName: "Anders Holmström",
    measure: input.measure,
    maxIterations: input.maxIterations,
  });
}

const tinyDeckBuild = tinyDeckBuildLegacy;

/**
 * Шаблоны, чей список рисует `ctx.bullets`, — только по ним рендерер и
 * отчитывается мерой. Стаб, меряющий что-то ещё, проверял бы выдуманный путь.
 */
function drawsBulletList(template: string): boolean {
  return [
    "orion_golden_executive_dashboard",
    "orion_golden_metrics_dashboard",
    "orion_golden_executive_card",
    "orion_golden_surface_panel",
    "orion_golden_prose",
    "orion_golden_audit_dashboard",
  ].includes(template);
}

/**
 * Мера, пускающая на лист ровно два элемента списка.
 *
 * Два, а не один: элементом списка бывает и вклейка страницы — вводный абзац
 * или ссылка на источник, — и при ёмкости в один элемент страница со ссылкой
 * не вместила бы ни одного блока ни при какой перекладке. Это был бы законный
 * отказ цикла, а проверяется здесь сходимость.
 */
function twoPerPage(payload: Record<string, unknown>): BulletMeasureVerdict {
  return {
    version: "orion-bullet-measure-v1",
    pages: slidesOf(payload)
      .filter((s) => drawsBulletList(String((s as { template?: string }).template ?? "")))
      .map((s, i) => {
        const items = s.keyFindings
          ? s.keyFindings.map((f) => String(f.detail ?? ""))
          : s.bullets ?? [];
        return {
          slideKey: s.slideKey,
          page: i + 1,
          availableHeight: 200_000,
          maxItems: 9,
          itemHeights: items.map(() => 100_000),
          keptItems: Math.min(2, items.length),
          droppedBullets: Math.max(0, items.length - 2),
          droppedLines: 0,
        };
      })
      .filter((p) => p.itemHeights.length > 0),
  };
}

/**
 * Списки буллетов по слотам — то, что перекладка обязана сохранить дословно.
 *
 * Оглавление не в счёт: его строки печатает сборщик по итоговым номерам
 * страниц, и они обязаны измениться вместе с составом деки.
 *
 * Перекладку оглавление при этом не задевает вовсе, и держится это на
 * инварианте, а не на длине его строк: `orion_golden_toc` не рисует список
 * через `ctx.bullets`, поэтому меры у него нет и `planBulletRecut` помечает
 * цепочку негодной. Переведёт кто-нибудь оглавление на `ctx.bullets` — оно
 * попадёт под жёсткую меру, где номера страниц зависят от разбивки, а разбивка
 * от номеров, и цикл честно не сойдётся. Тогда исключение здесь придётся
 * снимать вместе с той правкой, а не оставлять как есть.
 */
function bulletsBySlot(result: {
  assembly: {
    rendererSlides: Array<{ baseSlotId: string; template: string; bullets?: string[] }>;
  };
}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of result.assembly.rendererSlides) {
    if (s.template === "orion_golden_toc") continue;
    out[s.baseSlotId] = [...(out[s.baseSlotId] ?? []), ...(s.bullets ?? [])];
  }
  return out;
}

/** Сборка эталонного корпуса под заданной мерой — офлайн, без рендерера. */
async function report72DeckBuild(
  measure: ((p: Record<string, unknown>) => BulletMeasureVerdict) | null
) {
  const inputs = loadReport72DeckInputs();
  return runDeckBuildMeasured({
    ctx: {
      caseId: inputs.caseId,
      reportRunId: inputs.reportRunId,
      sourceDatasetId: inputs.sourceDatasetId,
      contentVersion: DECK_CONTENT_VERSION,
      subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
      bundle: inputs.mergedBundle,
      surfaceUnits: inputs.surfaceUnits,
      metricSnapshot: inputs.metricSnapshot,
      evidenceIndex: inputs.evidenceIndex,
      extras: {
        executiveSummary: inputs.executiveSummary as never,
        composedClientSummary: (inputs.composedClientSummary as never) ?? undefined,
        surfaceCollectionHints: inputs.surfaceCollectionHints,
        complianceScreenings: inputs.complianceScreenings,
        visualAssets: {},
      },
    },
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot: mkdtempSync(join(tmpdir(), "report72-fit-")),
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
    serpObservations: inputs.serpObservations,
    subjectName: "Сергей Глинка",
    measure: measure ? async (payload) => measure(payload) : null,
  });
}

describe("сборка деки по мере рендерера", () => {
  it("без адаптера меры собирается по сид-разбивке и меру не спрашивает", async () => {
    const res = await tinyDeckBuild({ measure: null });
    expect(res.assembly.deckManifest.pageCount).toBeGreaterThan(0);
    expect(res.bulletFit.measured).toBe(false);
    expect(res.bulletFit.iterations).toHaveLength(0);
  });

  it("чистая мера завершает цикл одной итерацией", async () => {
    let calls = 0;
    const res = await tinyDeckBuild({
      measure: async (payload) => {
        calls += 1;
        return cleanMeasure(payload);
      },
    });
    expect(calls).toBe(1);
    expect(res.bulletFit.measured).toBe(true);
    expect(res.bulletFit.converged).toBe(true);
    expect(res.bulletFit.iterations).toHaveLength(1);
  });

  it("страница с потерей развозится и цикл сходится", async () => {
    // Первый вердикт объявляет первую страницу со списком переполненной:
    // блоков влезает вдвое меньше, чем подано. Дальше мера чистая — цикл
    // обязан пересобрать деку и остановиться.
    let calls = 0;
    const res = await tinyDeckBuild({
      measure: async (payload) => {
        calls += 1;
        if (calls > 1) return cleanMeasure(payload);
        const clean = cleanMeasure(payload);
        const first = clean.pages.find((p) => p.itemHeights.length > 1);
        if (!first) return clean;
        return {
          ...clean,
          pages: clean.pages.map((p) =>
            p.slideKey === first.slideKey
              ? {
                  ...p,
                  availableHeight: 100_000,
                  keptItems: 1,
                  droppedBullets: p.itemHeights.length - 1,
                }
              : p
          ),
        };
      },
    });
    expect(calls).toBe(2);
    expect(res.bulletFit.converged).toBe(true);
    expect(res.bulletFit.iterations).toHaveLength(2);
    expect(res.bulletFit.iterations[0]!.movedSlots.length).toBeGreaterThan(0);
  });

  it("уже развезённые цепочки не откатываются к сиду на следующей итерации", async () => {
    /*
     * `runDeckBuild` каждую итерацию выводит раскладку из паков заново — паки
     * хранят сид, — и применяет только переданный план. Цепочка, ставшая
     * чистой, в новый план не попадает: её раскладка уже совпадает с жадной.
     * Без накопления она откатывалась бы к сиду, снова теряла содержимое, и
     * цикл ходил бы по кругу до отказа — тем заметнее, чем больше цепочек и
     * чем в разное время они сходятся.
     *
     * Корпус здесь эталонный (report-72): у него десяток цепочек пути
     * буллетов, и сходятся они за разное число итераций.
     */
    const seed = await report72DeckBuild(null);
    const recut = await report72DeckBuild(twoPerPage);
    expect(recut.bulletFit.converged).toBe(true);
    // Перекладка действительно работала: листов стало больше.
    expect(recut.assembly.deckManifest.pageCount).toBeGreaterThan(
      seed.assembly.deckManifest.pageCount
    );
    // И ничего не потеряла: у каждого слота тот же список в том же порядке.
    expect(bulletsBySlot(recut)).toEqual(bulletsBySlot(seed));
  });

  it("несудимых сборок не бывает: каждая пересборка получает свою меру", async () => {
    // Цикл считал план и пересобирал деку **на последней итерации тоже** —
    // мерить её было уже нечем, и работа выбрасывалась, а несходимость
    // объявлялась о сборке, которую никто не смотрел. Сборок не бывает больше,
    // чем мер: последняя мера судит последнюю сборку.
    let calls = 0;
    const stubborn: BulletMeasureAdapter = async (payload) => {
      calls += 1;
      const clean = cleanMeasure(payload);
      return {
        ...clean,
        pages: clean.pages.map((p) => ({
          ...p,
          availableHeight: 0,
          keptItems: 0,
          droppedBullets: p.itemHeights.length,
        })),
      };
    };
    const failure = await tinyDeckBuild({ measure: stubborn }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(BulletFitNotConvergedError);
    expect(calls).toBe(4);
    expect((failure as BulletFitNotConvergedError).bulletFit.builds).toBe(
      (failure as BulletFitNotConvergedError).bulletFit.iterations.length
    );
  });

  it("пересборка внутри цикла не платит ни одного вызова модели", async () => {
    const withMeasure = async (measure: BulletMeasureAdapter): Promise<number> => {
      let gptCalls = 0;
      await tinyDeckBuildWithGpt({
        measure,
        caller: async () => {
          gptCalls += 1;
          return {};
        },
      });
      return gptCalls;
    };
    const once = await withMeasure(async (payload) => cleanMeasure(payload));
    let calls = 0;
    const twice = await withMeasure(async (payload) => {
      calls += 1;
      if (calls > 1) return cleanMeasure(payload);
      const clean = cleanMeasure(payload);
      return {
        ...clean,
        pages: clean.pages.map((p) => ({
          ...p,
          availableHeight: 100_000,
          keptItems: 1,
          droppedBullets: Math.max(0, p.itemHeights.length - 1),
        })),
      };
    });
    expect(calls).toBe(2);
    expect(once).toBeGreaterThan(0);
    expect(twice).toBe(once);
  });

  it("не сошлось — прогон останавливается кодом потери, а не выпускает отчёт", async () => {
    // Вердикт, при котором ни на одной странице не помещается ничего: сколько
    // ни развози, потеря остаётся. Лучше остановленный прогон, чем урезанный
    // отчёт.
    let calls = 0;
    const stubborn: BulletMeasureAdapter = async (payload) => {
      calls += 1;
      const clean = cleanMeasure(payload);
      return {
        ...clean,
        pages: clean.pages.map((p) => ({
          ...p,
          availableHeight: 0,
          keptItems: 0,
          droppedBullets: p.itemHeights.length,
        })),
      };
    };
    await expect(tinyDeckBuild({ measure: stubborn })).rejects.toThrow(
      BulletFitNotConvergedError
    );
    expect(calls).toBe(4);
    await expect(tinyDeckBuild({ measure: stubborn })).rejects.toThrow(
      /CONTENT_DROPPED_BY_RENDERER/u
    );
  });

  it("отказ меры доходит до вызывающего, а не пропускается молча", async () => {
    await expect(
      tinyDeckBuild({
        measure: async () => {
          throw new Error("renderer unreachable");
        },
      })
    ).rejects.toThrow(/renderer unreachable/u);
  });
});
