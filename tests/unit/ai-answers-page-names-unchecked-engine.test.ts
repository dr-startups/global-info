import { describe, expect, it } from "vitest";
import {
  buildKnowledgeAiFragment,
  coverageContent,
  googleAnswerProbeHints,
  resolveEmptySurfaceCollection,
  type ScopedFragmentInput,
  type SurfaceCollectionHint,
} from "@/modules/digital-profile/orion-golden/deck-sections";

/**
 * Шаг AL. Страница ИИ-ответов не выдаёт невыполненную проверку за пустой
 * результат — с точностью до поисковой системы.
 *
 * Прогон 76: `ai-serp` не входил в состав, поэтому нейро-ответы Яндекса никто
 * не спрашивал; при этом выдача Google была разобрана, и «готового ответа нет»
 * — измеренный факт. Отчёт печатал «проверены: материалов нет» про обе.
 */

const METRIC_SNAPSHOT = {
  metricSnapshotId: "m-1",
  datasetId: "d-1",
  reportRunId: "r-1",
  baseCount: 100,
  enrichmentCount: 0,
  compositeCount: 100,
  subjectMatchCount: 30,
  likelySubjectCount: 0,
  ambiguousCount: 0,
  otherSubjectCount: 0,
  adverseFindingCount: 1,
  perRegionCounts: { RU: 60, UAE: 40 },
};

function scopedRuAi(hints: SurfaceCollectionHint[]): ScopedFragmentInput {
  return {
    subject: { displayName: "Тестов Иван", aliases: [] },
    findings: [],
    surfaceUnits: [],
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: ["RU"], surfaces: ["ai_answers"], subjectMatch: null, findingIds: null },
    evidenceIndex: {},
    surfaceCollectionHints: hints,
  } as unknown as ScopedFragmentInput;
}

/** Ячейка выключенного инструмента — как её пишет prepare. */
const notCollected = (region: string, engine: string): SurfaceCollectionHint => ({
  surface: "ai_answers",
  region,
  engine,
  status: "NOT_COLLECTED",
  provider: "arsenkin",
  errorCode: "DISABLED_BY_TOOLS",
});

/** Выведенная подсказка по разобранной выдаче Google. */
const googleProbe = (region: string): SurfaceCollectionHint => ({
  surface: "ai_answers",
  region,
  engine: "GOOGLE",
  status: "NO_RESULTS",
  errorCode: null,
  provider: "GOOGLE",
});

/** Ячейка настоящей проверки Арсенкином (эталон report-72). */
const arsenkinMeasured = (region: string, engine: string): SurfaceCollectionHint => ({
  surface: "ai_answer",
  region,
  engine,
  status: "NO_RESULTS",
  provider: "arsenkin",
  errorCode: null,
});

function aiSlide(hints: SurfaceCollectionHint[]) {
  const out = buildKnowledgeAiFragment(
    "RU_KNOWLEDGE_AI",
    "RU_PROFILE",
    "Россия",
    scopedRuAi(hints),
    {} as never
  );
  const slide = out.slides.find((s) => s.baseSlotId === "p19_ru_knowledge_2");
  if (!slide) throw new Error("страница AI-ответов не собралась");
  return slide;
}

describe("страница «Россия — AI-ответы поисковых систем»", () => {
  it("не утверждает проверку там, где инструмент не входил в состав прогона", () => {
    const slide = aiSlide([
      notCollected("RU", "YANDEX"),
      notCollected("RU", "GOOGLE"),
      googleProbe("RU"),
    ]);
    const text = JSON.stringify(slide.content);

    expect(slide.emptyStateReason).toBe("no-ai-answers");
    expect(text).not.toContain("проверены: материалов нет");
    // Поле AI Overview наш адаптер не читает — утверждать о нём нечего.
    expect(text).not.toContain("AI Overview");
    expect(text).toMatch(/не проверял/);
    expect(text).toMatch(/не входил в состав прогона/);
    expect(text).toContain("Яндексе");
    expect(text).toContain("Google");
    // Причина «недоступен на тарифе» из данных прогона не выводится.
    expect(text).not.toMatch(/тариф/i);
  });

  it("не печатает внутренние коды покрытия", () => {
    const text = JSON.stringify(
      aiSlide([notCollected("RU", "YANDEX"), notCollected("RU", "GOOGLE"), googleProbe("RU")])
    );
    expect(text).not.toMatch(/DISABLED_BY_TOOLS|EMPTY_VALID|NOT_COLLECTED|MEASURED_PARTIAL/);
  });

  it("на прогоне, где инструмент спрашивал оба движка, формулировка прежняя", () => {
    const slide = aiSlide([arsenkinMeasured("RU", "YANDEX"), arsenkinMeasured("RU", "GOOGLE")]);
    expect(slide.content.narrative).toBe(
      "Ответы ИИ-поиска (AI Overview, нейро-ответы) по запросам о субъекте проверены: материалов нет — это результат проверки."
    );
  });
});

