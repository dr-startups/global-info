/**
 * Orchestrates the independent-section deck build:
 * SectionPacks (independent, cached) → report-section-manifest →
 * DeckAssembler → unified slide model → validation reports.
 *
 * Persistence layout matches the required artifact tree (section-packs/...).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FragmentKey, ReportDeckManifest, ReportSectionManifest, SectionPackV2 } from "./contracts";
import { FRAGMENT_ARTIFACT_PATHS, sectionPackJson, SectionPackV2Schema } from "./contracts";
import {
  buildAllSections,
  packWithOwnContentHash,
  CONTENT_HASH_REPAIRED,
  type SectionBuildContext,
  type SectionBuildLogEntry,
} from "./section-builders";
import { validateSectionPack, type SectionValidationReport } from "./section-validation";
import { buildReportSectionManifest } from "./section-manifest";
import {
  assembleDeck,
  CLIENT_TEXT_FIELDS,
  type ClientTextField,
  type DeckAssemblyResult,
  type RendererSlide,
} from "./deck-assembler";
import {
  validateAssembly,
  type AssemblyValidationReport,
  type SerpObservationForGate,
} from "./assembly-validation";
import { buildLinkUsageTrace, linkUsageLogLine } from "./link-usage-trace";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import { getClientTextContract } from "../client/load-client-text-contract";
import { toneForRiskLabel } from "../client/risk-scale";
import {
  clampClientText,
  reflowNarrativeParagraphs,
  reflowThemeBullet,
} from "./fragment-builders/shared";
import {
  CARD_STRUCTURED_TEMPLATES,
  composeFindingProse,
  pageNarrativeOf,
} from "./page-narrative";
import { normalizeForCompare, withoutRepeatedSentences } from "./text-compare";
import {
  DECK_TEMPLATE_REGISTRY,
  SIDEBAR_COLUMN_CHAR_BUDGET,
  SIDEBAR_HIGHLIGHT_BUDGET,
  SIDEBAR_HIGHLIGHT_SLOTS,
  rendererTemplateHasBulletList,
  SILENTLY_CLIPPED_NARRATIVE_TEMPLATES,
  type DeckTemplateId,
} from "./template-registry";
import {
  measureVerdictHasLoss,
  planBulletRecut,
  planSidebarShrink,
  type BulletItemFold,
  type BulletMeasureAdapter,
  type BulletMeasureVerdict,
  type BulletRecutPlan,
  type SlotChain,
} from "./measured-bullet-fit";
import { collectTableCutPlan } from "./measured-table-fit";

export type DeckBuildResult = {
  packs: SectionPackV2[];
  validationReports: Map<FragmentKey, SectionValidationReport>;
  manifest: ReportSectionManifest;
  assembly: DeckAssemblyResult;
  assemblyValidation: AssemblyValidationReport | null;
  buildLog: SectionBuildLogEntry[];
  artifacts: Record<string, string>;
};

export function loadPreviousPacks(outputRoot: string): Map<FragmentKey, SectionPackV2> {
  const previous = new Map<FragmentKey, SectionPackV2>();
  for (const [key, rel] of Object.entries(FRAGMENT_ARTIFACT_PATHS)) {
    const path = join(outputRoot, rel);
    if (!existsSync(path)) continue;
    try {
      const parsed = SectionPackV2Schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) previous.set(key as FragmentKey, parsed.data);
    } catch {
      // unreadable pack — rebuild
    }
  }
  return previous;
}

/**
 * Единственный писатель файла пакета: продуктовая запись, снятие штампа
 * GPT-копии и офлайн-миграция v2→v3 зовут его, поэтому одно значение пакета
 * даёт один и тот же файл, кем бы он ни был записан.
 */
export function writeSectionPackFile(path: string, pack: SectionPackV2): void {
  writeFileSync(path, sectionPackJson(pack), "utf8");
}

/**
 * Drop persisted gptCopy stamps from section-packs on disk so a subsequent
 * full prepare cannot revive SKIPPED_CACHED if forceRefresh is skipped.
 * Used by unified «Пересобрать отчёт».
 */
export function stripGptCopyFromSectionPacksOnDisk(outputRoot: string): number {
  let stripped = 0;
  for (const rel of Object.values(FRAGMENT_ARTIFACT_PATHS)) {
    const path = join(outputRoot, rel);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || !("gptCopy" in raw)) continue;
      const { gptCopy: _drop, ...rest } = raw;
      // На диске лежит пакет; схемой он здесь намеренно не проверяется — снятие
      // штампа не должно ронять пак, который потом пересоберут или отбракуют.
      writeSectionPackFile(path, rest as SectionPackV2);
      stripped += 1;
    } catch {
      // leave pack for rebuild / schema validation
    }
  }
  return stripped;
}

