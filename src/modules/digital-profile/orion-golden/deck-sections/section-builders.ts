/**
 * Independent section builders. Every fragment is built from its own scoped
 * input and persisted as a standalone SectionPack; unchanged fragments are
 * reused by inputHash + promptVersion without regeneration.
 */

import { createHash } from "node:crypto";
import type { FragmentKey, SectionPackV2, SectionType } from "./contracts";
import { contentHashOf, SECTION_PACK_SCHEMA_VERSION } from "./contracts";
import { getFragmentPrompt } from "./prompts";
import {
  buildScopedInput,
  scopedInputHash,
  type FragmentScope,
  type MetricSnapshot,
  type ScopedEvidenceIndex,
  type ScopedFragmentInput,
  type SubjectProfileInput,
} from "./scoped-input";
import {
  buildAppendixFragment,
  buildComplianceFragment,
  buildDigitalProfileOverviewFragment,
  buildExecutiveSummaryFragment,
  buildFrontMatterFragment,
  buildIdentityFragment,
  buildImagesFragment,
  buildKnowledgeAiFragment,
  buildRegionalSummaryFragment,
  buildRelatedQueriesFragment,
  buildRiskMatrixFragment,
  buildSerpFragment,
  buildSerpScreenshotFragment,
  buildSuggestionsFragment,
  type FragmentBuildOutput,
  type FragmentExtras,
} from "./fragment-builders";
import { slotsForFragment } from "./canonical-slots";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { Finding } from "../contracts/finding";
import type { SurfaceAnalysisUnit } from "../contracts/surface-analysis";
import type { SurfaceKind } from "../contracts/common";

/**
 * Пакет не сходился со своим хэшем, и хэш перештампован.
 *
 * Так выглядит либо пакет, записанный прежней формулой хэша, либо правка файла
 * руками. Пересчёт стирает единственный след этого состояния, поэтому след
 * переносится в журнал сборки: он уезжает в `section-build-log.json`, то есть
 * остаётся в артефактах прогона.
 */
export const CONTENT_HASH_REPAIRED = "content-hash-repaired" as const;

export type SectionBuildLogEntry = {
  fragmentKey: FragmentKey;
  action: "REGENERATED" | "REUSED_CACHE";
  /** `content-hash-repaired:<прежний хэш>` — иначе поля нет вовсе. */
  warning?: string;
};

export type SectionBuildContext = {
  caseId: string;
  reportRunId: string;
  sourceDatasetId: string;
  contentVersion: string;
  subject: SubjectProfileInput;
  bundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
  evidenceIndex: ScopedEvidenceIndex;
  extras: FragmentExtras;
  /** Previously persisted packs for cache reuse (contentHash/inputHash). */
  previousPacks?: Map<FragmentKey, SectionPackV2>;
  /** Build log: which fragments were regenerated vs reused. */
  buildLog?: SectionBuildLogEntry[];
  /**
   * Уже собранные разделы — доступны фрагментам, которые строятся последними.
   *
   * Резюме собиралось первым, из тех же исходных находок, что и разделы, а не
   * из написанных разделов. Поэтому оно пересказывало те же данные другими
   * словами и расходилось с ними в акцентах, а про раздел, свернувшийся из-за
   * нехватки данных, не знало вовсе и продолжало обещать его содержание.
   *
   * Порядок сборки теперь двухфазный (см. `buildAllSections`), и этому полю
   * положено быть заполненным только на второй фазе.
   */
  builtPacks?: Map<FragmentKey, SectionPackV2>;
};

const RISK_ORDER: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
// Related-queries fragments own canonical base slots (p20..p22, p32) and are
// therefore required; only the appendix has no canonical slot.
const OPTIONAL_FRAGMENTS: FragmentKey[] = ["APPENDIX_MAIN"];

/**
 * Поверхности, из которых строится таблица покрытия региона.
 *
 * Резюме региона получало только проверку URL, а таблица на соседнем слоте
 * перечисляет поверхности выдачи — результаты, подсказки, связанные запросы,
 * изображения, справочники, ИИ-ответы. Строк по ним не появлялось никогда:
 * они были отфильтрованы до построителя. На живом прогоне, где проверки URL
 * не было, страница «ОАЭ — метрики покрытия» состояла из заголовка и двух
 * строк, повторяющих числа предыдущей страницы.
 */
