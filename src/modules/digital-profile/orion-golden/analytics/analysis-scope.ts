/**
 * Область анализа — ТОП-20 поисковой выдачи по субъекту.
 *
 * Аудит обещает клиенту проверку **результатов поиска (ТОП-20) в Яндексе и
 * Google по России и ОАЭ, плюс международные базы данных**. До этого шага
 * анализировалось всё, что собрано: на боевом прогоне это 598 наблюдений — 228
 * строк органики со всех запросов плана, 124 подсказки, 115 видео, 68
 * изображений, 38 похожих вопросов. Темы риска строились по всему корпусу
 * сразу, поэтому вывод мог опираться на материал, которого проверяющий в
 * выдаче не увидит: сороковую строку по узкой пробе «имя + суд» или подсказку
 * поисковика.
 *
 * Здесь объявляется, что считается предметом аудита:
 *
 * - **органика с позицией ≤ 20** в разрезе «движок × регион». Позиция — то,
 *   что отдал поисковик (`SearchResult.rank`, порядок ответа Arsenkin), а не
 *   наша производная величина;
 * - **международные базы** (Dow Jones, LexisNexis, OpenSanctions) — отдельный
 *   контур проверки, к позиции в выдаче отношения не имеет;
 * - **справка Википедии** — карточка личности, а не строка выдачи.
 *
 * Остальное (подсказки, похожие запросы, изображения, видео, AI-ответы,
 * индексация) остаётся собранным и показанным на своих страницах отчёта, но
 * тем риска не рождает.
 *
 * Ничего не выбрасывается молча: каждый материал вне области получает причину,
 * а сводка `AnalysisScopeSummary` печатается в артефакты прогона. Правило этого
 * проекта — «пустое состояние честнее выдуманного», и обратная сторона того же
 * правила: сокращение области обязано быть названным, иначе отчёт не отличить
 * от отчёта по неполным данным.
 */

import type { RawInventoryItem } from "../types";
import { mapRegionBucket, mapSurfaceBucket } from "../classic/composite-serp-overlay-merge";

/**
 * Глубина выдачи, попадающая в анализ.
 *
 * Двадцать — не круглое число «на глаз»: столько строк объявлено клиенту в
 * резюме отчёта («аудит результатов поиска (ТОП-20)»), и столько же стоит в
 * плане запросов (`maxResultsHint: 20`). Один вопрос — один ответ.
 */
export const ANALYSIS_TOP_N = 20;

/** Поверхности, чьи материалы образуют предмет аудита. */
export const ANALYSIS_SURFACES = new Set(["organic"]);

/**
 * Источники вне поисковой выдачи, которые входят в аудит наравне с ТОП-20:
 * международные базы и справка Википедии. Позиции у них нет и быть не может.
 */
export const NON_SERP_SOURCES = new Set(["database_profile", "wikipedia_check", "compliance"]);

export type ScopeExclusionReason =
  /** Органика ниже двадцатой позиции: в выдаче её на первой странице не видно. */
  | "below_top_n"
  /** Позиция неизвестна — утверждать, что материал в ТОП-20, нельзя. */
  | "rank_unknown"
  /** Не поисковая выдача: подсказки, похожие запросы, изображения, видео. */
  | "surface_out_of_scope";

export type ScopeDecision = {
  item: RawInventoryItem;
  evidenceRef: string;
  inScope: boolean;
  reason: ScopeExclusionReason | null;
  /** Разрез, в котором считалась позиция: «движок × регион». */
  lane: string | null;
  rank: number | null;
};

export type AnalysisScopeSummary = {
  version: "analysis-scope-v1";
  topN: number;
  /** Сколько материалов собрано всего. */
  collected: number;
  /** Сколько вошло в анализ. */
  analyzed: number;
  analyzedBySource: { serpTop: number; databases: number };
  excludedByReason: Record<ScopeExclusionReason, number>;
  /**
   * По разрезам «движок × регион»: сколько строк органики собрано, сколько
   * вошло в ТОП-20 и до какой позиции дотянулся анализ. Считается только
   * органика — подсказки и картинки к глубине выдачи отношения не имеют.
   */
  lanes: Array<{ lane: string; analyzed: number; organic: number; deepestRank: number | null }>;
};