export function runDeckBuild(input: {
  ctx: Omit<SectionBuildContext, "previousPacks" | "buildLog">;
  bundleForValidation: VerifiedFindingBundle;
  knownEvidenceRefs: Set<string>;
  outputRoot: string;
  baseObservationCountBefore: number;
  baseObservationCountAfter: number;
  /** Packs already built (and possibly GPT-enhanced) by a wrapper stage. */
  prebuiltPacks?: SectionPackV2[];
  prebuiltBuildLog?: DeckBuildResult["buildLog"];
  /** Level 2.5 — slideId → layout variant picked by the GPT composer. */
  layoutVariants?: ReadonlyMap<string, string>;
  /** Наблюдения выдачи для сверки печатной таблицы с артефактом. */
  serpObservations?: ReadonlyArray<SerpObservationForGate>;
  /** Разбивка буллетов по страницам, снятая с меры рендерера. */
  bulletRecut?: BulletRecutPlan;
  /** Масштаб колонки сайдбара по слайдам — из цикла меры. */
  sidebarScales?: ReadonlyMap<string, number>;
}): DeckBuildResult {
  const buildLog: DeckBuildResult["buildLog"] = input.prebuiltBuildLog ?? [];
  const artifacts: Record<string, string> = {};
  const previousPacks = loadPreviousPacks(input.outputRoot);
  const ctx: SectionBuildContext = { ...input.ctx, previousPacks, buildLog };

  // 1. Independent SectionPacks (cache-aware) — or the prebuilt set.
  const packs = input.prebuiltPacks ?? buildAllSections(ctx);

  // 2. Section-level QA before assembly.
  const validationReports = new Map<FragmentKey, SectionValidationReport>();
  for (const pack of packs) {
    const report = validateSectionPack({
      pack,
      expectedCaseId: ctx.caseId,
      expectedReportRunId: ctx.reportRunId,
      expectedDatasetId: ctx.sourceDatasetId,
      bundle: input.bundleForValidation,
      knownEvidenceRefs: input.knownEvidenceRefs,
      evidenceIndex: ctx.evidenceIndex,
    });
    pack.validation = { passed: report.passed, issues: report.issues };
    validationReports.set(pack.fragmentKey, report);
  }

  // 3. Persist every SectionPack independently.
  for (const pack of packs) {
    const rel = FRAGMENT_ARTIFACT_PATHS[pack.fragmentKey];
    const path = join(input.outputRoot, rel);
    mkdirSync(dirname(path), { recursive: true });
    // Файл сходится со своим хэшем, каким бы путём пакет сюда ни попал. Ветка
    // реюза пересчитывает хэш сама, но она не единственный вход: точечный ретрай
    // стадии 2 отдаёт `prebuiltPacks` прямо из `loadPreviousPacks`, минуя её.
    const { pack: written, repairedFrom } = packWithOwnContentHash(pack);
    if (repairedFrom) {
      pack.contentHash = written.contentHash;
      const warning = `${CONTENT_HASH_REPAIRED}:${repairedFrom}`;
      const entry = buildLog.find((l) => l.fragmentKey === pack.fragmentKey);
      // Журнал может прийти пустым: `prebuiltPacks` и `prebuiltBuildLog` —
      // независимые поля входа. След важнее того, что о фрагменте больше нечего
      // сказать, поэтому запись заводится; действие — то же, каким помечает эти
      // пакеты точечный ретрай: этим прогоном они не собирались.
      if (entry) entry.warning = warning;
      else buildLog.push({ fragmentKey: pack.fragmentKey, action: "REUSED_CACHE", warning });
    }
    writeSectionPackFile(path, written);
    artifacts[rel] = path;
  }
  const sectionReportsPath = join(input.outputRoot, "section-validation-reports.json");
  writeFileSync(
    sectionReportsPath,
    JSON.stringify([...validationReports.values()], null, 2),
    "utf8"
  );
  artifacts["section-validation-reports.json"] = sectionReportsPath;

  // 4. Manifest (fail-closed for required sections).
  const manifest = buildReportSectionManifest({
    caseId: ctx.caseId,
    reportRunId: ctx.reportRunId,
    sourceDatasetId: ctx.sourceDatasetId,
    packs,
    validationReports,
  });
  const manifestPath = join(input.outputRoot, "report-section-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  artifacts["report-section-manifest.json"] = manifestPath;

  // 5. Deterministic assembly.
  const assembly = assembleDeck({
    manifest,
    packs,
    expectedCaseId: ctx.caseId,
    expectedReportRunId: ctx.reportRunId,
    expectedDatasetId: ctx.sourceDatasetId,
    layoutVariants: input.layoutVariants,
    bulletRecut: input.bulletRecut,
    sidebarScales: input.sidebarScales,
  });
  const deckManifestPath = join(input.outputRoot, "report-deck-manifest.json");
  writeFileSync(deckManifestPath, JSON.stringify(assembly.deckManifest, null, 2), "utf8");
  artifacts["report-deck-manifest.json"] = deckManifestPath;
  const assembledPath = join(input.outputRoot, "assembled-deck.json");
  writeFileSync(
    assembledPath,
    JSON.stringify(
      {
        version: "deck-sections-assembled-v1",
        caseId: ctx.caseId,
        reportRunId: ctx.reportRunId,
        datasetId: ctx.sourceDatasetId,
        sourceDatasetId: ctx.sourceDatasetId,
        slides: assembly.rendererSlides,
        rejections: assembly.rejections,
        // Что сняла вычистка повторов — чтобы укоротившуюся страницу было с чем
        // сверить, а не только заметить, что она стала короче.
        dedupRemovals: assembly.dedupRemovals,
        // Снятые повторные блоки: дефект виден в разборе, а отчёт выдан.
        repeatRepairs: assembly.repeatRepairs,
      },
      null,
      2
    ),
    "utf8"
  );
  artifacts["assembled-deck.json"] = assembledPath;

  // 6. Global assembly validation.
  let assemblyValidation: AssemblyValidationReport | null = null;
  if (assembly.errors.length === 0) {
    assemblyValidation = validateAssembly({
      manifest,
      deckManifest: assembly.deckManifest,
      rendererSlides: assembly.rendererSlides,
      packs,
      bundle: input.bundleForValidation,
      baseObservationCountBefore: input.baseObservationCountBefore,
      baseObservationCountAfter: input.baseObservationCountAfter,
      evidenceIndex: ctx.evidenceIndex,
      visualAssets: ctx.extras.visualAssets,
      serpObservations: input.serpObservations,
    });
  }
  const assemblyReportPath = join(input.outputRoot, "assembly-validation-report.json");
  writeFileSync(
    assemblyReportPath,
    JSON.stringify(assemblyValidation ?? { passed: false, issues: assembly.errors, checks: {} }, null, 2),
    "utf8"
  );
  artifacts["assembly-validation-report.json"] = assemblyReportPath;

  /*
   * След «что сказала модель о ссылке → что дошло до отчёта».
   *
   * Между решением по прочитанной странице и напечатанной страницей лежит
   * десяток отборов, и по готовому отчёту нельзя понять, почему ссылки в нём
   * нет: её не прочитали, вывод понизили или цитату забраковали. След отвечает
   * на это одной строкой на ссылку и живёт рядом с декой.
   */
  const usageTrace = buildLinkUsageTrace({
    evidenceIndex: ctx.evidenceIndex,
    slides: assembly.rendererSlides,
  });
  const usagePath = join(input.outputRoot, "link-usage-trace.json");
  writeFileSync(usagePath, JSON.stringify(usageTrace, null, 2), "utf8");
  artifacts["link-usage-trace.json"] = usagePath;
  if (usageTrace.summary.total > 0) console.log(linkUsageLogLine(usageTrace));

  const buildLogPath = join(input.outputRoot, "section-build-log.json");
  writeFileSync(buildLogPath, JSON.stringify(buildLog, null, 2), "utf8");
  artifacts["section-build-log.json"] = buildLogPath;

  return { packs, validationReports, manifest, assembly, assemblyValidation, buildLog, artifacts };
}

/**
 * Пакеты секций, собранные под мерой таблиц.
 *
 * Порядок именно такой: черновая дека собирается сидом, меряется мерным
 * прогоном рендерера, и полученный раскрой уезжает **во второе построение**.
 * Мера снимается здесь, до стадий GPT: стадия 2 переписывает вводный абзац
 * конкретных листов, и переложить строки после неё значило бы обесценить её
 * текст — тех листов, которые она правила, больше не было бы.
 *
 * Черновик ничего не пишет на диск и никем не судится: он существует ровно
 * затем, чтобы его померили. Сборка черновика не закрылась — раскроя нет и
 * пакеты собираются как прежде; судит сборку тот, кто её принимает, а не эта
 * функция.
 *
 * Меры нет (офлайн-сборка, рендерер прошлой версии) — раскладка остаётся
 * сидовой. Это условие отсутствия окна деплоя, а не осторожность.
 */
export async function buildSectionPacksUnderTableMeasure(input: {
  ctx: SectionBuildContext;
  bundleForValidation: VerifiedFindingBundle;
  knownEvidenceRefs: Set<string>;
  subjectName: string;
  assets?: RendererAssetEntry[];
  measure?: BulletMeasureAdapter | null;
}): Promise<SectionPackV2[]> {
  const { ctx } = input;
  if (!input.measure) return buildAllSections(ctx);
  // Журнал сборки у черновика свой: его пакеты никуда не поедут, а записи
  // «пересобран/взят из кэша» относятся к настоящему построению ниже.
  const draftPacks = buildAllSections({ ...ctx, buildLog: [] });
  const draftReports = new Map<FragmentKey, SectionValidationReport>();
  for (const pack of draftPacks) {
    draftReports.set(
      pack.fragmentKey,
      validateSectionPack({
        pack,
        expectedCaseId: ctx.caseId,
        expectedReportRunId: ctx.reportRunId,
        expectedDatasetId: ctx.sourceDatasetId,
        bundle: input.bundleForValidation,
        knownEvidenceRefs: input.knownEvidenceRefs,
        evidenceIndex: ctx.evidenceIndex,
      })
    );
  }
  const draft = assembleDeck({
    manifest: buildReportSectionManifest({
      caseId: ctx.caseId,
      reportRunId: ctx.reportRunId,
      sourceDatasetId: ctx.sourceDatasetId,
      packs: draftPacks,
      validationReports: draftReports,
    }),
    packs: draftPacks,
    expectedCaseId: ctx.caseId,
    expectedReportRunId: ctx.reportRunId,
    expectedDatasetId: ctx.sourceDatasetId,
  });
  if (draft.errors.length > 0) return buildAllSections(ctx);
  const verdict = await input.measure(
    toRendererPayload({
      deckManifest: draft.deckManifest,
      rendererSlides: draft.rendererSlides,
      subjectName: input.subjectName,
      assets: input.assets,
    })
  );
  // Пустой раскрой отдельной веткой не обрабатывается: у построителя он и так
  // означает «режь сидом», а вторая ветка была бы вторым ответом на это.
  const tableCut = collectTableCutPlan({ slides: draft.rendererSlides, verdict });
  return buildAllSections({ ...ctx, extras: { ...ctx.extras, tableCut } });
}

/** Цикл не сошёлся: содержимое всё ещё не помещается на лист. */
export class BulletFitNotConvergedError extends Error {
  /** Разбор цикла: по нему видно, где именно он встал. */
  readonly bulletFit: BulletFitReport;

  constructor(detail: string, bulletFit: BulletFitReport) {
    super(`CONTENT_DROPPED_BY_RENDERER: ${detail}`);
    this.name = "BulletFitNotConvergedError";
    this.bulletFit = bulletFit;
  }
}

/**
 * Чем кончился цикл — **единственный** ответ на «мерили ли и сошлось ли».
 *
 * Двумя признаками (`measured` + `converged`) состояние не описывалось: у
 * несобравшейся деки цикл не доходил до меры, а отчёт по умолчаниям утверждал
 * «мера выполнялась и сошлась» — врал ровно в том файле, куда лезут
 * разбираться, когда всё сломалось. `NOT_MEASURED_*` — не отказ меры, а её
 * отсутствие с названной причиной: отказ меры громкий и приезжает кодом
 * `RENDER_FAILED`, а не строкой в этом отчёте.
 */
export type BulletFitOutcome =
  /** Померено, потерь нет. */
  | "CONVERGED"
  /** Померено, потеря осталась после отведённых итераций. */
  | "NOT_CONVERGED"
  /** Адаптера меры нет: офлайн-сборка, которая ничего не рендерит. */
  | "NOT_MEASURED_NO_ADAPTER"
  /** Дека не собралась: слайдов нет, мерить нечего. */
  | "NOT_MEASURED_ASSEMBLY_FAILED";

/** Разбор цикла: что мерили, что переложили и чем кончилось. */
export type BulletFitReport = {
  version: "orion-bullet-fit-v2";
  outcome: BulletFitOutcome;
  /**
   * Сколько раз собиралась дека.
   *
   * Цикл не оставляет пересборку непомеренной намеренно: пересборка, которую
   * померить уже нечем, — выброшенная работа и приговор сборке, которую никто
   * не смотрел. Поэтому при `CONVERGED` и `NOT_CONVERGED` сборок ровно столько
   * же, сколько итераций с мерой.
   *
   * Оба `NOT_MEASURED_*` это равенство нарушают по замыслу: без адаптера меры
   * сборка одна, а мер ноль; на несобравшейся деке последняя сборка остаётся
   * непомеренной, и сборок на одну больше, чем итераций.
   */
  builds: number;
  iterations: Array<{
    iteration: number;
    lossyPages: Array<{ slideKey: string; droppedBullets: number; droppedLines: number }>;
    movedSlots: Array<{ baseSlotId: string; before: number[]; after: number[] }>;
    /** Страницы, чью колонку сайдбара ужали по потере меры, и новая доля бюджета. */
    shrunkSidebars?: Array<{ slideKey: string; scale: number }>;
  }>;
};

/** Сколько раз цикл готов пересобрать деку, прежде чем признать несходимость. */
const MAX_FIT_ITERATIONS = 4;

/** Цепочки слотов собранной деки — вход перекладки. */
function slotChainsOf(
  rendererSlides: RendererSlide[],
  payload: Record<string, unknown>
): SlotChain[] {
  const payloadSlides = (payload.deckManifest as { finalSlides?: Array<Record<string, unknown>> })
    .finalSlides ?? [];
  const itemsByKey = new Map(
    payloadSlides.map((s) => [String(s.slideKey ?? ""), rendererBulletItemsOf(s)])
  );
  const chains: SlotChain[] = [];
  const broken = new Set<string>();
  for (const slide of rendererSlides) {
    const fold = bulletItemFoldOf({
      payloadItems: itemsByKey.get(slide.slideKey) ?? [],
      deckBullets: slide.bullets ?? [],
      sourceNote: slide.sourceNote,
      statusNote: slide.statusNote,
    });
    // Разрез не сошёлся — из перекладки выпадает **вся цепочка**, а не одна её
    // страница: пропущенный лист сдвинул бы нумерацию страниц в плане, и блоки
    // легли бы не туда. Сдвинуть блок наугад хуже, чем оставить как есть.
    if (!fold) {
      broken.add(slide.baseSlotId);
      continue;
    }
    const page = {
      slideId: slide.slideKey,
      bulletCount: (slide.bullets ?? []).length,
      fold,
    };
    const chain = chains[chains.length - 1];
    if (slide.isContinuation && chain && chain.baseSlotId === slide.baseSlotId) {
      chain.pages.push(page);
      continue;
    }
    if (slide.isContinuation) continue;
    chains.push({ baseSlotId: slide.baseSlotId, pages: [page] });
  }
  return chains.filter((c) => !broken.has(c.baseSlotId));
}

/**
 * Сборка деки под мерой рендерера: собрали → померили → переложили → пересобрали.
 *
 * Пересборка идёт на тех же паках, поэтому не стоит ни одного вызова модели и
 * детерминирована. Цикл кончается, когда мера не находит потерь; не сошёлся за
 * отведённые итерации — прогон останавливается тем же кодом, которым его
 * останавливают ворота: лучше остановленный прогон, чем урезанный отчёт.
 *
 * Без адаптера меры (офлайн-сборки, которые ничего не рендерят и не публикуют)
 * цикл не выполняется вовсе, и дека остаётся такой, какой её разложил сид.
 */
export async function runDeckBuildMeasured(
  input: Parameters<typeof runDeckBuild>[0] & {
    subjectName: string;
    assets?: RendererAssetEntry[];
    measure?: BulletMeasureAdapter | null;
    maxIterations?: number;
  }
): Promise<DeckBuildResult & { bulletFit: BulletFitReport }> {
  const report: BulletFitReport = {
    version: "orion-bullet-fit-v2",
    // Исход начинается с «меры не было» и уточняется по ходу: на любом раннем
    // выходе отчёт тогда говорит о том, что действительно случилось, а не о
    // том, что задумывалось.
    outcome: "NOT_MEASURED_NO_ADAPTER",
    builds: 1,
    iterations: [],
  };
  const finish = (built: DeckBuildResult): DeckBuildResult & { bulletFit: BulletFitReport } => {
    const path = join(input.outputRoot, "bullet-fit-report.json");
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    built.artifacts["bullet-fit-report.json"] = path;
    return { ...built, bulletFit: report };
  };

  /*
   * Пакеты собираются здесь, а не внутри `runDeckBuild`, потому что раскрой
   * таблиц приезжает в **построитель**, а спросить его можно только у меры —
   * то есть после того, как черновая дека уже собрана и нарисована. Путь со
   * стадиями GPT приносит свои пакеты (`prebuiltPacks`), и мера у них снята
   * тем же вызовом до стадии 2.
   */
  const buildLog: SectionBuildLogEntry[] = input.prebuiltBuildLog ?? [];
  const packs =
    input.prebuiltPacks ??
    (await buildSectionPacksUnderTableMeasure({
      ctx: { ...input.ctx, previousPacks: loadPreviousPacks(input.outputRoot), buildLog },
      bundleForValidation: input.bundleForValidation,
      knownEvidenceRefs: input.knownEvidenceRefs,
      subjectName: input.subjectName,
      assets: input.assets,
      measure: input.measure,
    }));
  const built = { ...input, prebuiltPacks: packs, prebuiltBuildLog: buildLog };

  let result = runDeckBuild(built);
  if (!input.measure) return finish(result);

  const limit = Math.max(1, input.maxIterations ?? MAX_FIT_ITERATIONS);
  /*
   * План копится, а не заменяется.
   *
   * `runDeckBuild` каждую итерацию выводит раскладку из паков заново — паки
   * хранят сид, — и применяет только то, что ему передали. Цепочка, уже
   * развезённая и ставшая чистой, в новый план не попадает (её раскладка
   * совпадает с жадной), и без накопления она откатывалась бы к сиду, снова
   * теряла содержимое и гоняла цикл по кругу до отказа.
   */
  const plan = new Map<string, number[]>();
  let sidebarScales = new Map<string, number>();
  for (let iteration = 1; iteration <= limit; iteration += 1) {
    /*
     * Сборка не закрылась — мерить нечего, и спрашивать об этом рендерер
     * нельзя.
     *
     * Отказ обязательной секции останавливает сборку, и дека выходит пустой:
     * ноль слайдов, `pageCount: 0`. Рендерер на таком манифесте законно
     * отвечает 500 «finalSlides is empty», и наружу уезжает **его** отказ
     * вместо кода сборки и имени секции — на живом прогоне 20.08 оператор
     * прочитал именно 500. Судит сборку тот, кто её принимает; цикл только не
     * подменяет его приговор своим. Проверка стоит внутри цикла, а не перед
     * ним: дека выходит пустой и с первой сборки, и с любой пересборки —
     * поэтому исход говорит о последней сборке, а прошлые итерации, если они
     * были, остаются в списке.
     */
    if (result.assembly.errors.length > 0) {
      report.outcome = "NOT_MEASURED_ASSEMBLY_FAILED";
      return finish(result);
    }
    const payload = toRendererPayload({
      deckManifest: result.assembly.deckManifest,
      rendererSlides: result.assembly.rendererSlides,
      subjectName: input.subjectName,
      assets: input.assets,
    });
    const verdict: BulletMeasureVerdict = await input.measure(payload);
    if (!measureVerdictHasLoss(verdict)) {
      report.iterations.push({ iteration, lossyPages: [], movedSlots: [] });
      report.outcome = "CONVERGED";
      return finish(result);
    }
    const lossyPages = verdict.pages
      .filter((p) => p.droppedBullets > 0 || p.droppedLines > 0)
      .map((p) => ({
        slideKey: p.slideKey,
        droppedBullets: p.droppedBullets,
        droppedLines: p.droppedLines,
      }));
    const chains = slotChainsOf(result.assembly.rendererSlides, payload);
    const fresh = planBulletRecut({ chains, verdict });
    const movedSlots = [...fresh.entries()].map(([baseSlotId, after]) => ({
      baseSlotId,
      before: chains.find((c) => c.baseSlotId === baseSlotId)?.pages.map((p) => p.bulletCount) ?? [],
      after,
    }));
    /*
     * Потеря сайдбара лечится тем же циклом: колонка потерявшей страницы
     * ужимается, и дека собирается заново. Страница → слайд по нумерации
     * полезной нагрузки — так же, как телеметрия её называет.
     */
    const finalSlides =
      (payload.deckManifest as { finalSlides?: Array<{ slideKey?: string; pageNumber?: number }> })
        .finalSlides ?? [];
    const pageSlideKeys = new Map(
      finalSlides
        .filter((f) => typeof f.pageNumber === "number" && typeof f.slideKey === "string")
        .map((f) => [f.pageNumber as number, f.slideKey as string] as const)
    );
    const shrunk = planSidebarShrink({ verdict, pageSlideKeys, previous: sidebarScales });
    const shrunkSidebars = [...shrunk.entries()]
      .filter(([key, scale]) => sidebarScales.get(key) !== scale)
      .map(([slideKey, scale]) => ({ slideKey, scale }));
    report.iterations.push({ iteration, lossyPages, movedSlots, shrunkSidebars });
    // Двигать нечего (мера жалуется на страницу, которой перекладка не
    // управляет) или мерить следующую сборку уже нечем — дальше идти незачем.
    if ((fresh.size === 0 && shrunk.size === 0) || iteration === limit) break;
    for (const [baseSlotId, counts] of fresh) plan.set(baseSlotId, counts);
    if (shrunk.size > 0) sidebarScales = shrunk;
    result = runDeckBuild({
      ...built,
      prebuiltPacks: result.packs,
      prebuiltBuildLog: result.buildLog,
      bulletRecut: plan,
      sidebarScales,
    });
    report.builds += 1;
  }
  report.outcome = "NOT_CONVERGED";
  finish(result);
  const last = report.iterations[report.iterations.length - 1];
  throw new BulletFitNotConvergedError(
    `перекладка не сошлась за ${report.iterations.length} итераций; страницы с потерей: ${
      last?.lossyPages.map((p) => p.slideKey).join(", ") || "нет"
    }`,
    report
  );
}

/** Raw asset entry in the existing report-assets store (imageData base64). */
export type RendererAssetEntry = {
  assetRef: string;
  kind?: string;
  title?: string;
  caption?: string;
  imageData?: string;
  storageKey?: string;
} & Record<string, unknown>;


/**
 * Абзацы, которые не влезут в свой лист.
 *
 * Ёмкость листа объявлена у реестрового шаблона, и это **единственный** ответ
 * на вопрос «сколько абзаца помещается»: раньше их было два, применялся общий
 * бюджет клиентского поля (1100 знаков на все шаблоны), и абзац в 952 знака
 * стоял на листе ёмкостью около 998, не вызвав ни одного возражения.
 *
 * Проверять после отрисовки нечем: карточку абзаца рисует `content_card`, а он
 * обрезает текст **до** отрисовки, телеметрии о себе не пишет вовсе и
 * `droppedLines` не выставляет. Ни геометрия, ни блокирующее правило приёмки
 * такой потери не видят — единственный момент, когда её ещё можно заметить,
 * вот этот: абзац собран целиком и ещё не отдан рендереру.
 */
/**
 * Абзац не влезает в свой лист — отказ именованный, а не безымянный.
 *
 * Классификатор восстановления узнаёт отказ по коду или по знакомой фразе, и
 * безымянная ошибка не подходила ни под один его пункт: на последнем шаге
 * оплаченного прогона она выглядела бы аварией, хотя дефект детерминированный
 * и данные сбора целы. Это то же самое, чем кончается несошедшийся цикл меры
 * (`BulletFitNotConvergedError`), и лечится тем же — пересборкой после правки.
 */
export class NarrativeOverBudgetError extends Error {
  /** Какие листы и насколько переросли бюджет — чтобы не искать по журналу. */
  readonly slides: ReadonlyArray<{
    slideKey: string;
    templateId: string;
    length: number;
    budget: number;
  }>;

  constructor(slides: ReadonlyArray<{ slideKey: string; templateId: string; length: number; budget: number }>) {
    super(
      `narrative over template budget: ${slides
        .map((o) => `${o.slideKey} [${o.templateId}] ${o.length}>${o.budget}`)
        .join("; ")}`
    );
    this.name = "NarrativeOverBudgetError";
    this.slides = slides;
  }
}

/**
 * Резак абзацев выбросил часть текста.
 *
 * `reflowNarrativeParagraphs` делит абзац по предложениям с пределом
 * `max(180, длина/3)` и **молча** отбрасывает всё сверх трёх абзацев, а
 * предложение длиннее предела обрезает по границе слова. Ни записи, ни
 * события, ни `droppedLines` при этом не появляется: потерю не видят ни
 * геометрия, ни телеметрия, ни ворота приёмки.
 *
 * Замерять после резака бесполезно — там уже короткий текст. Поэтому сверка
 * идёт по обе стороны вызова: что подали и что он вернул.
 */
export class NarrativeReflowLossError extends Error {
  readonly slides: ReadonlyArray<{ slideKey: string; before: number; after: number }>;

  constructor(slides: ReadonlyArray<{ slideKey: string; before: number; after: number }>) {
    super(
      `narrative reflow dropped text: ${slides
        .map((o) => `${o.slideKey} ${o.before}->${o.after}`)
        .join("; ")}`
    );
    this.name = "NarrativeReflowLossError";
    this.slides = slides;
  }
}

/**
 * Клиентский текст деки, у которого в нагрузке нет носителя.
 *
 * Поле, построенное для слайда и не положенное ни в одно поле его же объекта
 * нагрузки, до листа не доедет никогда — и никакой прибор ниже этого не
 * увидит. Ворот приёмки «каждое поле оставило след на своей странице» читает
 * **нагрузку**, поэтому поле, до неё не доехавшее, для него не существует: на
 * эталоне-72 он был зелёным при 21 потерянной сноске «Источники» и 8
 * потерянных статусных строках.
 *
 * Отказ громкий и возобновляемый: правится он в построителе (поле, которому
 * негде напечататься, не строится) или в маппинге (поле кладётся в носитель,
 * который макет рисует).
 */
export class ClientTextWithoutCarrierError extends Error {
  readonly fields: ReadonlyArray<{ slideKey: string; field: string; text: string }>;

  constructor(fields: ReadonlyArray<{ slideKey: string; field: string; text: string }>) {
    super(
      `client text has no carrier in the renderer payload: ${fields
        .map((f) => `${f.slideKey} · ${f.field} · «${f.text.slice(0, 60)}»`)
        .join("; ")}`
    );
    this.name = "ClientTextWithoutCarrierError";
    this.fields = fields;
  }
}

/**
 * Поля, у которых носителя в нагрузке нет **сознательно**.
 *
 * Список короткий и обязан таким остаться: каждая строка — это решение «клиент
 * этого текста не увидит», принятое раньше и с названной причиной. Всё, чего
 * здесь нет, обязано найти носитель или не строиться вовсе.
 */
const CLIENT_TEXT_WITHOUT_CARRIER_BY_DESIGN: ReadonlyArray<{
  field: ClientTextField;
  /**
   * Где решение принято. Пусто — правило поля целиком; иначе исключение
   * действует ровно там, где предикат верен, и **только там**: исключение
   * шире своей причины — это выключенный сторож на страницах, о которых
   * причина ничего не говорит.
   */
  where?: (payloadSlide: Record<string, unknown>) => boolean;
}> = [
  // Методичка макета в клиентский поток не идёт: она читается как внутренний
  // жаргон и выталкивает карточки тем в подвал (PDF-40 G.1e). Исключение —
  // всюду, **кроме** карточных макетов: там у неё своё печатное поле, и там
  // её пропажу ловить надо.
  {
    field: "methodologyNote",
    where: (slide) => !CARD_STRUCTURED_TEMPLATES.has(String(slide.template ?? "")),
  },
  // Внутренний код причины (`VISUAL_ASSET_UNAVAILABLE`, `no-identity-data`), а
  // не клиентский текст: он выбирает ветку макета и до листа не доезжает.
  { field: "emptyStateReason" },
  // Вводный абзац раздела рисует только вариант `hero`; у разделителя по
  // умолчанию на листе стоит один титул, а вариант вёрстки выбирается уже
  // после того, как построитель собрал абзац. У самого `hero` абзац в нагрузку
  // попадает — там пропажа была бы дефектом.
  {
    field: "narrative",
    where: (slide) =>
      slide.template === "orion_golden_region_divider" && slide.layoutVariant !== "hero",
  },
];

/**
 * Поимённых допусков у сторожа больше нет.
 *
 * Допуск существовал ради одного шаблона: абзац `p03_executive` золотого кейса
 * уходил резаку на 892 знака и возвращался 770 — молча терялось 122
 * (воспроизведено 30.08 прогоном золотого кейса с опустошённым списком:
 * `narrative reflow dropped text: p03_executive 892->770`). Причина была в
 * резаке, а не в абзаце: он звал `splitClientParagraphs`, а тот на пределе
 * абзацев выбрасывал остаток. Резак больше не теряет знаков, поэтому список
 * пуст — и остаётся пустым: **на этом резаке** любая потеря теперь дефект, а
 * не «известная».
 *
 * **Что сторож покрывает, а что нет — сказано здесь, потому что утверждение
 * выше уже читали шире, чем оно есть.** Пары ему подаёт цикл ниже, и снимает
 * он их вокруг одного вызова — `reflowNarrativeParagraphs`. Резаков абзаца в
 * деке два, и второй остаётся без сторожа: `withContinuations`
 * (`fragment-builders/shared.ts`) на ветке **без** померенной комнаты зовёт
 * `splitClientParagraphs(narrative, narrativeBudget, 4)`, а та на пределе
 * абзацев делает `return paras` и остаток выбрасывает — тем же механизмом,
 * который вылечен здесь. У соседней, померенной ветки сторож есть
 * (`NarrativeSplitLossError`), у этой нет вовсе.
 *
 * Щель старше этой правки и ею не чинится; она записана в опись. Считать
 * молчание сторожа доказательством целости текста на непомеренных шаблонах
 * нельзя.
 *
 * Сам сторож не удалён и удалению не подлежит: он ловит **класс** —
 * «текст стал короче по обе стороны резака», — а не одну функцию.
 */
export const REFLOW_LOSS_PREEXISTING_TEMPLATES: ReadonlySet<string> = new Set([]);

/** Сравнение без пробелов: резак меняет разделители, но не должен терять знаки. */
function compactForLoss(value: string): string {
  return value.replace(/\s+/gu, "");
}

/**
 * Что резак выбросил — по обе стороны вызова, для каждого слайда.
 *
 * Проверка общая, а не для одного листа: механизм пре-существующий, и следующий
 * абзац, доросший до предела, потеряется так же тихо.
 */
export function narrativeReflowLoss(
  slides: ReadonlyArray<{ slideKey?: string; templateId?: string; before?: string; after?: string }>
): Array<{ slideKey: string; before: number; after: number }> {
  const lost: Array<{ slideKey: string; before: number; after: number }> = [];
  for (const slide of slides) {
    if (REFLOW_LOSS_PREEXISTING_TEMPLATES.has(String(slide.templateId ?? ""))) continue;
    const before = compactForLoss(String(slide.before ?? ""));
    const after = compactForLoss(String(slide.after ?? ""));
    if (before && after.length < before.length) {
      lost.push({ slideKey: String(slide.slideKey ?? "?"), before: before.length, after: after.length });
    }
  }
  return lost;
}

/**
 * Поля, которые панель распределяет по своей колонке сама.
 *
 * У них носитель на панельном слайде есть всегда — блоки `visualAnalysis`, — а
 * «сколько влезло» решает объявленная ёмкость колонки и объявленный порядок
 * важности. Список короткий и живёт рядом со сторожем, потому что нужен только
 * ему: распределитель сам ходит по полям поимённо.
 *
 * `sourceNote` сюда **не входит**: подпись источников бюджета колонки не
 * занимает — рендерер печатает её в полосе, которую `write_block` держит в
 * запасе, — и её пропажа на панели была бы такой же молчаливой потерей, как на
 * любом другом макете.
 */
const SIDEBAR_DISTRIBUTED_FIELDS: ReadonlySet<ClientTextField> = new Set([
  "narrative",
  "whatWasFound",
  "whyItMatters",
  "whatToCheck",
  "statusNote",
]);

/**
 * Клиентские поля деки, которым в нагрузке не нашлось носителя.
 *
 * Сторож выводится из **данных**, а не из таблицы «что печатает этот шаблон»:
 * таких таблиц в проекте уже две (сам рендерер и `maxBulletsPerSlide` реестра),
 * и третья разошлась бы с ними на первой же правке макета. Поэтому вопрос
 * задаётся объекту нагрузки: встречается ли текст поля хоть где-нибудь в нём —
 * своим полем, элементом списка, ячейкой таблицы или блоком `visualAnalysis`.
 *
 * Сравнивается голова в 40 знаков и по схлопнутым пробелам: до нагрузки текст
 * доезжает через резак абзацев и склейку с подзаголовком, которые меняют
 * переносы и приписывают текст спереди, но не переписывают слова.
 */
export function clientTextWithoutCarrier(
  pairs: ReadonlyArray<{ deck: RendererSlide; payload: Record<string, unknown> }>
): { missing: Array<{ slideKey: string; field: string; text: string }>; checked: number } {
  // Регистр не в счёт: подзаголовок и первое предложение абзаца — это один и
  // тот же текст разным регистром («Итоговая оценка: Высокий риск» против
  // «Итоговая оценка: высокий риск. …»), и склейка снимает повтор именно так.
  const compact = (value: string): string =>
    value.replace(/\s*\[finding-[^\]]+\]/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
  const strings = (node: unknown, out: string[]): void => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) for (const v of node) strings(v, out);
    else if (node && typeof node === "object")
      for (const v of Object.values(node)) strings(v, out);
  };
  const missing: Array<{ slideKey: string; field: string; text: string }> = [];
  let checked = 0;
  for (const { deck, payload } of pairs) {
    const carried: string[] = [];
    strings(payload, carried);
    const haystack = carried.map(compact).join(" \u0000 ");
    const panel = payload.visualAnalysis as Record<string, unknown> | undefined;
    for (const field of CLIENT_TEXT_FIELDS) {
      const value = deck[field];
      if (typeof value !== "string") continue;
      const text = compact(value);
      if (!text) continue;
      if (
        CLIENT_TEXT_WITHOUT_CARRIER_BY_DESIGN.some(
          (rule) => rule.field === field && (!rule.where || rule.where(payload))
        )
      )
        continue;
      /*
       * На панельном слайде носитель у этих полей есть — сама панель, — и
       * сколько их текста в неё влезло, решает её объявленная ёмкость
       * (`SIDEBAR_COLUMN_CHAR_BUDGET`) по объявленному порядку важности. Это
       * другой вопрос, чем «есть ли куда положить», и на него уже отвечено:
       * потеря там ограничена числом и слышна телеметрией панели
       * (`_sidebar_loss`). Сторож не должен судить её вторым правилом —
       * иначе любой бюджет колонки роняет сборку.
       */
      if (panel && SIDEBAR_DISTRIBUTED_FIELDS.has(field)) continue;
      checked += 1;
      if (!haystack.includes(text.slice(0, 40))) {
        missing.push({ slideKey: deck.slideKey, field, text });
      }
    }
    /*
     * Но панель, не сказавшая **ничего**, — это та же молчаливая потеря:
     * титулованный блок без текста под ним клиент читает как пустую страницу.
     */
    if (panel) {
      checked += 1;
      const blocks = [
        panel.headlineConclusion,
        panel.whatIsVisible,
        panel.clientMeaning,
        ...((panel.recommendedActions as unknown[]) ?? []),
        ...((panel.highlightExplanations as Array<{ clientReason?: unknown }>) ?? []).map(
          (e) => e?.clientReason
        ),
      ];
      if (!blocks.some((b) => typeof b === "string" && compact(b))) {
        missing.push({
          slideKey: deck.slideKey,
          field: "visualAnalysis",
          text: "панель собрана, но не несёт ни одного блока",
        });
      }
    }
  }
  return { missing, checked };
}