const COVERAGE_TABLE_SURFACES: SurfaceKind[] = [
  "url_audit",
  "organic",
  "suggestions",
  "paa_related",
  "images",
  "wikipedia",
  "ai_answers",
];

function fragmentScope(key: FragmentKey): FragmentScope {
  const ruScope = (surfaces: SurfaceKind[] | null): FragmentScope => ({
    regions: ["RU"],
    surfaces,
    subjectMatch: ["SUBJECT_MATCH"],
    findingIds: null,
  });
  const uaeScope = (surfaces: SurfaceKind[] | null): FragmentScope => ({
    regions: ["UAE"],
    surfaces,
    subjectMatch: ["SUBJECT_MATCH"],
    findingIds: null,
  });
  switch (key) {
    case "FRONT_MATTER_MAIN":
      // Cover + reserved TOC slot: no analytical inputs at all — finding
      // edits must never regenerate front matter.
      return { regions: null, surfaces: [], subjectMatch: ["SUBJECT_MATCH"], findingIds: [] };
    case "EXECUTIVE_SUMMARY":
    case "DIGITAL_PROFILE_OVERVIEW":
      // Findings + metric snapshot only: per-surface claim changes must not
      // invalidate executive fragments unless findings/summary change.
      // KPI / confirmed themes stay SUBJECT_MATCH only (§2.1).
      return { regions: null, surfaces: [], subjectMatch: ["SUBJECT_MATCH"], findingIds: null };
    case "RISK_MATRIX":
      // Confirmed themes + LIKELY «Требует подтверждения» (§2.1).
      return {
        regions: null,
        surfaces: [],
        subjectMatch: ["SUBJECT_MATCH", "LIKELY_SUBJECT"],
        findingIds: null,
      };
    case "RU_SUMMARY":
      // Все находки региона плюс поверхности, из которых собрана таблица
      // покрытия на слоте метрик (p08 / p25): сколько собрано на каждой
      // поверхности и сколько там негативного.
      return { ...ruScope([]), unitSurfaces: COVERAGE_TABLE_SURFACES };
    case "RU_SERP":
    case "RU_SERP_SCREENSHOT":
      return ruScope(["organic"]);
    case "RU_SUGGESTIONS":
      return ruScope(["suggestions"]);
    case "RU_IMAGES":
      return ruScope(["images"]);
    case "RU_IDENTITY_WIKIPEDIA":
      return ruScope(["wikipedia"]);
    case "RU_KNOWLEDGE_AI":
      return ruScope(["ai_answers"]);
    case "RU_RELATED":
      return ruScope(["paa_related"]);
    case "UAE_SUMMARY":
      return { ...uaeScope([]), unitSurfaces: COVERAGE_TABLE_SURFACES };
    case "UAE_SERP":
    case "UAE_SERP_SCREENSHOT":
      return uaeScope(["organic"]);
    case "UAE_SUGGESTIONS":
      return uaeScope(["suggestions"]);
    case "UAE_IMAGES":
      return uaeScope(["images"]);
    case "UAE_IDENTITY_WIKIPEDIA":
      return uaeScope(["wikipedia"]);
    case "UAE_KNOWLEDGE_AI":
      return uaeScope(["ai_answers"]);
    case "UAE_RELATED":
      return uaeScope(["paa_related"]);
    case "COMPLIANCE_MAIN":
      return { regions: null, surfaces: ["compliance"], subjectMatch: ["SUBJECT_MATCH"], findingIds: null };
    case "APPENDIX_MAIN":
      // Findings-only scope: appendix lists likely/ambiguous/foreign findings and
      // must not be invalidated by per-surface claim changes.
      return {
        regions: null,
        surfaces: [],
        subjectMatch: ["LIKELY_SUBJECT", "AMBIGUOUS", "OTHER_SUBJECT"],
        findingIds: null,
      };
  }
}

