import { describe, expect, it } from "vitest";
import { mergeCompositeSerp } from "@/modules/digital-profile/services/composite-serp-merge";
import { compositeObservationsToInventory } from "@/modules/digital-profile/services/canonical-report-prepare";
import type { BaseCollectionManifest } from "@/modules/digital-profile/services/unified-collection-types";
import { genAnswerCoverageCells } from "@/modules/digital-profile/services/base-collection-manifest";
import { mapResultClassToContentClass } from "@/modules/digital-profile/evidence-quality/content-class";
import { evaluateEvidenceItem } from "@/modules/digital-profile/evidence-quality/gate";

/**
 * Шаг AO. Строка нейро-ответа — базовое наблюдение: она обязана доехать до
 * поверхности `ai_answer`, а не схлопнуться в `other` и потеряться на пути к
 * своей странице. Исход попытки живёт отдельно — записью в манифесте, и
 * успех из неё не читается: строки доказывают себя сами.
 */

const MANIFEST = {
  version: "base-collection-manifest-v1",
  unifiedJobId: "unified-gen-1",
  caseId: "case-gen",
  capturedAt: "2026-08-20T00:00:00.000Z",
  baseReportRunId: "run-1",
  searchResultIds: [],
  searchSurfaceItemIds: ["ss-gen-body", "ss-gen-src", "ss-organic"],
  caseCorpusSearchResultIds: [],
  caseCorpusSurfaceItemIds: [],
  baseCount: 3,
  actualProviders: [],
  realCollectionSufficient: true,
} as unknown as BaseCollectionManifest;

const surfaceRows = [
  {
    id: "ss-gen-body",
    type: "AI_ANSWER",
    provider: "YANDEX",
    source: "REAL_YANDEX",
    region: "RU",
    query: "Мордашов Алексей Александрович",
    title: "Нейро-ответ Яндекса (официальный API): Мордашов Алексей Александрович",
    snippet: "Алексей Мордашов — российский предприниматель.",
    url: "yandex-gen://answer/abc123",
    rank: 1,
    rawMetadata: { source: "yandex", method: "gen-search", contentKind: "answer_text" },
    capturedAt: new Date("2026-08-20T00:00:00.000Z"),
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
  },
  {
    id: "ss-gen-src",
    type: "AI_ANSWER",
    provider: "YANDEX",
    source: "REAL_YANDEX",
    region: "RU",
    query: "Мордашов Алексей Александрович",
    title: "Мордашов — Википедия",
    snippet: null,
    url: "https://ru.wikipedia.org/wiki/Мордашов",
    rank: 2,
    capturedAt: new Date("2026-08-20T00:00:00.000Z"),
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
  },
  {
    id: "ss-organic",
    type: "ORGANIC_RESULT",
    provider: "YANDEX",
    source: "REAL_YANDEX",
    region: "RU",
    query: "Мордашов Алексей Александрович",
    title: "Мордашов — Википедия",
    snippet: "Статья энциклопедии.",
    url: "https://ru.wikipedia.org/wiki/Мордашов",
    rank: 1,
    capturedAt: new Date("2026-08-20T00:00:00.000Z"),
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
  },
];

const prisma = {
  searchResult: { findMany: async () => [] },
  searchSurfaceItem: { findMany: async () => surfaceRows },
} as never;