export function narrativeOverBudget(
  slides: ReadonlyArray<{ slideKey?: string; templateId?: string; narrative?: string }>
): Array<{ slideKey: string; templateId: string; length: number; budget: number }> {
  const over: Array<{ slideKey: string; templateId: string; length: number; budget: number }> = [];
  for (const slide of slides) {
    const narrative = String(slide.narrative ?? "");
    if (!narrative) continue;
    const templateId = String(slide.templateId ?? "");
    if (!SILENTLY_CLIPPED_NARRATIVE_TEMPLATES.has(templateId as DeckTemplateId)) continue;
    const budget = DECK_TEMPLATE_REGISTRY[templateId as DeckTemplateId]?.layout.narrativeCharBudget;
    if (typeof budget !== "number") continue;
    if (narrative.length > budget) {
      over.push({
        slideKey: String(slide.slideKey ?? "?"),
        templateId,
        length: narrative.length,
        budget,
      });
    }
  }
  return over;
}

/** Convert the assembled model to the existing renderer's payload shape. */
export function toRendererPayload(input: {
  deckManifest: ReportDeckManifest;
  rendererSlides: RendererSlide[];
  subjectName: string;
  /** Existing report assets; slides reference them via visualAssetRefs. */
  assets?: RendererAssetEntry[];
}): Record<string, unknown> {
  const clientTextContract = getClientTextContract();
  const assetByRef = new Map((input.assets ?? []).map((a) => [a.assetRef, a]));
  // Traceability markers ([finding-…]) stay in SectionPacks for validation,
  // but are internal IDs and never reach the client-facing renderer payload.
  const stripFindingMarkers = (text: string): string =>
    text.replace(/\s*\[finding-[^\]]+\]/gu, "").trim();
  // Renderer layouts that expect visual assets draw sidebar boxes; when a
  // slide carries no bound asset (explicit VISUAL_ASSET_UNAVAILABLE fallback)
  // we downgrade to the plain text layout — the renderer itself is untouched.
  const VISUAL_TEMPLATES = new Set([
    "orion_golden_serp_screenshot",
    "orion_golden_knowledge_panel",
    "orion_golden_surface_panel",
    "orion_golden_image_grid",
  ]);
  const usedAssetRefs = new Set<string>();
  // Шаблон реестра на провод не едет, а бюджет абзаца объявлен у него: карта
  // нужна затем, что одну раскладку рендерера делят шаблоны с разной ёмкостью.
  const templateIdOf = new Map(input.rendererSlides.map((s) => [s.slideKey, s.templateId]));
  const reflowPairs: Array<{ slideKey: string; templateId: string; before: string; after?: string }> = [];
  const finalSlides = input.rendererSlides.map((raw) => {
    // Вводный абзац и текст находки склеиваются до переноса строк: перенос
    // должен видеть весь абзац целиком, иначе он ломает его по границе кусков.
    //
    // Рекомендация в этот абзац не подмешивается там, где макет печатает её
    // собственной карточкой: на странице пустого состояния «Мы предлагаем …»
    // стояло дважды — в «Статусе сбора» и в «Что проверить».
    // Что подали резаку и что он вернул — обе стороны нужны сверке ниже:
    // после него потерянного текста уже нет, и мерить нечего.
    const beforeReflow = pageNarrativeOf(raw, raw.template);
    const afterReflow = beforeReflow ? reflowNarrativeParagraphs(beforeReflow) : raw.narrative;
    if (beforeReflow) {
      reflowPairs.push({
        slideKey: raw.slideKey,
        templateId: raw.templateId,
        before: beforeReflow,
        after: afterReflow,
      });
    }
    const s: RendererSlide = {
      ...raw,
      narrative: afterReflow,
      bullets: raw.bullets?.map((b) => reflowThemeBullet(stripFindingMarkers(b))),
    };
    const boundAssets = s.visualAssetRefs.filter((r) => assetByRef.has(r));
    for (const r of boundAssets) usedAssetRefs.add(r);
    const hasVisual = boundAssets.length > 0;
    const narrative = composeSlideNarrative(s.subtitle, s.narrative);
    const bullets = buildRendererBullets(s);
    // «Уезжает ли абзац в список» — один вопрос, и ответ на него один: тем же
    // признаком ниже решается, остаётся ли у слайда собственное поле
    // `narrative` (речь про общую ветку нагрузки — карточные шаблоны и
    // разделитель региона возвращаются раньше и склейкой не пользуются).
    //
    // Пока склейка спрашивала только «есть ли абзац и есть ли буллеты», а поле
    // рядом — ещё и «нет ли таблицы», страница с таблицей везла один и тот же
    // текст дважды. На странице с непустой таблицей это оставалось невидимым —
    // список туда не доходит; на странице с **пустой** таблицей (сводная
    // комплаенса при нуле совпадений) абзац печатался дважды: телом сверху и
    // строкой таблицы снизу, обрезанной посреди предложения.
    //
    // Обратное направление — почему у макета без таблицы абзац по-прежнему
    // едет списком: единственный шаблон, читающий только `bullets`, — это
    // `orion_golden_toc`, для него склейка единственный носитель абзаца.
    // Прозаические макеты печатают тело и список друг за другом, так что там
    // склейка решает вид страницы, а не сохранность текста.
    const narrativeMovesIntoBullets = !!narrative && !!bullets && !s.table;
    const mergedBullets = narrativeMovesIntoBullets ? [narrative, ...bullets] : bullets;

    // Structured fields for renderer layouts that consume dashboards, not
    // plain bullet lists (existing renderer contracts, unchanged).
    let keyFindings: Array<Record<string, string>> | undefined;
    let actions: Array<Record<string, string>> | undefined;
    let metrics: Array<Record<string, string>> | undefined;
    let dashboardNarrative: string | undefined;
    if (s.template === "orion_golden_executive_dashboard") {
      dashboardNarrative = narrative;
      // Сколько тем на дашборде — решает мера рендерера; маппинг маппит. Срез
      // `slice(0, 2)` был вторым ответом на тот же вопрос и молчаливым: на
      // стр. 3 живого прогона он выбросил третью тему до рендерера, и ворота
      // потерь её не видели.
      keyFindings = (s.bullets ?? []).map((b) => ({ detail: b, tone: "warn" }));
      if (s.whatToCheck) actions = [{ label: s.whatToCheck }];
      // Right-column KPI cards (audit headline numbers) — same wire contract
      // as the metrics dashboard.
      if (s.kpis?.length) {
        metrics = s.kpis.map((k) => ({ label: k.label, value: k.value, tone: k.tone ?? "neutral" }));
      }
    }
    if (s.template === "orion_golden_risk_matrix_grid" && s.table) {
      // bullets[i] carries the rich per-theme explanation aligned with rows[i]
      // (what was found + why risky + advice); level/priority is the fallback.
      // C.3 — одна тема может встретиться дважды (подтверждённая и спорная).
      // Различает их бейдж статуса, который карточка и так печатает; дублировать
      // его в заголовке не нужно. Приписанный суффикс к тому же обрезался по
      // ширине: «Внимание по линии безопасности / оборонный контур — требует»
      // (шаг 15, E4).
      // Сколько тем на листе — решает построитель по реестру шаблонов; маппинг
      // маппит. Срез на шесть строк был вторым ответом на тот же вопрос и при
      // подъёме ёмкости молча срезал бы хвост страницы.
      keyFindings = s.table.rows.map((row, i) => ({
        headline: row[0] ?? "Тема",
        detail: s.bullets?.[i] ?? `Уровень риска: ${row[1] ?? "—"}; приоритет: ${row[2] ?? "—"}.`,
        status: row[1] ?? "",
        // Тон задан ступенью, а не второй таблицей у маппинга: статусы
        // («Требует подтверждения», «Нет данных») выше warn не поднимаются.
        tone: toneForRiskLabel(row[1] ?? ""),
      }));
    }
    // KPI cards for the metrics dashboard layout (label/value/tone contract).
    // PDF-40 G.1 — the template itself is the dashboard even without KPIs.
    // Previously `isMetricsDashboard` required kpis, so regional-summary fell
    // through to mergedBullets and glued «Что обнаружено / Методология» onto
    // theme cards — text then overflowed the footer (PDF 40 p10–11, p30–31).
    const isMetricsDashboard = s.template === "orion_golden_metrics_dashboard";
    if (isMetricsDashboard && s.kpis?.length) {
      metrics = s.kpis.map((k) => ({ label: k.label, value: k.value, tone: k.tone ?? "neutral" }));
    }
    if (isMetricsDashboard && s.whatToCheck) {
      actions = [{ label: s.whatToCheck }];
    }
    const isDashboard = keyFindings !== undefined;

    // C.2 — honest empty states go to the renderer as STRUCTURED fields
    // (status narrative / why-bullets / recommendation / methodology), and the
    // no-data layout draws them as separate cards instead of one glued
    // paragraph on a 90%-empty page.
    if (CARD_STRUCTURED_TEMPLATES.has(s.template)) {
      return {
        slideKey: s.slideKey,
        sectionKey: s.sectionKey,
        template: s.template,
        title: s.title,
        pageNumber: s.pageNumber,
        totalPageCount: s.totalPageCount,
        baseSlotId: s.baseSlotId,
        isContinuation: s.isContinuation,
        continuationOf: s.continuationOf,
        continuationIndex: s.continuationIndex,
        narrative,
        bullets: withStatusNote(s.bullets ?? [], s),
        actions: s.whatToCheck ? [{ label: s.whatToCheck }] : undefined,
        methodologyNote: s.methodologyNote,
        sourceNote: s.sourceNote,
        evidenceRefs: s.evidenceRefs,
        assetRefs: boundAssets,
      };
    }

    // Section dividers draw only the title and the narrative lead (hero
    // variant); the default narrative→bullets folding would hide the lead in
    // a field the divider layout never renders.
    if (s.template === "orion_golden_region_divider") {
      return {
        slideKey: s.slideKey,
        sectionKey: s.sectionKey,
        template: s.template,
        layoutVariant: s.layoutVariant,
        title: s.title,
        pageNumber: s.pageNumber,
        totalPageCount: s.totalPageCount,
        baseSlotId: s.baseSlotId,
        isContinuation: s.isContinuation,
        continuationOf: s.continuationOf,
        continuationIndex: s.continuationIndex,
        /*
         * Вводный абзац рисует только вариант `hero` — у разделителя по
         * умолчанию на листе стоит один титул. Найдено воротами следа: на
         * страницах 10 и 37 эталона фраза «Раздел показывает, что увидит
         * банк…» не встречается нигде в 56 страницах, а телеметрия о ней
         * молчит — ветка отрисовки не исполнялась, и записывать было нечему.
         */
        narrative: s.layoutVariant === "hero" ? narrative : undefined,
        evidenceRefs: s.evidenceRefs,
        assetRefs: boundAssets,
      };
    }

    // Analytical sidebar next to a bound visual: the renderer's unified
    // sidebar panel consumes `visualAnalysis` (headline conclusion, adverse
    // highlight explanations, meaning, action, provenance) — an empty titled
    // panel is a validation failure upstream.
    const visualAnalysis = hasVisual ? buildVisualAnalysis(s) : undefined;

    /*
     * Страница AI-ответов — единственный макет с картинкой, где список
     * печатается текстом: ответ поисковика и есть содержание страницы, а
     * панель показывает лишь его начало. Отчёт 84: буллеты были в пакете,
     * рендерер был новый, а на бумаге текста не было — их обнуляла эта
     * сборка, и идентификатор шаблона до рендерера не доезжал.
     */
    const printsAnswers = s.templateId === "ai-overview";
    return {
      slideKey: s.slideKey,
      sectionKey: s.sectionKey,
      template:
        VISUAL_TEMPLATES.has(s.template) && !hasVisual ? "orion_golden_prose" : s.template,
      // Идентификатор шаблона деки: по нему рендерер узнаёт страницу AI-ответов.
      templateId: s.templateId,
      layoutVariant: s.layoutVariant,
      title: s.title,
      pageNumber: s.pageNumber,
      totalPageCount: s.totalPageCount,
      baseSlotId: s.baseSlotId,
      isContinuation: s.isContinuation,
      continuationOf: s.continuationOf,
      continuationIndex: s.continuationIndex,
      narrative: isDashboard
        ? dashboardNarrative
        : isMetricsDashboard || hasVisual
          ? isMetricsDashboard
            ? narrative
            : undefined
          : narrativeMovesIntoBullets
            ? undefined
            : narrative,
      // Visual layouts render the structured sidebar panel; the KPI dashboard
      // draws narrative/KPI/action cards; plain layouts get the merged list.
      // Без картинки страница ответов идёт прозой, и поля сайдбара едут в
      // общем списке (`mergedBullets`) — иначе у них нет носителя.
      bullets:
        isDashboard || (hasVisual && !printsAnswers)
          ? undefined
          : isMetricsDashboard || (printsAnswers && hasVisual)
            ? s.bullets
            : mergedBullets,
      // Статусная строка (доля прочитанного на странице региона) печатается
      // только там, где макет её рисует. Отдать её остальным шаблонам значило
      // бы передать текст, который никто не нарисует, — та самая беззвучная
      // потеря, ради которой этот носитель и заводился.
      statusNote: isMetricsDashboard ? s.statusNote : undefined,
      keyFindings,
      actions,
      metrics,
      visualAnalysis,
      table: s.table
        ? {
            headers: s.table.headers,
            rows: s.table.rows,
            rowAddresses: s.table.rowAddresses,
            groups: s.table.groups,
          }
        : undefined,
      evidenceRefs: s.evidenceRefs,
      assetRefs: boundAssets,
    };
  });
  // Портрет на обложку. Обложка — структурный шаблон без аналитической боковой
  // панели, поэтому привязка ассета здесь не включает проверки, которые следят
  // за соответствием панели её доказательствам.
  if (assetByRef.has("cover_portrait")) {
    usedAssetRefs.add("cover_portrait");
    for (const slide of finalSlides) {
      if (slide.template === "orion_golden_cover") {
        slide.assetRefs = ["cover_portrait"];
      }
    }
  }
  /*
   * Абзац, который рендерер молча обрежет, наружу не уходит.
   *
   * Отказ здесь громкий и возобновляемый, а пропажа половины абзаца — нет:
   * документ уедет клиенту без вывода страницы, и об этом никто не узнает.
   * Дойти сюда правка построителя не должна — её ловят сверка пакета и
   * офлайн-проверка, — но последний рубеж стоит там, где абзац уже собран
   * целиком: склейка подписи и текста находки добавляет к нему сотни знаков
   * уже после построителя.
   */
  const overBudget = narrativeOverBudget(
    finalSlides.map((s) => ({
      slideKey: s.slideKey,
      templateId: templateIdOf.get(s.slideKey),
      narrative: typeof s.narrative === "string" ? s.narrative : undefined,
    }))
  );
  if (overBudget.length > 0) throw new NarrativeOverBudgetError(overBudget);
  /*
   * Резак стоит **до** проверки бюджета, поэтому она видит уже укороченный
   * текст и потерю поймать не может по построению. Сверка по обе стороны
   * вызова — единственное место, где пропажу ещё видно.
   */
  const reflowLoss = narrativeReflowLoss(reflowPairs);
  if (reflowLoss.length > 0) throw new NarrativeReflowLossError(reflowLoss);
  /*
   * Поле, построенное для слайда, обязано доехать до его же объекта нагрузки.
   *
   * Пустой перечень проверенных полей — тоже отказ. Ворот, которому нечего было
   * проверять, печатает «ноль потерь» ровно так же, как ворот, проверивший всё:
   * именно так `everyTextFieldReachesItsPage` был зелёным на деке с 29
   * потерянными полями.
   */
  const carrier = clientTextWithoutCarrier(
    input.rendererSlides.map((deck, i) => ({ deck, payload: finalSlides[i]! }))
  );
  if (finalSlides.length > 0 && carrier.checked === 0) {
    throw new ClientTextWithoutCarrierError([
      { slideKey: "<вся дека>", field: "<перечень полей>", text: "сторож не проверил ни одного поля" },
    ]);
  }
  if (carrier.missing.length > 0) throw new ClientTextWithoutCarrierError(carrier.missing);
  return {
    reportSpec: {
      version: "deck-sections-report-spec-v1",
      subjectName: input.subjectName,
      title: `Отчёт о цифровом профиле — ${input.subjectName}`,
    },
    deckManifest: {
      version: "r10-orion-golden-deck-manifest-v1",
      slideCount: finalSlides.length,
      totalSlideCount: finalSlides.length,
      finalSlides,
      toc: input.deckManifest.toc,
      pageNumberMap: Object.fromEntries(finalSlides.map((s) => [s.slideKey, s.pageNumber])),
      sectionManifests: input.deckManifest.sectionPageRanges.map((r) => ({
        sectionKey: r.sectionType,
        slideCount: r.lastPage - r.firstPage + 1,
        slides: [],
      })),
    },
    /** REMEDIATION §6.1 — renderer must not depend on app FS for text rules. */
    clientTextContract,
    clientTextContractVersion: clientTextContract.version,
    assets: (input.assets ?? [])
      .filter((a) => usedAssetRefs.has(a.assetRef))
      // image_grid captions render at the page bottom and collide with the
      // full-bleed grid image; the grids carry their own baked-in labels.
      .map((a) => (a.kind === "image_grid" ? { ...a, caption: "" } : a)),
  };
}