function sectionTypeOf(key: FragmentKey): SectionType {
  if (key === "FRONT_MATTER_MAIN") return "FRONT_MATTER";
  if (key === "COMPLIANCE_MAIN") return "COMPLIANCE";
  if (key === "APPENDIX_MAIN") return "APPENDIX";
  if (key.startsWith("RU_")) return "RU_PROFILE";
  if (key.startsWith("UAE_")) return "UAE_PROFILE";
  return "EXECUTIVE";
}

function composeFragment(
  key: FragmentKey,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const section = sectionTypeOf(key);
  const region = key.startsWith("RU_") ? "Россия" : key.startsWith("UAE_") ? "ОАЭ / международный" : "";
  switch (key) {
    case "FRONT_MATTER_MAIN":
      return buildFrontMatterFragment(section, scoped, extras);
    case "EXECUTIVE_SUMMARY":
      return buildExecutiveSummaryFragment(section, scoped, extras);
    case "RISK_MATRIX":
      return buildRiskMatrixFragment(section, scoped, extras);
    case "DIGITAL_PROFILE_OVERVIEW":
      return buildDigitalProfileOverviewFragment(section, scoped);
    case "RU_SUMMARY":
    case "UAE_SUMMARY":
      return buildRegionalSummaryFragment(key, section, region, scoped, extras);
    case "RU_SERP":
    case "UAE_SERP":
      return buildSerpFragment(key, section, region, scoped, extras);
    case "RU_SERP_SCREENSHOT":
    case "UAE_SERP_SCREENSHOT":
      return buildSerpScreenshotFragment(key, section, region, scoped, extras);
    case "RU_SUGGESTIONS":
    case "UAE_SUGGESTIONS":
      return buildSuggestionsFragment(key, section, region, scoped, extras);
    case "RU_IMAGES":
    case "UAE_IMAGES":
      return buildImagesFragment(key, section, region, scoped, extras);
    case "RU_IDENTITY_WIKIPEDIA":
    case "UAE_IDENTITY_WIKIPEDIA":
      return buildIdentityFragment(key, section, region, scoped);
    case "RU_KNOWLEDGE_AI":
    case "UAE_KNOWLEDGE_AI":
      return buildKnowledgeAiFragment(key, section, region, scoped, extras);
    case "RU_RELATED":
    case "UAE_RELATED":
      return buildRelatedQueriesFragment(key, section, region, scoped, extras);
    case "COMPLIANCE_MAIN":
      return buildComplianceFragment(section, scoped, extras);
    case "APPENDIX_MAIN":
      return buildAppendixFragment(section, scoped);
  }
}

/**
 * Отпечаток входа фрагмента — то, чем ключуется кэш пакета.
 *
 * Вынесен наружу ради проверки: «состояние документа меняет ключ» — это
 * утверждение о кэше, и проверять его надо тем же выражением, каким кэш
 * ключуется, а не пересборкой отчёта.
 */
export function fragmentInputHash(
  key: FragmentKey,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): string {
  return `${scopedInputHash(scoped)}:${extrasHash(key, extras)}`;
}

