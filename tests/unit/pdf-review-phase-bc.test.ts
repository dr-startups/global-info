/**
 * PDF review 31 — phases B.2–B.4 and C.4/C.5 (offline acceptance).
 * - B.2: one formula for theme counters; compliance checked-vs-rows clarifier
 * - B.3: regional pages cite only their own region's sources
 * - B.4: NOT_COLLECTED vs «collected, empty for this region» are distinct
 * - C.4: multi-record compliance tables carry group bands
 * - C.5: the global diff line is absent from regional summaries
 */

import { describe, expect, it } from "vitest";
import {
  buildComplianceFragment,
  buildRegionalSummaryFragment,
  coverageContent,
  localizedThemedClaim,
  resolveEmptySurfaceCollection,
  sourceLine,
} from "../../src/modules/digital-profile/orion-golden/deck-sections";

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

const CROSS_REGIONAL_FINDING = {
  findingId: "finding-crime-subject_match-aaaa1111",
  theme: "Криминальные / судебные материалы",
  claim:
    "21 публикация, из них с негативным содержанием — 21. Источники: dzen.ru, secrets.tbank.ru, 24smi.org. Примеры заголовков: Биография предпринимателя · Личная жизнь",
  subjectMatch: "SUBJECT_MATCH",
  riskLevel: "high",
  confidence: 0.9,
  regions: ["RU", "UAE"],
  sourceDomains: ["dzen.ru", "secrets.tbank.ru", "24smi.org", "gulfnews.com"],
  evidenceRefs: ["ev-ru-1", "ev-ru-2", "ev-uae-1"],
  recommendedAction: "Проверить первоисточники.",
  promotionPriority: "P1",
};

const UAE_ONLY_FINDING = {
  findingId: "finding-business-subject_match-bbbb2222",
  theme: "Деловой профиль",
  claim: "3 публикации, негативного содержания не зафиксировано. Источники: gulfnews.com.",
  subjectMatch: "SUBJECT_MATCH",
  riskLevel: "low",
  confidence: 0.8,
  regions: ["UAE"],
  sourceDomains: ["gulfnews.com"],
  evidenceRefs: ["ev-uae-1"],
  recommendedAction: "Мониторить.",
  promotionPriority: "P2",
};

const UAE_SCOPED = {
  subject: { displayName: "Тестов Иван", aliases: [] },
  findings: [CROSS_REGIONAL_FINDING, UAE_ONLY_FINDING],
  surfaceUnits: [],
  metricSnapshot: METRIC_SNAPSHOT,
  scope: { regions: ["UAE"], surfaces: [], subjectMatch: null, findingIds: null },
  evidenceIndex: {
    "ev-ru-1": { domain: "dzen.ru", region: "RU", title: "Биография предпринимателя" },
    "ev-ru-2": { domain: "secrets.tbank.ru", region: "RU", title: "Личная жизнь" },
    "ev-uae-1": { domain: "gulfnews.com", region: "UAE", title: "Business profile in UAE" },
    "ev-neutral": { domain: "en.wikipedia.org", title: "Wikipedia article" },
  },
};

describe("B.3 — regional source localization", () => {
  it("sourceLine on a UAE page keeps only its own region", () => {
    // Свидетельство без региона отсюда убрано решением владельца: подвал
    // источников и блок темы стоят на одном слайде, и блок темы такую запись
    // не считает и не цитирует. Пока подвал её называл, лист отвечал на вопрос
    // «относится ли материал к этому региону» дважды и по-разному.
    const line = sourceLine(UAE_SCOPED as never);
    expect(line).toContain("gulfnews.com");
    expect(line).not.toContain("en.wikipedia.org");
    expect(line).not.toContain("dzen.ru");
    expect(line).not.toContain("secrets.tbank.ru");
  });

  it("localizedThemedClaim rebuilds sources/examples of a cross-regional finding from region evidence", () => {
    const localized = localizedThemedClaim(
      CROSS_REGIONAL_FINDING as never,
      UAE_SCOPED as never
    );
    expect(localized).toMatch(/— источник gulfnews\.com|Где видно: gulfnews\.com|Источники в регионе: gulfnews\.com/u);
    expect(localized).not.toContain("dzen.ru");
    expect(localized).not.toContain("24smi.org");
    expect(localized).toContain("Business profile in UAE");
    expect(localized).not.toContain("Биография предпринимателя");
  });

  it("localizedThemedClaim keeps single-region findings untouched", () => {
    const localized = localizedThemedClaim(UAE_ONLY_FINDING as never, UAE_SCOPED as never);
    expect(localized).toMatch(/Источники: gulfnews\.com|Где видно: gulfnews\.com|— источник gulfnews\.com/u);
  });

  it("global (executive) scope keeps the aggregated claim", () => {
    const globalScoped = { ...UAE_SCOPED, scope: { ...UAE_SCOPED.scope, regions: null } };
    const localized = localizedThemedClaim(
      CROSS_REGIONAL_FINDING as never,
      globalScoped as never
    );
    expect(localized).toContain("dzen.ru");
  });
});