/**
 * Что именно получит `ctx.bullets` этой страницы пейлоада.
 *
 * У дашборда список рисуется из `keyFindings`, у остальных — из `bullets`.
 * Спрашивать это надо у пейлоада, а не у деки: между ними лежит склейка
 * страницы, и она — часть ответа.
 */
export function rendererBulletItemsOf(payloadSlide: Record<string, unknown>): string[] {
  const findings = payloadSlide.keyFindings as Array<{ detail?: string }> | undefined;
  if (findings) return findings.map((f) => String(f.detail ?? ""));
  return ((payloadSlide.bullets as string[] | undefined) ?? []).map((b) => String(b));
}

/**
 * Разрез «элемент списка рендерера ↔ буллет деки».
 *
 * Живёт рядом с самой склейкой и обязан меняться вместе с ней: мера приходит по
 * элементам списка, а перекладывать надо буллеты деки, и ошибка на единицу
 * увезла бы блок не на ту страницу. Разрез выводится из данных, а не из копии
 * ветвлений склейки: ссылка на источник узнаётся по совпадению с последним
 * элементом, вводный абзац — по остатку длины. Не сошлось (появился новый вид
 * склейки) — честный `null`: лучше не перекладывать страницу вовсе, чем
 * сдвинуть блок наугад.
 */