function extrasHash(key: FragmentKey, extras: FragmentExtras): string {
  const base =
    key === "EXECUTIVE_SUMMARY"
      ? {
          executiveSummary: extras.executiveSummary ?? null,
          composedClientSummary: extras.composedClientSummary
            ? {
                schemaVersion: extras.composedClientSummary.schemaVersion,
                caseId: extras.composedClientSummary.caseId,
                themeIds: extras.composedClientSummary.sections.themes.map((t) => t.themeId),
                fullTextHash: createHash("sha256")
                  .update(extras.composedClientSummary.fullText)
                  .digest("hex")
                  .slice(0, 16),
              }
            : null,
        }
      : key === "COMPLIANCE_MAIN"
        ? {
            narrative: extras.complianceNarrative ?? null,
            // Итог скрининга выбирает формулировку пустой страницы базы —
            // значит, он вход фрагмента, и его изменение обязано пересобрать
            // пакет, а не взяться из кэша.
            screenings: extras.complianceScreenings ?? [],
          }
        : key === "RU_SUMMARY" || key === "UAE_SUMMARY"
          ? extras.uncategorizedMaterials ?? null
          : // Решение о персоне печатает один лист — его пакет от него и
            // зависит. Отдать его всем ключам значило бы обесценить каждый
            // готовый пакет прогона, где решение просто появилось.
            key === "FRONT_MATTER_MAIN"
              ? {
                  personaDecision: extras.personaDecision ?? null,
                  // Обложку печатает этот же пакет. Не входи состояние в ключ,
                  // выпуск взял бы обложку черновика из кэша и напечатал бы
                  // клиенту слово «черновик».
                  documentState: extras.documentState ?? null,
                }
              : null;
  const slots = slotsForFragment(key);
  // Visual asset bindings are fragment inputs: adding/removing an asset for a
  // slot the fragment owns must regenerate it (layout templates are NOT here —
  // template-only changes never invalidate packs).
  const slotAssets = Object.fromEntries(
    slots.map((s) => [s.slotId, extras.visualAssets?.[s.slotId] ?? []])
  );
  // Раскрой выбирает состав каждого листа таблицы, его опоры, его фразу с
  // номерами строк и его счётчики — значит, он вход фрагмента, и его появление
  // обязано пересобрать пакет. Не входи он в ключ, пакет, записанный сидовым
  // (мерный прогон застал рендерер прошлой версии — службы поднимаются по
  // отдельности), переиспользовался бы и после того, как раскрой появился: лист
  // остался бы с тремя строками до следующего подъёма версии содержимого, без
  // отказа и без телеметрии. Цена — промах кэша на **черновой** сборке, у
  // которой раскроя ещё нет: процессорное время без обращения к модели, потому
  // что клиентский текст приезжает стадией 2, а не сборкой фрагмента.
  //
  // Ключ симметричен, и вторая сторона стоит денег. Пересборка отчёта, у
  // которой меры нет вовсе (рендерер прошлой версии, офлайн-сборка, пустой
  // вердикт), обнуляет раскрой: ключ возвращается к сидовому, и **настоящая**
  // сборка пишет `REGENERATED`. У свежего пакета поля `gptCopy` нет, а
  // `isGptCopyCacheHit` без него отвечает «нет» — значит стадия 2 оплачивается
  // заново для `RU_SERP` и `UAE_SERP`, и раздел выдачи в том же прогоне
  // возвращается с четырёх листов на десять. Содержимое при этом не пропадает
  // и отказа нет: это трата и рост документа, а не окно деплоя.
  //
  // Берутся только слоты этого фрагмента: раскрой выдачи ОАЭ не повод платить
  // за пересборку российской. Порядок задан сортировкой, чтобы ключ зависел от
  // содержимого раскроя, а не от порядка страниц, в котором его собрали.
  const tableCut = [...(extras.tableCut ?? [])]
    .filter(([cutKey]) => slots.some((s) => cutKey.startsWith(`${s.slotId}|`)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(
      JSON.stringify({
        base,
        slotAssets,
        tableCut,
        surfaceCollectionHints: extras.surfaceCollectionHints ?? [],
        materialFreshness: extras.materialFreshness ?? null,
        reportDiff: extras.reportDiff ?? null,
      })
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Пакет со своим собственным хэшем — и признак того, что хэш пришлось починить.
 *
 * Один ответ для обоих входов: ветки реюза и записи на диск (`prebuiltPacks`
 * точечного ретрая стадии 2 приходят из `loadPreviousPacks` мимо реюза).
 */
export function packWithOwnContentHash(pack: SectionPackV2): {
  pack: SectionPackV2;
  repairedFrom: string | null;
} {
  const own = contentHashOf(pack.slides);
  if (own === pack.contentHash) return { pack, repairedFrom: null };
  return { pack: { ...pack, contentHash: own }, repairedFrom: pack.contentHash };
}

export function buildSectionPackForFragment(
  key: FragmentKey,
  ctx: SectionBuildContext
): SectionPackV2 {
  const prompt = getFragmentPrompt(key);
  const scoped = buildScopedInput({
    subject: ctx.subject,
    bundle: ctx.bundle,
    surfaceUnits: ctx.surfaceUnits,
    metricSnapshot: ctx.metricSnapshot,
    scope: fragmentScope(key),
    evidenceIndex: ctx.evidenceIndex,
    surfaceCollectionHints: ctx.extras.surfaceCollectionHints,
  });
  const inputHash = fragmentInputHash(key, scoped, ctx.extras);

  // Cache: identical inputHash + promptVersion reuses the persisted pack —
  // no regeneration and (on LLM fragments) no new LLM call.
  const previous = ctx.previousPacks?.get(key);
  if (
    previous &&
    previous.inputHash === inputHash &&
    previous.promptVersion === prompt.promptVersion &&
    previous.contentVersion === ctx.contentVersion &&
    previous.reportRunId === ctx.reportRunId &&
    previous.sourceDatasetId === ctx.sourceDatasetId &&
    previous.caseId === ctx.caseId &&
    previous.datasetId === ctx.sourceDatasetId &&
    previous.status !== "INSUFFICIENT_DATA" &&
    previous.status !== "FAILED"
  ) {
    // Хэш пересчитывается о слайды, которые реюзятся. На пакете, записанном
    // каноном, это тождественная операция; пакет, лежащий на боевом томе с
    // хэшем прежней формулы, за один прогон приходит в согласие с собственным
    // содержимым — без пересборки и без обращения к модели. Иначе «файл сходится
    // со своим хэшем» осталось бы обещанием только для файлов, записанных после
    // выката.
    const repaired = packWithOwnContentHash(previous);
    ctx.buildLog?.push({
      fragmentKey: key,
      action: "REUSED_CACHE",
      ...(repaired.repairedFrom
        ? { warning: `${CONTENT_HASH_REPAIRED}:${repaired.repairedFrom}` }
        : {}),
    });
    return repaired.pack;
  }

  const output = composeFragment(key, scoped, ctx.extras);
  const contentHash = contentHashOf(output.slides);

  const adverseFindings = scoped.findings.filter((f) => (RISK_ORDER[f.riskLevel] ?? 0) >= 2);
  const displayedFindingIds = new Set(output.slides.flatMap((s) => s.findingIds));
  const displayedRefs = new Set(output.slides.flatMap((s) => s.evidenceRefs));
  // Fragment evidence scope = finding/unit refs + the scoped evidence index
  // (region+surface-scoped observation rows, e.g. bound snapshot rows).
  // Every slide's evidenceRefs must stay a subset of this set (fail-closed
  // check in section QA).
  const datasetRefs = new Set<string>([
    ...scoped.findings.flatMap((f) => f.evidenceRefs),
    ...scoped.surfaceUnits.flatMap((u) => u.evidenceRefs),
    ...Object.keys(scoped.evidenceIndex),
  ]);

  const sourceFindingIds = scoped.findings.map((f) => f.findingId);
  const evidenceRefs = [...datasetRefs];
  const pack: SectionPackV2 = {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: sectionTypeOf(key),
    sectionType: sectionTypeOf(key),
    fragmentKey: key,
    caseId: ctx.caseId,
    datasetId: ctx.sourceDatasetId,
    reportRunId: ctx.reportRunId,
    sourceDatasetId: ctx.sourceDatasetId,
    contentVersion: ctx.contentVersion,
    promptVersion: prompt.promptVersion,
    contentHash,
    inputHash,
    generatedAt: new Date().toISOString(),
    required: !OPTIONAL_FRAGMENTS.includes(key),
    status: output.status,
    sourceFindingIds,
    evidenceRefs,
    inputs: {
      findingIds: sourceFindingIds,
      evidenceRefs,
      metricSnapshotId: ctx.metricSnapshot.metricSnapshotId,
    },
    slides: output.slides,
    metrics: {
      datasetCount: datasetRefs.size,
      displayedCount: displayedRefs.size,
      adverseDatasetCount: adverseFindings.length,
      adverseDisplayedCount: adverseFindings.filter((f) => displayedFindingIds.has(f.findingId))
        .length,
    },
    provenance: {
      providers: [...new Set(scoped.findings.flatMap((f) => f.providers ?? []))],
      reportRunIds: [ctx.reportRunId],
      evidenceRefs: [...displayedRefs],
    },
    validation: { passed: true, issues: [] },
  };
  ctx.buildLog?.push({ fragmentKey: key, action: "REGENERATED" });
  return pack;
}

// --- Section-level entry points (each builds only its own fragments) ---

export function buildFrontMatterSection(ctx: SectionBuildContext): SectionPackV2[] {
  return [buildSectionPackForFragment("FRONT_MATTER_MAIN", ctx)];
}

export function buildExecutiveSection(ctx: SectionBuildContext): SectionPackV2[] {
  return [
    buildSectionPackForFragment("EXECUTIVE_SUMMARY", ctx),
    buildSectionPackForFragment("RISK_MATRIX", ctx),
    buildSectionPackForFragment("DIGITAL_PROFILE_OVERVIEW", ctx),
  ];
}

export function buildRuProfileSection(ctx: SectionBuildContext): SectionPackV2[] {
  const keys: FragmentKey[] = [
    "RU_SUMMARY",
    "RU_SERP",
    "RU_SERP_SCREENSHOT",
    "RU_SUGGESTIONS",
    "RU_IMAGES",
    "RU_IDENTITY_WIKIPEDIA",
    "RU_KNOWLEDGE_AI",
    "RU_RELATED",
  ];
  return keys.map((k) => buildSectionPackForFragment(k, ctx));
}

export function buildUaeProfileSection(ctx: SectionBuildContext): SectionPackV2[] {
  const keys: FragmentKey[] = [
    "UAE_SUMMARY",
    "UAE_SERP",
    "UAE_SERP_SCREENSHOT",
    "UAE_SUGGESTIONS",
    "UAE_IMAGES",
    "UAE_IDENTITY_WIKIPEDIA",
    "UAE_KNOWLEDGE_AI",
    "UAE_RELATED",
  ];
  return keys.map((k) => buildSectionPackForFragment(k, ctx));
}

export function buildComplianceSection(ctx: SectionBuildContext): SectionPackV2[] {
  return [buildSectionPackForFragment("COMPLIANCE_MAIN", ctx)];
}

export function buildAppendixSection(ctx: SectionBuildContext): SectionPackV2[] {
  return [buildSectionPackForFragment("APPENDIX_MAIN", ctx)];
}

/**
 * Сборка в две фазы: сначала разделы, резюме — последним.
 *
 * Раньше порядок сборки совпадал с порядком в отчёте, и резюме собиралось
 * первым — из тех же исходных находок, что и разделы. Оно не могло опираться
 * на то, что в разделах действительно написано: пересказывало те же данные
 * другими словами, расходилось с ними в акцентах и обещало содержание раздела,
 * который свернулся из-за нехватки данных.
 *
 * Порядок вывода при этом не меняется — деку по-прежнему открывает резюме.
 * Меняется только очерёдность построения, и это разные вещи.
 */
export function buildAllSections(ctx: SectionBuildContext): SectionPackV2[] {
  // Фаза A — разделы. Резюме сюда не входит.
  const frontMatter = buildFrontMatterSection(ctx);
  const executiveRest = [
    buildSectionPackForFragment("RISK_MATRIX", ctx),
    buildSectionPackForFragment("DIGITAL_PROFILE_OVERVIEW", ctx),
  ];
  const ru = buildRuProfileSection(ctx);
  const uae = buildUaeProfileSection(ctx);
  const compliance = buildComplianceSection(ctx);
  const appendix = buildAppendixSection(ctx);

  // Фаза B — резюме, которому уже видно написанное.
  const builtPacks = new Map<FragmentKey, SectionPackV2>();
  for (const pack of [...frontMatter, ...executiveRest, ...ru, ...uae, ...compliance, ...appendix]) {
    builtPacks.set(pack.fragmentKey, pack);
  }
  const executiveSummary = buildSectionPackForFragment("EXECUTIVE_SUMMARY", {
    ...ctx,
    builtPacks,
  });

  // Порядок вывода — как в отчёте, а не как в сборке.
  return [
    ...frontMatter,
    executiveSummary,
    ...executiveRest,
    ...ru,
    ...uae,
    ...compliance,
    ...appendix,
  ];
}

export { fragmentScope };
export type { Finding };