describe("состояние сбора поверхности по поисковым системам", () => {
  it("измеренный Google и неспрошенный Яндекс дают частичный статус", () => {
    const status = resolveEmptySurfaceCollection(
      scopedRuAi([notCollected("RU", "YANDEX"), notCollected("RU", "GOOGLE"), googleProbe("RU")]),
      "ai_answers"
    );
    expect(status.kind).toBe("MEASURED_PARTIAL");
    expect(status.measuredEngines).toEqual(["GOOGLE"]);
    expect(status.notCollectedEngines).toEqual(["YANDEX"]);
    expect(status.reasonLabel).toMatch(/не входил в состав прогона/);
  });

  it("несобранное по всем движкам остаётся NOT_COLLECTED с причиной", () => {
    const status = resolveEmptySurfaceCollection(
      scopedRuAi([notCollected("RU", "YANDEX"), notCollected("RU", "GOOGLE")]),
      "ai_answers"
    );
    expect(status.kind).toBe("NOT_COLLECTED");
    expect(status.reasonLabel).toMatch(/не входил в состав прогона/);
    const copy = coverageContent("no-ai-answers", status);
    expect(String(copy.narrative)).toMatch(/не собиралась|не проверял/);
    expect(JSON.stringify(copy)).not.toMatch(/DISABLED_BY_TOOLS|NOT_COLLECTED/);
  });

  it("сбой одного движка при измеренном другом — тоже частичный статус", () => {
    const status = resolveEmptySurfaceCollection(
      scopedRuAi([
        { surface: "ai_answers", region: "RU", engine: "YANDEX", status: "HTTP_500", errorCode: "PROVIDER_TIMEOUT" },
        googleProbe("RU"),
      ]),
      "ai_answers"
    );
    expect(status.kind).toBe("MEASURED_PARTIAL");
    expect(status.notCollectedEngines).toEqual(["YANDEX"]);
    expect(status.reasonLabel).toMatch(/ошибка|не удалось/i);
    expect(JSON.stringify(coverageContent("no-ai-answers", status))).not.toMatch(
      /HTTP_500|PROVIDER_TIMEOUT/
    );
  });

  it("статус NOT_COLLECTED не читается как сбой сбора", () => {
    const status = resolveEmptySurfaceCollection(
      scopedRuAi([notCollected("RU", "YANDEX")]),
      "ai_answers"
    );
    expect(status.kind).not.toBe("COLLECTION_FAILED");
  });

  it("подсказки без движка ведут себя как прежде", () => {
    // Все прочие поверхности подсказок с движком не имеют: их страницы обязаны
    // остаться дословно прежними.
    const noEngine = (status: string): SurfaceCollectionHint[] => [
      { surface: "suggestions", region: "RU", status },
    ];
    const scoped = (hints: SurfaceCollectionHint[]) =>
      ({
        ...scopedRuAi([]),
        scope: { regions: ["RU"], surfaces: ["suggestions"], subjectMatch: null, findingIds: null },
        surfaceCollectionHints: hints,
      }) as unknown as ScopedFragmentInput;

    expect(resolveEmptySurfaceCollection(scoped(noEngine("NO_RESULTS")), "suggestions").kind).toBe(
      "MEASURED_EMPTY"
    );
    expect(resolveEmptySurfaceCollection(scoped(noEngine("HTTP_500")), "suggestions").kind).toBe(
      "COLLECTION_FAILED"
    );
    expect(resolveEmptySurfaceCollection(scoped([]), "suggestions").kind).toBe("NOT_COLLECTED");
  });
});

describe("выведенная подсказка о разобранной выдаче Google", () => {
  it("не глушится ячейкой неспрошенного Яндекса того же региона", () => {
    const hints = googleAnswerProbeHints(
      [{ surface: "organic", region: "RU", engine: "GOOGLE" }],
      [notCollected("RU", "YANDEX")]
    );
    expect(hints).toEqual([
      {
        surface: "ai_answers",
        region: "RU",
        status: "NO_RESULTS",
        errorCode: null,
        provider: "GOOGLE",
        engine: "GOOGLE",
      },
    ]);
  });

  it("глушится измеренной подсказкой региона, как прежде", () => {
    const hints = googleAnswerProbeHints(
      [{ surface: "organic", region: "RU", engine: "GOOGLE" }],
      [arsenkinMeasured("RU", "GOOGLE")]
    );
    expect(hints).toEqual([]);
  });
});
