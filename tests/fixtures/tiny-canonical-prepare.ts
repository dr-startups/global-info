/**
 * Минимальный вход полной подготовки отчёта для юнитов.
 *
 * Полный `runCanonicalReportPrepare` на корпусе из трёх наблюдений с фейковым
 * рендерером отрабатывает за доли секунды — этого достаточно, чтобы проверять
 * свойства всей подготовки (артефакты базы, предупреждения качества), а не
 * только отдельных её функций. Форма входа повторяет то, что собирает
 * оркестратор, поэтому проверка говорит о боевом пути, а не о выдуманном.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalPrepareInput } from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  compositeObservationsToInventory,
  observationSurfaceBucket,
  runCanonicalReportPrepare,
  stampAcceptedAssembly,
} from "@/modules/digital-profile/services/canonical-report-prepare";
import { runOrionAnalyticsPipeline } from "@/modules/digital-profile/orion-golden/analytics/run-analytics-pipeline";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { DeckRenderAdapter } from "@/modules/digital-profile/services/render-deck-artifacts";
import type { ClassifierSubjectProfile } from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { CompositeObservation } from "@/modules/digital-profile/services/composite-serp-merge";
import {
  buildReportDataBinding,
  compositeDatasetIdFor,
  mergeCompositeSerp,
} from "@/modules/digital-profile/services/composite-serp-merge";
import type { BaseCollectionManifest } from "@/modules/digital-profile/services/unified-collection-types";

export const TINY_CASE_ID = "case-tiny-prepare";
export const TINY_JOB_ID = "unified-tiny-prepare";
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
    datasetId: compositeDatasetIdFor(TINY_JOB_ID),
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

/** Запись телеметрии страницы, на которой ворота потерь молчат. */
export const CLEAN_TELEMETRY_ENTRY = {
  page: 1,
  name: "orion_text_body_p1",
  role: "text",
  requiredHeight: 197_815,
  availableHeight: 1_100_000,
  clipped: false,
  measurementUncertain: false,
};

/**
 * Рендерер, который ведёт себя как настоящий: кладёт клиентские файлы на диск и
 * отчитывается телеметрией. Офлайн-фейк (`fake-*`) воротами потерь не судится,
 * поэтому проверять их — и считать настоящие рендеры — можно только таким.
 */
export function renderAdapterWithTelemetry(
  entries: Array<Record<string, unknown>> | null
): { adapter: DeckRenderAdapter; calls: () => number } {
  let calls = 0;
  const adapter: DeckRenderAdapter = async (input) => {
    calls += 1;
    mkdirSync(input.outputRoot, { recursive: true });
    const pptx = join(input.outputRoot, "rendered-client.pptx");
    const pdf = join(input.outputRoot, "rendered-client.pdf");
    writeFileSync(pptx, "pptx", "utf8");
    writeFileSync(pdf, "pdf", "utf8");
    const telemetryPath = join(input.outputRoot, "layout-telemetry.json");
    if (entries) {
      writeFileSync(
        telemetryPath,
        JSON.stringify({ version: "orion-layout-telemetry-v1", entries }, null, 2),
        "utf8"
      );
    } else {
      rmSync(telemetryPath, { force: true });
    }
    return {
      pdf,
      pptx,
      pageCount: input.deckManifest.pageCount,
      renderer: "http:orion/render-golden",
    };
  };
  return { adapter, calls: () => calls };
}

/**
 * Каталог `deck/` с годной сборкой — снятый с настоящей подготовки.
 *
 * Годность деки складывается из её собственных полей и штампа приёмки, который
 * ставят ворота сборки. Слепив такой каталог литералами, тест закрепил бы
 * формат артефактов, а не поведение загрузчика: первая же правда о годности
 * разошлась бы с ним молча. Идентификаторы переписываются поверх копии — они в
 * отпечаток укладки не входят, поэтому сборка остаётся согласованной.
 */
export async function seedAssembledDeckDir(input: {
  artifactsDir: string;
  caseId?: string;
  datasetId?: string;
}): Promise<{ caseId: string; datasetId: string }> {
  const source = await tinySeededDeckDir();
  const deckDir = join(input.artifactsDir, "deck");
  rmSync(deckDir, { recursive: true, force: true });
  mkdirSync(input.artifactsDir, { recursive: true });
  cpSync(source, deckDir, { recursive: true });
  const caseId = input.caseId ?? TINY_CASE_ID;
  const datasetId = input.datasetId ?? TINY_COMPOSITE_DATASET_ID;
  patchJson(join(deckDir, "assembled-deck.json"), {
    caseId,
    datasetId,
    sourceDatasetId: datasetId,
  });
  const manifestPath = join(deckDir, "report-deck-manifest.json");
  patchJson(manifestPath, { caseId, sourceDatasetId: datasetId });
  // Переписанные идентификаторы — другие байты, а штамп приёмки ключён именно
  // ими: деку заново штампует та же функция, что и подготовка.
  stampAcceptedAssembly(deckDir, JSON.parse(readFileSync(manifestPath, "utf8")));
  return { caseId, datasetId };
}

function patchJson(path: string, patch: Record<string, unknown>): void {
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2), "utf8");
}

/** Идентификатор набора фикстуры — тот, что чеканит слияние. */
export const TINY_COMPOSITE_DATASET_ID = compositeDatasetIdFor(TINY_JOB_ID);

let seededDeckDir: Promise<string> | null = null;

/** Одна настоящая подготовка на файл тестов: копии деки снимаются с неё. */
function tinySeededDeckDir(): Promise<string> {
  seededDeckDir ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "tiny-seeded-deck-"));
    const res = await runCanonicalReportPrepare(await tinyPrepareInput(root));
    if (!res.ok) throw new Error("tiny prepare failed while seeding a deck");
    return join(root, "deck");
  })();
  return seededDeckDir;
}
