/**
 * Capture exact SearchResult / SearchSurfaceItem IDs for a unified job snapshot.
 * Composite merge must use ONLY this manifest — never "latest" case rows.
 *
 * REMEDIATION §1.1 / F5: the manifest stores the run delta plus the rest of the
 * case corpus so a partial re-collection never shrinks the report.
 */

import type { PrismaClient } from "@prisma/client";
import type {
  ActualProviderRecord,
  BaseCollectionManifest,
  YandexGenAnswerProbe,
} from "./unified-collection-types";
import type { CoverageCellStatusRow } from "../orion-golden/analytics/composite-dataset-builder";
import type { FullAuditResultDTO } from "./agent-run-service";

export function mapFullAuditToActualProviders(audit: FullAuditResultDTO): ActualProviderRecord[] {
  return audit.runSummary.map((item) => ({
    providerId: item.providerId,
    agentName: item.agentName,
    runtime: item.runtime,
    status: item.status,
    reason: item.reason,
  }));
}

const REQUIRED_COLLECTION_PROVIDERS = ["yandex", "google", "orion_profile"] as const;

export type RealCollectionAssessment = {
  /**
   * Можно ли показывать результат как настоящий сбор. Ложь здесь — вопрос
   * честности: демо-данные не имеют права выглядеть как реальные.
   */
  sufficient: boolean;
  /** Все ли обязательные провайдеры отработали. */
  complete: boolean;
  /** Провайдеры, упавшие при живом вызове. */
  failedProviders: string[];
  /** Провайдеры, подменённые демо-данными или не вызванные вовсе. */
  mockProviders: string[];
};

/**
 * Оценка базового сбора: отдельно честность, отдельно полнота.
 *
 * Раньше это был один флаг, и **отказ любого провайдера обнулял весь прогон**.
 * На живом прогоне Serper вернул «кончились кредиты» — и двадцать минут работы
 * Яндекса, Wikipedia и пяти агентов Arsenkin вместе с уже отрендеренной декой
 * ушли в `FAILED_TERMINAL` (шаг 13, B1).
 *
 * Это разные вещи. Подмена демо-данными — обман, и она запрещена. Отказ одного
 * из нескольких живых источников — неполнота, и для неё существует
 * `COMPLETED_PARTIAL`.
 */
export function assessRealCollection(providers: ActualProviderRecord[]): RealCollectionAssessment {
  const failedProviders: string[] = [];
  const mockProviders: string[] = [];

  for (const id of REQUIRED_COLLECTION_PROVIDERS) {
    const row = providers.find((p) => p.providerId === id);
    if (!row) continue;
    if (row.status === "skipped" || row.status === "unavailable") continue;
    if (row.status === "failed") {
      failedProviders.push(id);
      continue;
    }
    if (row.runtime === "mock" || row.runtime === "none") mockProviders.push(id);
  }

  // Хотя бы один обязательный источник обязан отработать по-настоящему:
  // без этого показывать нечего.
  const anyReal = providers.some(
    (p) =>
      (REQUIRED_COLLECTION_PROVIDERS as readonly string[]).includes(p.providerId) &&
      p.status === "completed" &&
      p.runtime === "real"
  );

  return {
    sufficient: anyReal && mockProviders.length === 0,
    complete: anyReal && mockProviders.length === 0 && failedProviders.length === 0,
    failedProviders,
    mockProviders,
  };
}

/** Можно ли показывать сбор как настоящий (честность, не полнота). */
export function isRealCollectionSufficient(providers: ActualProviderRecord[]): boolean {
  return assessRealCollection(providers).sufficient;
}