export function bulletItemFoldOf(input: {
  payloadItems: readonly string[];
  deckBullets: readonly string[];
  sourceNote?: string;
  statusNote?: string;
}): BulletItemFold | null {
  const items = [...input.payloadItems];
  // Вклейки хвоста снимаются в обратном порядке приклеивания: сначала
  // статусная строка, потом ссылка на источник (см. `withStatusNote` и
  // `buildRendererBullets`). Узнаётся каждая по совпадению с последним
  // элементом — из данных, а не копией ветвлений склейки.
  let trailing = 0;
  for (const tail of [input.statusNote, input.sourceNote]) {
    if (tail && items.length > 0 && items[items.length - 1] === tail) {
      items.pop();
      trailing += 1;
    }
  }
  const leading = items.length - input.deckBullets.length;
  if (leading < 0 || leading > 1) return null;
  return { leading, trailing };
}

/**
 * Sidebar text must be complete sentences without ellipsis (renderer QA).
 * PDF-36 D.1 — cut ONLY on sentence boundaries: a shorter complete thought
 * beats a longer broken one («…зафиксирован 1 результат, относящийся к.»).
 * Exported for unit tests.
 */
export function sidebarSafe(text: string | undefined, budget = 240): string | undefined {
  if (!text) return undefined;
  const out = text.replace(/\s*(\.\.\.|…)\s*/gu, ". ").replace(/\.\s*\./gu, ".").trim();
  if (out.length <= budget) return out || undefined;
  // Keep whole sentences that fit the budget.
  const sentences = out.split(/(?<=[.!?…])\s+/u);
  const kept: string[] = [];
  let used = 0;
  for (const s of sentences) {
    const extra = (kept.length > 0 ? 1 : 0) + s.length;
    if (used + extra > budget) break;
    kept.push(s);
    used += extra;
  }
  /*
   * Не влезло даже первое предложение — блок не получает ничего.
   *
   * Прежде здесь стоял рез по границе слова с точкой в конце, и панель
   * печатала «…уровень внимания — высокий; оценка.» — фразу, оборванную на
   * половине мысли. Короткое целое предложение лучше длинного сломанного, а
   * пустой блок лучше огрызка: заголовка без текста под ним панель не рисует
   * (`write_block` выходит на пустом теле), и место достаётся следующему по
   * важности блоку.
   */
  return kept.length > 0 ? kept.join(" ") : undefined;
}

