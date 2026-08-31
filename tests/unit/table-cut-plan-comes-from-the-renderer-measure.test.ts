/**
 * Раскрой таблиц снимается мерой рендерера и доезжает до построителя.
 *
 * Мера снимается **до стадий GPT**: стадия 2 переписывает вводный абзац листа,
 * а после неё листов таблицы, которые она правила, уже не должно быть других.
 * Поэтому черновая дека собирается сидом, меряется, и полученный раскрой
 * уезжает во второе, настоящее построение.
 *
 * Меры нет — раскладка остаётся сидовой. Это не осторожность, а условие
 * отсутствия окна деплоя: приложение новой версии с рендерером прошлой получит
 * вердикт без страниц таблицы и обязано напечатать сегодняшний документ, а не
 * лист, нарисованный мимо поля.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDeckInputsFromAnalyticsDir,
  runDeckBuildMeasured,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import { DECK_CONTENT_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/content-version";
import {
  EXTRA_QUERIES_TABLE,
  TABLE_MEASURE_KEY_SUFFIX,
  collectTableCutPlan,
  tableCutKey,
} from "@/modules/digital-profile/orion-golden/deck-sections/measured-table-fit";
import { planBulletRecut } from "@/modules/digital-profile/orion-golden/deck-sections/measured-bullet-fit";
import type { BulletMeasureVerdict } from "@/modules/digital-profile/orion-golden/deck-sections/measured-bullet-fit";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import { runTinyAnalytics } from "../fixtures/tiny-canonical-prepare";

const HEADER_H = 330_200;
const ROW_BUDGET = 3_510_000;

/** Страница таблицы А так, как её видит сборка. */
function pageOf(index: number, rows: number): RendererSlide {
  return {
    slideKey: index === 0 ? "p09_ru_serp_table" : `p09_ru_serp_table__cont${index}`,
    baseSlotId: "p09_ru_serp_table",
    templateId: "serp-table",
    isContinuation: index > 0,
    table: { headers: ["№"], rows: Array.from({ length: rows }, (_, i) => [String(i + 1)]) },
    metrics: { serpPositional: 1, serpEngine: "YANDEX" },
  } as unknown as RendererSlide;
}

function verdictOf(
  pages: Array<{ slideKey: string; rowHeights: number[] }>
): BulletMeasureVerdict {
  return {
    version: "orion-bullet-measure-v1",
    pages: pages.map((p, i) => ({
      slideKey: `${p.slideKey}${TABLE_MEASURE_KEY_SUFFIX}`,
      page: i + 1,
      availableHeight: ROW_BUDGET + HEADER_H,
      maxItems: p.rowHeights.length + 1,
      itemHeights: [HEADER_H, ...p.rowHeights],
      keptItems: p.rowHeights.length + 1,
      droppedBullets: 0,
      droppedLines: 0,
    })),
  };
}