export async function captureBaseCollectionManifest(input: {
  prisma: PrismaClient;
  caseId: string;
  unifiedJobId: string;
  beforeSearchResultIds: Set<string>;
  beforeSearchSurfaceItemIds: Set<string>;
  actualProviders: ActualProviderRecord[];
  baseReportRunId?: string | null;
  yandexGenAnswerProbe?: YandexGenAnswerProbe;
}): Promise<BaseCollectionManifest> {
  const results = await input.prisma.searchResult.findMany({
    where: { caseId: input.caseId },
    select: { id: true },
  });
  const surfaces = await input.prisma.searchSurfaceItem.findMany({
    where: { caseId: input.caseId },
    select: { id: true },
  });

  const afterResultIds = results.map((r) => r.id);
  const afterSurfaceIds = surfaces.map((s) => s.id);

  const deltaResultIds = afterResultIds.filter((id) => !input.beforeSearchResultIds.has(id));
  const deltaSurfaceIds = afterSurfaceIds.filter((id) => !input.beforeSearchSurfaceItemIds.has(id));

  // If diff empty (re-run / upsert), fall back to all current IDs tagged by capture window —
  // still explicit IDs, not "latest report run". Prefer AFTER set when diff is empty.
  const searchResultIds = deltaResultIds.length > 0 ? deltaResultIds : afterResultIds;
  const searchSurfaceItemIds = deltaSurfaceIds.length > 0 ? deltaSurfaceIds : afterSurfaceIds;

  const deltaResultSet = new Set(searchResultIds);
  const deltaSurfaceSet = new Set(searchSurfaceItemIds);
  const caseCorpusSearchResultIds = afterResultIds.filter((id) => !deltaResultSet.has(id));
  const caseCorpusSurfaceItemIds = afterSurfaceIds.filter((id) => !deltaSurfaceSet.has(id));

  const actualProviders = input.actualProviders;
  return {
    version: "base-collection-manifest-v1",
    unifiedJobId: input.unifiedJobId,
    caseId: input.caseId,
    capturedAt: new Date().toISOString(),
    baseReportRunId: input.baseReportRunId ?? null,
    searchResultIds,
    searchSurfaceItemIds,
    caseCorpusSearchResultIds,
    caseCorpusSurfaceItemIds,
    baseCount:
      searchResultIds.length +
      searchSurfaceItemIds.length +
      caseCorpusSearchResultIds.length +
      caseCorpusSurfaceItemIds.length,
    actualProviders,
    realCollectionSufficient: isRealCollectionSufficient(actualProviders),
    ...(input.yandexGenAnswerProbe ? { yandexGenAnswerProbe: input.yandexGenAnswerProbe } : {}),
  };
}

/**
 * Ячейки покрытия из записи о попытке спросить нейро-ответ.
 *
 * Читаются **только не-успешные** исходы: измеренный успех доказывают сами
 * строки наблюдений (и существующие ворота `baseCount`/traceability ловят их
 * потерю). OK из манифеста не читается — иначе манифест и строки становятся
 * двумя ответами на один вопрос.
 *
 * Статусы выбраны из тех, что композитный слой записывает в
 * `nonOkCoverageCells`: ячейка со статусом вне этого набора до деки не доедет.
 */
export function genAnswerCoverageCells(rawManifest: unknown): CoverageCellStatusRow[] {
  const probe = (rawManifest as { yandexGenAnswerProbe?: YandexGenAnswerProbe } | null)
    ?.yandexGenAnswerProbe;
  if (!probe || probe.status === "SUCCESS") return [];
  const cell = (status: string, errorCode: string | null): CoverageCellStatusRow => ({
    region: "RU",
    engine: "YANDEX",
    surface: "ai_answers",
    status,
    provider: "yandex",
    errorCode,
  });
  if (probe.status === "NOT_CONFIGURED") {
    return [cell("NOT_COLLECTED", probe.errorCode ?? "PROVIDER_NOT_CONFIGURED")];
  }
  if (probe.status === "FAILED") return [cell("ERROR", probe.errorCode ?? null)];
  // NO_RESULTS и REJECTED — измеренная пустота: вопрос задан, ответ получен.
  return [cell("NO_RESULTS", probe.status === "REJECTED" ? "ANSWER_REJECTED" : null)];
}

export async function snapshotExistingIds(
  prisma: PrismaClient,
  caseId: string
): Promise<{ searchResultIds: Set<string>; searchSurfaceItemIds: Set<string> }> {
  const [results, surfaces] = await Promise.all([
    prisma.searchResult.findMany({ where: { caseId }, select: { id: true } }),
    prisma.searchSurfaceItem.findMany({ where: { caseId }, select: { id: true } }),
  ]);
  return {
    searchResultIds: new Set(results.map((r) => r.id)),
    searchSurfaceItemIds: new Set(surfaces.map((s) => s.id)),
  };
}