describe("B.2 + C.5 — regional summary counters and diff line", () => {
  const out = buildRegionalSummaryFragment(
    "UAE_SUMMARY" as never,
    "UAE" as never,
    "ОАЭ",
    UAE_SCOPED as never,
    {
      reportDiff: { newCount: 610, goneCount: 46 } as never,
    } as never
  );
  const summary = out.slides.find((s) => s.templateId === "regional-summary")!;

  it("narrative explains both counters in one formula", () => {
    // Прежде здесь требовалось «проверяющий увидит N материалов». Обещание
    // было ложным: аудит смотрит ТОП-20 по каждому запросу, а проверяющий
    // видит двадцать строк выдачи, а не весь собранный корпус. Собранное
    // называется собранным.
    expect(summary.content.narrative).toMatch(/собрано/u);
    expect(summary.content.narrative).not.toMatch(/проверяющий увидит/u);
    expect(summary.content.narrative).toMatch(
      /[Пп]одтверждённых тем: 2, из них повышенного внимания: 1/u
    );
    expect(summary.content.kpis?.some((k) => k.label === "Собрано по региону")).toBe(true);
  });

  it("regional summary bullets quote only regional sources for cross-regional findings", () => {
    const joined = (summary.content.bullets ?? []).join("\n");
    expect(joined).not.toContain("dzen.ru");
    expect(joined).toMatch(
      /— источник gulfnews\.com|Где видно: gulfnews\.com|Источники в регионе: gulfnews\.com|Источники: gulfnews\.com/u
    );
  });

  it("the global diff line is not repeated in regional summaries (C.5)", () => {
    const allText = JSON.stringify(out.slides);
    expect(allText).not.toContain("с прошлого отчёта");
  });
});

describe("B.4 — NOT_COLLECTED vs collected-but-empty-for-region", () => {
  const base = {
    surfaceUnits: [],
    scope: { regions: ["UAE"], surfaces: null, subjectMatch: null, findingIds: null },
  };

  it("surface measured in another region → MEASURED_EMPTY with regional label", () => {
    const status = resolveEmptySurfaceCollection(
      {
        ...base,
        surfaceCollectionHints: [{ surface: "organic", region: "RU", status: "OK" }],
      } as never,
      "organic"
    );
    expect(status.kind).toBe("MEASURED_EMPTY");
    expect(status.reasonLabel).toMatch(/по данному региону/);
    const content = coverageContent("no-organic-data", status);
    expect(content.narrative).toMatch(/выполнен/);
    expect(content.narrative).not.toMatch(/не собиралась/);
  });

  it("no collection anywhere → NOT_COLLECTED stays honest", () => {
    const status = resolveEmptySurfaceCollection(
      { ...base, surfaceCollectionHints: [] } as never,
      "organic"
    );
    expect(status.kind).toBe("NOT_COLLECTED");
    const content = coverageContent("no-organic-data", status);
    expect(content.narrative).toMatch(/не собиралась/);
  });
});

