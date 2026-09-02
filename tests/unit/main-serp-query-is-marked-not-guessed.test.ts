/**
 * Какое из написаний ФИО основное — знает набор запросов, а не таблица.
 *
 * Все пять написаний уходят в план с одним `queryPurpose: "subject_lookup"`,
 * поэтому по назначению они неразличимы. Набор запросов при этом знает, какое
 * из них — само имя (`origin.kind === "subject_name"`), но пометка не покидала
 * своего модуля: замер 30.08 — два вхождения `setRank`, оба в
 * `subject-query-set.ts`. Из-за этого таблица выбирала запрос запасным
 * правилом, и на пяти равных запросах решал алфавит: при написаниях «Глинка
 * Сергей Михайлович», «Глинка Сергей», «Сергей Глинка» основным становился
 * «Глинка Сергей». Обещание «ТОП-20 по запросу ФИО» при таком выборе
 * неисполнимо: другой набор написаний дал бы другую двадцатку.
 *
 * Пометка едет тем же путём, что `rank`, `rankSource` и `queryPurpose`:
 * `rawMetadata` → инвентарь → набор analytics → контракт → индекс деки.
 */

import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSubjectQuerySet,
  plannedPrimaryQueries,
} from "@/modules/digital-profile/search-surfaces/subject-query-set";
import { buildOrionQueryPlanDetailed } from "@/modules/digital-profile/search-surfaces/orion-query-plan";
import type { OrionQuerySpec } from "@/modules/digital-profile/search-surfaces/orion-query-plan";
import { organicRowMetadata } from "@/modules/digital-profile/services/orion-search-profile-service";
import { compositeObservationsToInventory } from "@/modules/digital-profile/services/canonical-report-prepare";
import { buildAnalyticsCompositeDataset } from "@/modules/digital-profile/orion-golden/analytics/composite-dataset-builder";
import { CompositeObservationRowSchema } from "@/modules/digital-profile/orion-golden/contracts/composite-dataset";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { CompositeObservation } from "@/modules/digital-profile/services/composite-serp-merge";
import { buildSerpFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SearchProviderResult } from "@/modules/digital-profile/providers/types";

const ANALYTICS_DIR = join(process.cwd(), "baselines/report-72/artifacts/analytics");
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const NAME = "Глинка Сергей Михайлович";

function querySet() {
  return buildSubjectQuerySet({
    profile: {
      fullName: NAME,
      firstName: "Сергей",
      lastName: "Глинка",
      patronymic: "Михайлович",
      variants: ["Сергей Глинка"],
    },
    suggestions: [
      { text: "глинка сергей михайлович трансмашхолдинг", engine: "GOOGLE", region: "RU", rank: 1 },
    ],
    region: "RU",
    language: "ru",
    capturedAt: "2026-08-30T00:00:00.000Z",
  });
}