/**
 * Structured content of the analytical sidebar next to a bound visual:
 * static context (template methodology), dynamic conclusion, why relevant or
 * why adverse, confidence/status and recommended action.
 *
 * Блоки притязают на ёмкость колонки **по важности**, а не по порядку чтения.
 *
 * Ёмкость одна — `SIDEBAR_COLUMN_CHAR_BUDGET`; бюджеты полей ниже это потолки
 * читаемости («сколько уместно дать одному блоку»), и в сумме они дают вдвое
 * больше, чем колонка держит. Пока разницу выбирал рендерер, он выбирал её
 * снизу, то есть последним нарисованным блоком, — и на семи страницах живого
 * прогона 92 клиент видел риск и не видел, что с ним делать.
 *
 * Порядок притязания — решение продуктовое:
 *
 *   1. вывод — то, ради чего страницу вообще открывают;
 *   2. рекомендация — то, ради чего клиент платит за отчёт;
 *   3. объяснения рамок — **раньше значимости**, потому что рамка без
 *      объяснения нарушает правило «Объяснение — на каждую рамку»: при
 *      обратном порядке четыре страницы прогона 92 остались бы с выделенными
 *      материалами и без единой фразы о том, почему они выделены;
 *   4. значимость и статусная строка;
 *   5. абзац страницы — на остатке; на страницах без рамок его текст всё равно
 *      печатается средним блоком (`mid_body = visible or meaning`).
 *
 * Порядок **отрисовки** при этом прежний: вывод, средний блок, «Что это
 * значит», «Что сделать».
 */