describe("базовая строка нейро-ответа на слиянии", () => {
  it("получает поверхность ai_answer, движок YANDEX и провайдера yandex", async () => {
    const merge = await mergeCompositeSerp({ prisma, manifest: MANIFEST });
    const ai = merge.observations.filter((o) => o.surface === "ai_answer");
    expect(ai).toHaveLength(2);
    for (const row of ai) {
      expect(row.engine).toBe("YANDEX");
      expect(row.primaryProvider).toBe("yandex");
      expect(row.region).toBe("RU");
    }
    expect(ai.find((o) => o.url === "yandex-gen://answer/abc123")?.snippet).toBe(
      "Алексей Мордашов — российский предприниматель."
    );
  });

  it("вид строки доезжает до инвентаря, которым меряет аналитика", async () => {
    // Без этого звена «маркер это или материал» снова решалось бы гаданием по
    // словам там, где сборщик знает ответ точно.
    const merge = await mergeCompositeSerp({ prisma, manifest: MANIFEST });
    const body = merge.observations.find((o) => o.url === "yandex-gen://answer/abc123");
    expect(body?.contentKind).toBe("answer_text");
    const inventory = compositeObservationsToInventory({
      caseId: "case-gen",
      baseReportRunId: "run-1",
      enrichmentRunId: null,
      observations: merge.observations,
    });
    const item = inventory.find((i) => i.sourceUrl === "yandex-gen://answer/abc123");
    expect((item?.rawMetadata as { contentKind?: string })?.contentKind).toBe("answer_text");
  });

  it("источник ответа не схлопывается с органикой того же адреса", async () => {
    const merge = await mergeCompositeSerp({ prisma, manifest: MANIFEST });
    const wiki = merge.observations.filter(
      (o) => o.url === "https://ru.wikipedia.org/wiki/Мордашов"
    );
    expect(wiki.map((o) => o.surface).sort()).toEqual(["ai_answer", "organic"]);
  });
});

describe("ячейки покрытия из записи о попытке", () => {
  const cells = (probe: unknown) => genAnswerCoverageCells({ yandexGenAnswerProbe: probe });

  it("успех ячейки не заводит — собранное доказывают строки", () => {
    expect(cells({ status: "SUCCESS", query: "q", errorCode: null })).toEqual([]);
  });

  it("старый прогон без поля ведёт себя как раньше", () => {
    expect(genAnswerCoverageCells({})).toEqual([]);
    expect(genAnswerCoverageCells(null)).toEqual([]);
  });

  it("сбой даёт ячейку сбоя с кодом", () => {
    const [cell] = cells({ status: "FAILED", query: "q", errorCode: "PROVIDER_TIMEOUT" });
    expect(cell).toMatchObject({
      region: "RU",
      engine: "YANDEX",
      surface: "ai_answers",
      provider: "yandex",
      errorCode: "PROVIDER_TIMEOUT",
    });
    // Статус обязан попадать в набор записываемых, иначе ячейка не доедет до деки.
    expect(cell!.status).toBe("ERROR");
  });

  it("ненастроенный провайдер даёт «не собиралась» с причиной", () => {
    const [cell] = cells({
      status: "NOT_CONFIGURED",
      query: null,
      errorCode: "PROVIDER_NOT_CONFIGURED",
    });
    expect(cell!.status).toBe("NOT_COLLECTED");
    expect(cell!.errorCode).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("пустой ответ и отказ модели — измеренная ячейка", () => {
    for (const status of ["NO_RESULTS", "REJECTED"]) {
      const [cell] = cells({ status, query: "q", errorCode: null });
      expect(cell!.status).toBe("NO_RESULTS");
      expect(cell!.surface).toBe("ai_answers");
    }
  });
});

describe("нейро-ответ меряется своей линейкой, а не линейкой органики", () => {
  it("у него собственный класс содержимого, а не UNKNOWN", () => {
    expect(mapResultClassToContentClass(undefined, "AI_ANSWER")).toBe("AI_ANSWER");
  });

  it("оценка наблюдения доносит класс до карточки качества", () => {
    const assessment = evaluateEvidenceItem({
      id: "ss-gen-body",
      surfaceType: "AI_ANSWER",
      title: "Нейро-ответ Яндекса (официальный API): Мордашов Алексей Александрович",
      snippet: "Алексей Мордашов — российский предприниматель.",
      url: "yandex-gen://answer/abc123",
      region: "RU",
      subjectFullName: "Мордашов Алексей Александрович",
    } as never);
    expect(assessment.contentClass).toBe("AI_ANSWER");
  });
});