describe("план раскроя собирается из вердикта меры", () => {
  it("строки цепочки складываются по листам в порядке листов", () => {
    const slides = [pageOf(0, 3), pageOf(1, 3), pageOf(2, 2)];
    const plan = collectTableCutPlan({
      slides,
      verdict: verdictOf([
        { slideKey: "p09_ru_serp_table", rowHeights: [300_000, 300_000, 300_000] },
        { slideKey: "p09_ru_serp_table__cont1", rowHeights: [300_000, 300_000, 300_000] },
        { slideKey: "p09_ru_serp_table__cont2", rowHeights: [300_000, 300_000] },
      ]),
    });
    expect([...plan.keys()]).toEqual([tableCutKey("p09_ru_serp_table", "YANDEX")]);
    expect(plan.get(tableCutKey("p09_ru_serp_table", "YANDEX"))).toEqual([8]);
  });

  it("шапка не отдаёт свою высоту строкам: её высота вычтена из бюджета", () => {
    // Мера отдаёт высоту всего поля, а строкам достаётся поле минус шапка.
    // 762 000 EMU — самая высокая строка таблицы выдачи эталона-72, и на ней
    // шапка стоит ровно одной строки: четыре строки в бюджет входят
    // (3 048 000), пятая (3 810 000) не входит — но вошла бы, достанься
    // строкам ещё и высота шапки (3 840 200). Эта пятая была бы нарисована
    // мимо поля, потому что рисуется она под шапкой, а не вместо неё.
    const TALLEST_ROW = 762_000;
    const rows = Array.from({ length: 10 }, () => TALLEST_ROW);
    const plan = collectTableCutPlan({
      slides: [pageOf(0, 10)],
      verdict: verdictOf([{ slideKey: "p09_ru_serp_table", rowHeights: rows }]),
    });
    expect(TALLEST_ROW * 5).toBeGreaterThan(ROW_BUDGET);
    expect(TALLEST_ROW * 5).toBeLessThanOrEqual(ROW_BUDGET + HEADER_H);
    expect(plan.get(tableCutKey("p09_ru_serp_table", "YANDEX"))).toEqual([4, 4, 2]);
  });

  it("бюджет цепочки берётся самый тесный из измеренных листов", () => {
    // Листы цепочки не одинаковы: у первого есть вводный абзац, у продолжений
    // его нет, и поля у них разные. Бюджет берётся самый тесный: завышение
    // стоит строки, нарисованной мимо поля, а занижение — лишнего листа, и
    // цена у этих двух ошибок разная.
    const TIGHT = 2_000_000;
    const heights = [900_000, 900_000, 900_000, 900_000, 900_000, 900_000];
    const plan = collectTableCutPlan({
      slides: [pageOf(0, 3), pageOf(1, 3)],
      verdict: {
        version: "orion-bullet-measure-v1",
        pages: [
          { slideKey: `p09_ru_serp_table${TABLE_MEASURE_KEY_SUFFIX}`, availableHeight: ROW_BUDGET + HEADER_H, itemHeights: [HEADER_H, ...heights.slice(0, 3)] },
          { slideKey: `p09_ru_serp_table__cont1${TABLE_MEASURE_KEY_SUFFIX}`, availableHeight: TIGHT + HEADER_H, itemHeights: [HEADER_H, ...heights.slice(3)] },
        ].map((p, i) => ({
          ...p,
          page: i + 1,
          maxItems: p.itemHeights.length,
          keptItems: p.itemHeights.length,
          droppedBullets: 0,
          droppedLines: 0,
        })),
      },
    });
    // По тесному листу помещаются две строки, по просторному — три.
    expect(plan.get(tableCutKey("p09_ru_serp_table", "YANDEX"))).toEqual([2, 2, 2]);
  });

  it("страницы второй таблицы попадают в свой раскрой, а не в раскрой первой", () => {
    // У второй таблицы нет колонки «№» и нет `serpPositional`; её страницы
    // находятся по машинному признаку `serpExtraQueries`. Без него раскроя у
    // неё не появляется вовсе, и она молча остаётся с тремя строками на листе.
    const extraPage = (index: number, rows: number): RendererSlide =>
      ({
        ...pageOf(index, rows),
        slideKey: `p09_ru_serp_table__extra${index + 1}`,
        metrics: { serpExtraQueries: 1 },
      }) as unknown as RendererSlide;
    const slides = [extraPage(0, 3), extraPage(1, 3)];
    const plan = collectTableCutPlan({
      slides,
      verdict: verdictOf([
        { slideKey: "p09_ru_serp_table__extra1", rowHeights: [300_000, 300_000, 300_000] },
        { slideKey: "p09_ru_serp_table__extra2", rowHeights: [300_000, 300_000, 300_000] },
      ]),
    });
    expect([...plan.keys()]).toEqual([tableCutKey("p09_ru_serp_table", EXTRA_QUERIES_TABLE)]);
    expect(plan.get(tableCutKey("p09_ru_serp_table", EXTRA_QUERIES_TABLE))).toEqual([6]);
  });

  it("лист тем в раскрой таблицы не попадает, хотя лежит в том же слоте", () => {
    /*
     * Страница «о чём публикации» стоит в слоте выдачи и тоже несёт таблицу, но
     * построитель её по листам не разводит. У выдачи без названного поисковика
     * ключ таблицы А — `<слот>|`, и признай мы страницу тем «таблицей», её
     * строки попали бы в ту же цепочку: раскрой считался бы по чужим высотам.
     */
    const themes = {
      slideKey: "p09_ru_serp_table__themes",
      baseSlotId: "p09_ru_serp_table",
      metrics: { themes: 6, adverseTotal: 2 },
      table: { headers: ["Тема"], rows: [["Тема A"], ["Тема Б"]] },
    } as unknown as RendererSlide;
    const unnamedEngine = {
      ...pageOf(0, 3),
      metrics: { serpPositional: 0 },
    } as unknown as RendererSlide;
    const plan = collectTableCutPlan({
      slides: [unnamedEngine, themes],
      verdict: verdictOf([
        { slideKey: "p09_ru_serp_table", rowHeights: [300_000, 300_000, 300_000] },
        { slideKey: "p09_ru_serp_table__themes", rowHeights: [300_000, 300_000] },
      ]),
    });
    expect([...plan.keys()]).toEqual([tableCutKey("p09_ru_serp_table", "")]);
    expect(plan.get(tableCutKey("p09_ru_serp_table", ""))).toEqual([3]);
  });

  it("страница без меры оставляет всю цепочку сиду", () => {
    const plan = collectTableCutPlan({
      slides: [pageOf(0, 3), pageOf(1, 3)],
      verdict: verdictOf([
        { slideKey: "p09_ru_serp_table", rowHeights: [300_000, 300_000, 300_000] },
      ]),
    });
    expect(plan.size).toBe(0);
  });

  it("мера, у которой элементов не «шапка плюс строки», отвергается", () => {
    const plan = collectTableCutPlan({
      slides: [pageOf(0, 3)],
      verdict: verdictOf([{ slideKey: "p09_ru_serp_table", rowHeights: [300_000, 300_000] }]),
    });
    expect(plan.size).toBe(0);
  });

  it("вердикт рендерера прошлой версии не несёт таблиц вовсе — плана нет", () => {
    const plan = collectTableCutPlan({
      slides: [pageOf(0, 3), pageOf(1, 3)],
      verdict: { version: "orion-bullet-measure-v1", pages: [] },
    });
    expect(plan.size).toBe(0);
  });

  it("мерная запись таблицы не занимает ключ страницы", () => {
    // Ключ страницы принадлежит мере пути буллетов, и занять его записью
    // таблицы значит отдать перекладке буллетов числа про строки таблицы.
    expect(TABLE_MEASURE_KEY_SUFFIX).not.toBe("");
    const page = pageOf(0, 3);
    // Мера буллетов той же страницы лежит под её собственным ключом, мера
    // таблицы — под своим, и каждый читатель находит своё.
    const both: BulletMeasureVerdict = {
      version: "orion-bullet-measure-v1",
      pages: [
        {
          slideKey: page.slideKey,
          page: 1,
          availableHeight: 4_000_000,
          maxItems: 6,
          itemHeights: [100_000, 100_000],
          keptItems: 2,
          droppedBullets: 0,
          droppedLines: 0,
        },
        ...verdictOf([
          { slideKey: page.slideKey, rowHeights: [300_000, 300_000, 300_000] },
        ]).pages,
      ],
    };
    expect(collectTableCutPlan({ slides: [page], verdict: both }).get(
      tableCutKey("p09_ru_serp_table", "YANDEX")
    )).toEqual([3]);
    expect(
      planBulletRecut({
        chains: [
          {
            baseSlotId: "p09_ru_serp_table",
            pages: [
              { slideId: page.slideKey, bulletCount: 2, fold: { leading: 0, trailing: 0 } },
            ],
          },
        ],
        verdict: both,
      }).size
    ).toBe(0);
  });

  it("записи таблиц не путаются с записями буллетов: у них свой ключ страницы", () => {
    const chains = [
      {
        baseSlotId: "p09_ru_serp_table",
        pages: [{ slideId: "p09_ru_serp_table", bulletCount: 0, fold: { leading: 0, trailing: 0 } }],
      },
    ];
    const withTables = verdictOf([
      { slideKey: "p09_ru_serp_table", rowHeights: [300_000, 300_000, 300_000] },
    ]);
    expect(planBulletRecut({ chains, verdict: withTables }).size).toBe(
      planBulletRecut({ chains, verdict: { version: "orion-bullet-measure-v1", pages: [] } }).size
    );
  });
});