function buildVisualAnalysis(s: RendererSlide): Record<string, unknown> {
  /*
   * Каждый блок панели говорит своё.
   *
   * Три блока берутся из полей, которые выше по течению перекрываются:
   * `narrative` начинается с того же, что лежит в `whatWasFound`, а его хвост —
   * это `whyItMatters`, из которого собран третий блок. На боевом прогоне
   * 28.07 страница «ОАЭ — изображения в поиске» печатала одно предложение
   * трижды подряд, и таких страниц в отчёте полтора десятка. Для клиента,
   * который платит за отчёт, это самый заметный признак халтуры.
   *
   * Правило простое: предложение, уже сказанное выше, ниже не повторяется.
   * Порядок обхода — тот же порядок важности: наверху вывод, следом
   * рекомендация. Пока обход шёл порядком чтения, `whatIsVisible` забирал себе
   * склеенный абзац страницы, а тот последним блоком содержит сам
   * `whatToCheck` (`composeFindingProse`) — предложение помечалось сказанным, и
   * `recommendedActions` выходил пустым на всех 16 панелях эталона-72.
   */
  const said = new Set<string>();
  // Колонка ужимается по мере рендерера: потерявшая блок страница берёт долю
  // объявленного бюджета, а не весь его.
  let left = Math.round(SIDEBAR_COLUMN_CHAR_BUDGET * (s.sidebarBudgetScale ?? 1));
  /** Взять текст в свой потолок, но не больше остатка колонки. */
  const claim = (text: string | undefined, cap: number): string | undefined => {
    const kept = withoutRepeatedSentences(sidebarSafe(text, Math.min(cap, left)), said);
    if (kept) left -= kept.length;
    return kept;
  };

  const headlineConclusion = claim(s.whatWasFound, 300) ?? claim(s.narrative, 300);
  const action = claim(s.whatToCheck, 260);
  /*
   * Объяснения повторов не снимают: их текст называет свой материал, и
   * дедупликация против вывода оставила бы рамку без объяснения. Место они
   * берут наравне со всеми — колонка одна.
   */
  const rawExplanations = s.highlightExplanations ?? [];
  const explanations: Array<{ clientReason: string; frameTone: "red" | "amber" }> = [];
  for (const h of rawExplanations) {
    if (explanations.length >= SIDEBAR_HIGHLIGHT_SLOTS) break;
    const reason = sidebarSafe(h.clientReason, Math.min(SIDEBAR_HIGHLIGHT_BUDGET, left));
    if (!reason) continue;
    left -= reason.length;
    explanations.push({ clientReason: reason, frameTone: h.frameTone });
  }
  // На странице с рамками «почему адверсно» несут сами объяснения; блок
  // значимости оставляет себе смысл для клиента (включая видимое ограничение
  // покрытия) и статусную строку.
  const clientMeaning =
    [claim(s.whyItMatters, 300), claim(s.statusNote, 140)].filter(Boolean).join(" ") || undefined;
  /*
   * Запасное значение выбирается **до** притязания, а не после.
   *
   * Методичка макета — текст на случай, когда своего абзаца у страницы нет
   * вовсе (страница-продолжение подсказок): она объясняет, что за раздел, но
   * ничего не говорит о субъекте. Если бы она подставлялась после того, как
   * абзац целиком ушёл в вышестоящие блоки, клиент читал бы её на **каждой**
   * такой странице — вместо своего текста и в самом заметном месте панели.
   *
   * Выбор идёт по **пустоте**, а не по `null`: схема пакета объявляет абзац
   * как `z.string().optional()` без `.min(1)`, то есть пустая строка законна,
   * а `??` её пропускает. На слайде формы «продолжение подсказок» это давало
   * панель без единого блока — и сторож носителя ронял всю сборку отчёта.
   */
  const whatIsVisible = claim(s.narrative || s.methodologyNote, 420);
  return {
    sidebarMode: explanations.length ? "adverse_explanation" : "context",
    headlineConclusion,
    whatIsVisible,
    clientMeaning,
    highlightExplanations: explanations,
    /*
     * «Ещё N похожих сигналов» считается **после** распределения: обещание
     * обязано называть именно тех, кому места не досталось, иначе клиент не
     * сложит показанное с обещанным.
     */
    moreSignalsCount: Math.max(0, rawExplanations.length - explanations.length),
    recommendedActions: action ? [action] : [],
    /*
     * Подпись источников бюджета колонки не занимает: рендерер печатает её в
     * полосе, которую `write_block` держит в запасе (160 000 EMU) под всеми
     * блоками, и в их укладке она не участвует.
     *
     * Потолок здесь снимает **вторую** фразу (у региональной сноски за
     * перечнем площадок идёт «Данные собраны …»), а не режет первую: сноска —
     * одно предложение по построению, и правило «целые предложения или
     * ничего» унесло бы её целиком. Цена такой пропажи — не подрезанная
     * строка мелким шрифтом, а отказ **всей сборки**: носителя у поля
     * `sourceNote` не остаётся, и сторож объявляет потерю. Запас до предела
     * маленький (самая длинная сноска корпусов — 100 знаков), а снятие срезов
     * этим же шагом двигает длину вверх: «и ещё 1» → «и ещё 182».
     *
     * Если же одна фраза длиннее потолка, подпись **укорачивается**, а не
     * исчезает и не едет целиком: полоса под панелью держит одну строку 9 pt,
     * и вторая уходит чернилами за низ сцены. Режет общий помощник клиентского
     * текста, а не второй резак: обрыв по слову с уборкой повисшего хвоста.
     */
    provenanceLabel:
      sidebarSafe(s.sourceNote, 140) || clampClientText(s.sourceNote ?? "", 140) || undefined,
  };
}