describe("B.2 + C.4 — compliance table", () => {
  const lexisHit = (ref: string, name: string) => ({
    kind: "compliance_hit",
    providerLabel: "LEXISNEXIS",
    matchCategory: "ADVERSE_MEDIA",
    matchScore: 85,
    reviewStatus: "PENDING",
    title: name,
  });
  const scoped = {
    subject: { displayName: "Тестов Иван", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "compliance",
        region: "GLOBAL",
        metrics: [{ key: "totalCount", value: 5 }],
        claims: [],
        evidenceRefs: ["c-1", "c-2"],
      },
    ],
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: null, surfaces: ["compliance"], subjectMatch: null, findingIds: null },
    evidenceIndex: {
      "hit-1": lexisHit("hit-1", "Тестов Иван Петрович"),
      "hit-2": lexisHit("hit-2", "Testov Ivan"),
    },
  };
  const out = buildComplianceFragment("COMPLIANCE" as never, scoped as never, {} as never);

  /**
   * B.2 переехал на другое основание. Клэрифаер «По 3 записям совпадений не
   * выявлено» объяснял разницу между метрикой поверхности (`totalCount`, куда
   * входят внутренние находки) и числом строк таблицы. Число записей теперь
   * считается по самим записям баз и со строками совпадает — объяснять нечего,
   * а метрика поверхности больше не цитируется как «записи баз».
   */
  it("summary narrative counts database records, not the surface metric (B.2)", () => {
    const summary = out.slides[0]!;
    expect(summary.content.narrative).toMatch(
      /Записей, отобранных по имени субъекта в комплаенс-базах: 2/
    );
    expect(summary.content.narrative).not.toMatch(/По 3 записям совпадений не выявлено/);
    expect(summary.content.table?.rows.length).toBe(2);
  });

  it("multiple provider records become banded groups, not one flat param list (C.4)", () => {
    // Слайд выбирается по слоту: сводная страница теперь тоже называет базы в
    // нарративе, и поиск подстрокой находил бы её.
    const lexis = out.slides.find((s) => s.slideId === "p35_lexis_visual")!;
    const table = lexis.content.table!;
    expect(table.groups?.length).toBeGreaterThanOrEqual(2);
    expect(table.groups![0]!.qTag).toBe("Запись 1 из 2");
    expect(table.groups![1]!.qTag).toBe("Запись 2 из 2");
    // Band rows cover every table row exactly once.
    const covered = table.groups!.reduce((n, g) => n + g.rowCount, 0);
    expect(covered).toBe(table.rows.length);
  });

  /**
   * Шаг 13, C13 — база без записей печаталась как содержательный профиль:
   * таблица «Параметр / Значение», где значениями была проза, и утверждение
   * «Категория PEP влияет на уровень комплаенс-контроля» при нуле записей.
   */
  describe("C13 — база без записей подаётся как результат проверки", () => {
    const empty = buildComplianceFragment(
      "COMPLIANCE" as never,
      { ...scoped, evidenceIndex: {} } as never,
      {} as never
    );
    const dow = empty.slides.find((s) => s.slideId === "p34_dow_jones")!;

    it("вместо таблицы из прозы — пустое состояние", () => {
      expect(dow.templateId).toBe("coverage-empty-state");
      expect(dow.content.table).toBeUndefined();
      // Без записи о проверке страница говорит «проверка не выполнялась», а не
      // «проверка выполнена, записей нет»: второе — утверждение о проверке,
      // данных о которой нет.
      expect(dow.content.narrative).toMatch(/не выполнялась/);
    });

    it("не утверждает значимость категории PEP без единой записи", () => {
      const text = JSON.stringify(dow.content);
      expect(text).not.toContain("Категория PEP влияет");
      expect(text).toContain("В текущем наборе такой записи по субъекту нет");
    });

    it("рекомендация выполнима: нечего запрашивать — нечего и сверять", () => {
      // «Повторить сверку» невыполнима там, где сверки не было: рекомендация
      // называет то, чем состояние лечится, — доступ или ручной импорт.
      expect(dow.content.whatToCheck).toMatch(/подключить официальный доступ|импортировать/i);
      expect(dow.content.whatToCheck).not.toMatch(/^Запросить полную запись/);
    });

    it("страница с записями остаётся таблицей", () => {
      const lexis = out.slides.find((s) => s.slideId === "p35_lexis_visual")!;
      expect(lexis.content.table?.rows.length).toBeGreaterThan(0);
    });
  });
});