describe("пометка «это основной запрос» доезжает от набора запросов до деки", () => {
  it("план сбора помечает строку, построенную из самого имени", () => {
    const set = querySet();
    const { plan } = buildOrionQueryPlanDetailed(
      { fullName: NAME, aliases: [], targetRegions: ["RU"], location: null },
      {
        primaryQueriesByRegion: { RU: plannedPrimaryQueries(set) },
        maxPrimaryPerRegion: 5,
        includeRiskProbes: false,
        regions: ["RU"],
      }
    );
    const subject = plan.filter((q) => q.purpose === "subject_lookup");
    const marked = subject.filter((q) => q.subjectNameQuery);
    expect(marked.map((q) => q.query)).toEqual([NAME]);
    // Остальные написания остаются равными по назначению — пометка это и
    // различает.
    expect(subject.length).toBeGreaterThan(1);
    expect(new Set(subject.map((q) => q.purpose))).toEqual(new Set(["subject_lookup"]));
  });

  it("строка выдачи уносит пометку в rawMetadata", () => {
    const spec = {
      queryPlanId: "plan-1",
      queryId: "q-1",
      query: NAME,
      normalizedQuery: NAME.toLowerCase(),
      language: "ru",
      region: "RU",
      priority: "primary",
      purpose: "subject_lookup",
      providerPreference: ["yandex"],
      requiredTokens: [],
      optionalTokens: [],
      identityStrictness: "strict",
      maxResultsHint: 20,
      clientVisible: true,
      internalReason: "проверка пометки",
      planRank: 1,
      subjectNameQuery: true,
    } as OrionQuerySpec;
    const result: SearchProviderResult = {
      provider: "YANDEX",
      query: NAME,
      region: "ru",
      language: "ru",
      rank: 1,
      title: "Материал",
      snippet: "текст",
      url: "https://example.ru/1",
      domain: "example.ru",
      rawMetadata: {},
      capturedAt: new Date(0).toISOString(),
    };
    const meta = organicRowMetadata({ engine: "YANDEX", orionRegion: "RU", querySpec: spec, result });
    expect(meta.subjectNameQuery).toBe(true);
    // У непомеченной строки лишнего ключа нет: отсутствие пометки в наборе и
    // «пометка есть, но не у этой строки» — разные факты.
    const other = organicRowMetadata({
      engine: "YANDEX",
      orionRegion: "RU",
      querySpec: { ...spec, subjectNameQuery: undefined, query: "глинка сергей" },
      result,
    });
    expect(other).not.toHaveProperty("subjectNameQuery");
  });

  it("инвентарь и набор analytics несут пометку и переживают контракт", () => {
    const observation = {
      key: "глинка сергей михайлович|YANDEX|RU|organic|example.ru",
      kind: "organic",
      surface: "organic",
      region: "RU",
      engine: "YANDEX",
      query: NAME,
      url: "https://example.ru/1",
      title: "Материал",
      rank: 1,
      rankSource: "yandex",
      queryPurpose: "subject_lookup",
      subjectNameQuery: true,
      providers: ["yandex"],
      primaryProvider: "yandex",
      evidenceRefs: [],
    } as unknown as CompositeObservation;
    const items = compositeObservationsToInventory({
      caseId: "case-main-query",
      baseReportRunId: "run-base",
      enrichmentRunId: null,
      observations: [observation],
    });
    expect((items[0]!.rawMetadata as Record<string, unknown>).subjectNameQuery).toBe(true);
    const built = buildAnalyticsCompositeDataset({
      datasetId: "composite-unified-main-query",
      caseId: "case-main-query",
      baseItems: items,
      enrichmentItems: [],
      binding: null,
      coverageRows: [],
      baseReportRunId: "run-base",
    });
    const row = built.dataset.observations[0]!;
    expect(row.subjectNameQuery).toBe(true);
    expect(CompositeObservationRowSchema.parse(row).subjectNameQuery).toBe(true);
  });

  it("индекс доказательств деки знает, какой запрос основной", () => {
    const dir = mkdtempSync(join(tmpdir(), "main-query-"));
    tempDirs.push(dir);
    cpSync(ANALYTICS_DIR, dir, { recursive: true });
    const file = join(dir, "composite-serp-observations.json");
    const payload = JSON.parse(readFileSync(file, "utf8")) as {
      observations: Array<Record<string, unknown>>;
    };
    payload.observations = [
      {
        observationKey: "глинка сергей михайлович|YANDEX|RU|organic|example.ru",
        provider: "yandex",
        providers: ["yandex"],
        engine: "YANDEX",
        surface: "organic",
        region: "RU",
        url: "https://example.ru/1",
        title: "Материал",
        domain: "example.ru",
        rank: 1,
        rankSource: "yandex",
        query: NAME,
        queryPurpose: "subject_lookup",
        subjectNameQuery: true,
        evidenceRefs: ["inventory:obs-ru-1"],
        provenanceOwner: "enrichment",
      },
    ];
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const entry = loadDeckInputsFromAnalyticsDir(dir).evidenceIndex["inventory:obs-ru-1"];
    expect(entry?.query).toBe(NAME);
    expect(entry?.subjectNameQuery).toBe(true);
  });
});

/**
 * Наблюдения двух запросов: помеченного имени и более «урожайного» соседа,
 * который вдобавок стоит раньше по алфавиту.
 */
function scopedTwoQueries(marked: boolean): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  // Само имя: две строки.
  for (const rank of [1, 2]) {
    evidenceIndex[`name-${rank}`] = {
      title: `Материал имени ${rank}`,
      url: `https://name.ru/${rank}`,
      domain: "name.ru",
      region: "RU",
      engine: "YANDEX",
      rank,
      rankSource: "yandex",
      query: NAME,
      queryPurpose: "subject_lookup",
      ...(marked ? { subjectNameQuery: true } : {}),
      subjectDecision: "SUBJECT_MATCH",
    };
    refs.push(`name-${rank}`);
  }
  // Соседнее написание: и материала больше, и по алфавиту раньше.
  for (const rank of [1, 2, 3, 4]) {
    evidenceIndex[`alpha-${rank}`] = {
      title: `Материал соседа ${rank}`,
      url: `https://alpha.ru/${rank}`,
      domain: "alpha.ru",
      region: "RU",
      engine: "YANDEX",
      rank,
      rankSource: "yandex",
      query: "глинка сергей",
      queryPurpose: "subject_lookup",
      subjectDecision: "SUBJECT_MATCH",
    };
    refs.push(`alpha-${rank}`);
  }
  return {
    findings: [],
    surfaceUnits: [
      { surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function tableQueriesOf(scoped: ScopedFragmentInput): string[] {
  return buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped)
    .slides.map((s) => String(s.metrics?.serpQuery ?? ""))
    .filter(Boolean);
}

describe("таблица выдачи берёт помеченный запрос, а не выбирает его сама", () => {
  it("с пометкой основным становится само имя, а не урожайный сосед", () => {
    expect([...new Set(tableQueriesOf(scopedTwoQueries(true)))]).toEqual([NAME]);
  });

  it("без пометки работает запасное правило", () => {
    // Запасное правило считает материал: у соседа его больше.
    expect([...new Set(tableQueriesOf(scopedTwoQueries(false)))]).toEqual(["глинка сергей"]);
  });

  it("выбор не зависит от порядка входа и повторяется", () => {
    const scoped = scopedTwoQueries(true);
    const reversed = {
      ...scoped,
      surfaceUnits: [
        {
          ...scoped.surfaceUnits[0],
          evidenceRefs: [...scoped.surfaceUnits[0]!.evidenceRefs].reverse(),
        },
      ],
    } as unknown as ScopedFragmentInput;
    expect(tableQueriesOf(reversed)).toEqual(tableQueriesOf(scoped));
    expect(tableQueriesOf(scoped)).toEqual(tableQueriesOf(scopedTwoQueries(true)));
  });
});