/**
 * Нормализатор и снятие повторов живут в `text-compare`, чтобы ими могли
 * пользоваться и сборщик деки, и вычистка присказок, и склейка абзаца
 * страницы, не замыкая импорты в кольцо. Здесь оставлены ре-экспорты: на них
 * ссылаются проверки панели.
 */
export { normalizeForCompare, withoutRepeatedSentences };

/**
 * Подзаголовок перед абзацем — но не тогда, когда абзац им же и начинается.
 *
 * На резюме получалось «Итоговая оценка: Высокий риск / Итоговая оценка:
 * высокий риск. Основные основания: …» — одна и та же фраза дважды подряд,
 * потому что подзаголовок и первое предложение говорят одно и то же разным
 * регистром. Склейка «в лоб» этого не видела.
 */
export function composeSlideNarrative(
  subtitle: string | undefined,
  narrative: string | undefined
): string | undefined {
  const sub = (subtitle ?? "").trim();
  const body = (narrative ?? "").trim();
  if (!sub) return body || undefined;
  if (!body) return sub;
  const subKey = normalizeForCompare(sub);
  // Повтором считается только начало абзаца: совпадение где-то в середине —
  // это законное упоминание темы, а не дубль заголовка.
  if (subKey && normalizeForCompare(body).startsWith(subKey)) return body;
  return `${sub}\n${body}`;
}

function buildRendererBullets(s: RendererSlide): string[] | undefined {
  /*
   * У шаблона без списка поле не заполняется вовсе.
   *
   * Ёмкость списка отвечает на этот вопрос одна, но применял её только
   * пагинатор построителя — к `s.bullets`. Ссылка на источник добавляется
   * позже, здесь, и в досягаемость ёмкости не попадала: страница выдачи с
   * непустой таблицей везла один буллет («Источники — …») на всех 18 листах
   * эталона и не печатала его ни на одном — при непустой таблице ветка
   * `elif bullets` рендерера не исполняется. Адреса материалов стоят полосой
   * под каждой строкой, так что клиент от этого ничего не терял.
   */
  if (!rendererTemplateHasBulletList(s.template)) return undefined;
  const bullets: string[] = [...(s.bullets ?? [])];
  // PDF-40 G.1e — methodology stays on the structured no-data layout only;
  // never append it into the client bullet stream (reads as internal jargon
  // and pushes theme cards into the footer).
  //
  // Текст находки больше сюда не попадает: он идёт абзацем в narrative
  // (см. composeFindingProse). Происхождение остаётся отдельной строкой —
  // это не утверждение о субъекте, а ссылка на источник.
  if (s.sourceNote) bullets.push(s.sourceNote);
  return withStatusNote(bullets, s);
}

/**
 * Статусная строка едет потоком списка.
 *
 * Своего печатного поля у неё нет ни у одного макета, кроме дашборда метрик, —
 * и до этой правки она молча пропадала на странице проверки Википедии и на
 * прозаической странице AI-ответов. Правило одно на оба места, где список
 * собирается: общая ветка нагрузки и карточные макеты, которые возвращаются
 * раньше со своим набором полей.
 */
function withStatusNote(bullets: readonly string[], s: RendererSlide): string[] | undefined {
  const all = s.statusNote ? [...bullets, s.statusNote] : [...bullets];
  return all.length ? all : undefined;
}

export function hashOfFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
