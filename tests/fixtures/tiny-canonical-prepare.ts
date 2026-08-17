/**
 * Минимальный вход полной подготовки отчёта для юнитов.
 *
 * Полный `runCanonicalReportPrepare` на корпусе из трёх наблюдений с фейковым
 * рендерером отрабатывает за доли секунды — этого достаточно, чтобы проверять
 * свойства всей подготовки (артефакты базы, предупреждения качества), а не
 * только отдельных её функций. Форма входа повторяет то, что собирает
 * оркестратор, поэтому проверка говорит о боевом пути, а не о выдуманном.
 */

import type { CanonicalPrepareInput } from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  compositeObservationsToInventory,
  observationSurfaceBucket,
} from "@/modules/digital-profile/services/canonical-report-prepare";
import { runOrionAnalyticsPipeline } from "@/modules/digital-profile/orion-golden/analytics/run-analytics-pipeline";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { DeckRenderAdapter } from "@/modules/digital-profile/services/render-deck-artifacts";
import type { ClassifierSubjectProfile } from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { CompositeObservation } from "@/modules/digital-profile/services/composite-serp-merge";
import {
  buildReportDataBinding,
  mergeCompositeSerp,
} from "@/modules/digital-profile/services/composite-serp-merge";
import type { BaseCollectionManifest } from "@/modules/digital-profile/services/unified-collection-types";

export const TINY_CASE_ID = "case-tiny-prepare";
const TINY_JOB_ID = "unified-tiny-prepare";
const TINY_BASE_RUN_ID = "base-tiny-prepare";

/** Адрес первой публикации: по нему тесты цепляют вердикты и оверрайды. */
export const TINY_ADVERSE_URL = "https://di.se/holmstrom-tax";

function tinySubjectProfile(): ClassifierSubjectProfile {
  return {
    displayName: "Anders Holmström",
    givenNames: ["Anders"],
    familyNames: ["Holmström", "Holmstrom"],
    patronymics: [],
    aliases: ["Anders Holmstrom"],
    transliterations: ["Anders Holmstrom"],
    contextIdentifiers: ["Nordkap Capital"],
    namesakeProfiles: [],
    negativeIdentitySignals: { wrongPatronymics: [], wrongNames: [], unrelatedKnownPersons: [] },
  };
}

function tinyObservations(): CompositeObservation[] {
  let k = 0;
  const obs = (
    partial: Partial<CompositeObservation> & Pick<CompositeObservation, "kind">
  ): CompositeObservation => {
    k += 1;
    return {
      key: `tiny-${k}`,
      region: "RU",
      engine: "YANDEX",
      query: "Anders Holmström",
      providers: ["yandex"],
      primaryProvider: "yandex",
      evidenceRefs: [],
      ...partial,
    } as CompositeObservation;
  };
  return [
    obs({
      kind: "organic",
      rank: 1,
      url: TINY_ADVERSE_URL,
      title: "Anders Holmström Nordkap Capital tax probe",
      snippet: "Anders Holmström of Nordkap Capital faces investigation.",
      riskLabel: "adverse",
    }),
    obs({
      kind: "organic",
      rank: 2,
      url: "https://forbes.com/holmstrom",
      title: "Anders Holmström CEO Nordkap Capital",
      snippet: "Business profile of Anders Holmström.",
    }),
    obs({
      kind: "suggestion",
      suggestion: "Anders Holmström fraud",
      title: "Anders Holmström fraud",
    }),
  ];
}

/** Материалы корпуса в том виде, в каком их видит аналитика. */
export function tinyInventory(): RawInventoryItem[] {
  return compositeObservationsToInventory({
    caseId: TINY_CASE_ID,
    baseReportRunId: TINY_BASE_RUN_ID,
    enrichmentRunId: null,
    observations: tinyObservations(),
  });
}

/** Покрытие корпуса — то же, что собирает подготовка отчёта перед аналитикой. */
function tinyCoverageRows(): Parameters<typeof runOrionAnalyticsPipeline>[0]["coverageRows"] {
  const rows = new Map<string, { region: string; engine: string; surface: string }>();
  for (const obs of tinyObservations()) {
    const region = obs.region ?? "RU";
    const engine = (obs.engine ?? "").toUpperCase() || "UNKNOWN";
    const surface = observationSurfaceBucket(obs);
    rows.set(`${region}|${engine}|${surface}`, { region, engine, surface });
  }
  return [...rows.values()].map((c) => ({
    ...c,
    status: "OK",
  })) as unknown as Parameters<typeof runOrionAnalyticsPipeline>[0]["coverageRows"];
}

/** Прогон аналитики на этом корпусе с каталогом артефактов вызывающего. */
export async function runTinyAnalytics(artifactsDir: string) {
  return await runOrionAnalyticsPipeline({
    caseId: TINY_CASE_ID,
    inventoryReportRunId: TINY_BASE_RUN_ID,
    items: tinyInventory(),
    binding: null,
    coverageRows: tinyCoverageRows(),
    subjectProfile: tinySubjectProfile(),
    artifactsDir,
  });
}

const fakeRender: DeckRenderAdapter = async (r) => ({
  pageCount: r.deckManifest.pageCount,
  renderer: "fake-tiny",
});

/**
 * Вход подготовки для каталога `artifactsDir`. Всё, что подставляет вызывающий
 * (prisma, фикстуры данных), передаётся через `extra` и сильнее умолчаний.
 */
export async function tinyPrepareInput(
  artifactsDir: string,
  extra: Partial<CanonicalPrepareInput> = {}
): Promise<CanonicalPrepareInput> {
  const rows = tinyObservations();
  const manifest: BaseCollectionManifest = {
    version: "base-collection-manifest-v1",
    unifiedJobId: TINY_JOB_ID,
    caseId: TINY_CASE_ID,
    capturedAt: new Date().toISOString(),
    baseReportRunId: TINY_BASE_RUN_ID,
    searchResultIds: [],
    searchSurfaceItemIds: [],
    baseCount: rows.length,
    actualProviders: [{ providerId: "yandex", runtime: "real", status: "completed" }],
    realCollectionSufficient: true,
  };
  const merge = await mergeCompositeSerp({ manifest, fixtureBaseRows: rows });
  const binding = buildReportDataBinding({
    caseId: TINY_CASE_ID,
    unifiedJobId: TINY_JOB_ID,
    baseReportRunId: TINY_BASE_RUN_ID,
    enrichmentRunIds: [],
    compositeDatasetId: merge.compositeDatasetId,
    providerCounts: merge.providerCounts,
  });
  return {
    caseId: TINY_CASE_ID,
    unifiedJobId: TINY_JOB_ID,
    artifactsDir,
    binding,
    merge,
    subjectProfile: tinySubjectProfile(),
    render: fakeRender,
    gptCaller: null,
    ...extra,
  };
}