export type AnalysisScopeResult = {
  inScope: RawInventoryItem[];
  outOfScope: ScopeDecision[];
  decisions: ScopeDecision[];
  summary: AnalysisScopeSummary;
};

export function evidenceRefOf(item: RawInventoryItem): string {
  return `inventory:${item.inventoryId}`;
}

/** Позиция материала в выдаче, если поисковик её сообщил. */
export function rankOf(item: RawInventoryItem): number | null {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  const raw = meta.rank ?? meta.position;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** Разрез, в котором считается ТОП-20: «движок × регион». */
export function laneOf(item: RawInventoryItem): string {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  const engineRaw = String(meta.engine ?? item.provider ?? "UNKNOWN").toUpperCase();
  return `${engineRaw}|${mapRegionBucket(item.region)}`;
}

function surfaceOf(item: RawInventoryItem): string {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  return mapSurfaceBucket(String(meta.surface ?? item.evidenceType ?? "organic"));
}

function isNonSerpSource(item: RawInventoryItem): boolean {
  if (NON_SERP_SOURCES.has(String(item.source ?? ""))) return true;
  const surface = surfaceOf(item);
  return surface === "compliance_hit" || surface === "wikipedia";
}

/**
 * Разделить собранное на предмет аудита и остальное.
 *
 * Материалы не переупорядочиваются и не переоцениваются: решение принимается по
 * тому, что сообщил поисковик. Материал без позиции в анализ не берётся —
 * «наверное, он был высоко» это не факт, а предположение, и в отчёте, который
 * читают как проверенный, ему не место.
 */
export function resolveAnalysisScope(
  items: RawInventoryItem[],
  options?: { topN?: number }
): AnalysisScopeResult {
  const topN = options?.topN ?? ANALYSIS_TOP_N;
  const decisions: ScopeDecision[] = items.map((item) => {
    const evidenceRef = evidenceRefOf(item);
    if (isNonSerpSource(item)) {
      return { item, evidenceRef, inScope: true, reason: null, lane: null, rank: null };
    }
    const surface = surfaceOf(item);
    if (!ANALYSIS_SURFACES.has(surface)) {
      return {
        item,
        evidenceRef,
        inScope: false,
        reason: "surface_out_of_scope",
        lane: laneOf(item),
        rank: rankOf(item),
      };
    }
    const rank = rankOf(item);
    if (rank === null) {
      return {
        item,
        evidenceRef,
        inScope: false,
        reason: "rank_unknown",
        lane: laneOf(item),
        rank: null,
      };
    }
    if (rank > topN) {
      return {
        item,
        evidenceRef,
        inScope: false,
        reason: "below_top_n",
        lane: laneOf(item),
        rank,
      };
    }
    return { item, evidenceRef, inScope: true, reason: null, lane: laneOf(item), rank };
  });

  const excludedByReason: Record<ScopeExclusionReason, number> = {
    below_top_n: 0,
    rank_unknown: 0,
    surface_out_of_scope: 0,
  };
  const laneStats = new Map<string, { analyzed: number; organic: number; deepestRank: number | null }>();
  let databases = 0;
  let serpTop = 0;
  for (const d of decisions) {
    if (d.reason) excludedByReason[d.reason] += 1;
    if (d.inScope) {
      if (d.lane === null) databases += 1;
      else serpTop += 1;
    }
    if (d.lane === null || d.reason === "surface_out_of_scope") continue;
    const stat = laneStats.get(d.lane) ?? { analyzed: 0, organic: 0, deepestRank: null };
    stat.organic += 1;
    if (d.inScope) {
      stat.analyzed += 1;
      if (d.rank !== null) {
        stat.deepestRank = stat.deepestRank === null ? d.rank : Math.max(stat.deepestRank, d.rank);
      }
    }
    laneStats.set(d.lane, stat);
  }

  return {
    inScope: decisions.filter((d) => d.inScope).map((d) => d.item),
    outOfScope: decisions.filter((d) => !d.inScope),
    decisions,
    summary: {
      version: "analysis-scope-v1",
      topN,
      collected: items.length,
      analyzed: decisions.filter((d) => d.inScope).length,
      analyzedBySource: { serpTop, databases },
      excludedByReason,
      lanes: [...laneStats.entries()]
        .map(([lane, s]) => ({ lane, ...s }))
        .sort((a, b) => b.analyzed - a.analyzed || a.lane.localeCompare(b.lane)),
    },
  };
}