describe("мера доезжает до построителя на настоящей сборке", () => {
  async function tinyDeck(measure: null | ((payload: Record<string, unknown>) => BulletMeasureVerdict)) {
    const root = mkdtempSync(join(tmpdir(), "table-fit-"));
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
      measure: measure ? async (payload) => measure(payload) : null,
    });
  }

  /** Мера, объявляющая каждую строку таблицы выше половины бюджета листа. */
  const tallRows = (payload: Record<string, unknown>): BulletMeasureVerdict => {
    const slides = (payload.deckManifest as {
      finalSlides: Array<{ slideKey: string; table?: { rows?: string[][] } }>;
    }).finalSlides;
    return {
      version: "orion-bullet-measure-v1",
      pages: slides
        .filter((s) => (s.table?.rows ?? []).length > 0)
        .map((s, i) => ({
          slideKey: `${s.slideKey}${TABLE_MEASURE_KEY_SUFFIX}`,
          page: i + 1,
          availableHeight: ROW_BUDGET + HEADER_H,
          maxItems: (s.table?.rows ?? []).length + 1,
          itemHeights: [HEADER_H, ...(s.table?.rows ?? []).map(() => 2_000_000)],
          keptItems: (s.table?.rows ?? []).length + 1,
          droppedBullets: 0,
          droppedLines: 0,
        })),
    };
  };

  const serpRows = (slides: RendererSlide[]): number[] =>
    slides
      .filter((s) => s.metrics?.serpPositional === 1)
      .map((s) => s.table?.rows.length ?? 0);

  it("без адаптера меры дека остаётся такой, какой её разложил сид", async () => {
    const built = await tinyDeck(null);
    expect(serpRows(built.assembly.rendererSlides)).toEqual([2]);
  });

  it("мера, по которой две строки на лист не влезают, разводит их по листам", async () => {
    const built = await tinyDeck(tallRows);
    expect(serpRows(built.assembly.rendererSlides)).toEqual([1, 1]);
  });
});
