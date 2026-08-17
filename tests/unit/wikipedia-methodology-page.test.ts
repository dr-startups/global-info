import { describe, expect, it } from "vitest";
import { buildIdentityFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/identity";
import { runSurfaceAnalyzers } from "@/modules/digital-profile/orion-golden/analytics/surface-analyzers";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import { COVERAGE_EMPTY_COPY } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import { getClientTextFieldBudgets } from "@/modules/digital-profile/orion-golden/client/load-client-text-contract";

/**
 * Страница Википедии — методология, а не строка выдачи.
 *
 * Проверяются два независимых измерения состояния: результат проверки статьи
 * (есть / нет / неизвестен) и реально собранные строки выдачи. Признаком
 * присутствия число юнитов не является: маркер «статья не найдена» — тоже юнит.
 */

type CheckInput = {
  exists: boolean;
  language?: string;
  title?: string;
  url?: string;
  checkedAt?: string;
  subjectDecision?: string;
};

type RowInput = { title: string; decision?: string; domain?: string };

type ScopedInput = {
  checks?: CheckInput[];
  rows?: RowInput[];
  markerCount?: number;
  /** Юнита поверхности нет вовсе — сбор не запускался. */
  noUnit?: boolean;
  hints?: Array<{ surface: string; region?: string; status: string; errorCode?: string | null }>;
  region?: "RU" | "UAE";
};

function wikiScoped(input: ScopedInput): ScopedFragmentInput {
  const region = input.region ?? "RU";
  const rows = input.rows ?? [];
  const evidenceIndex: Record<string, unknown> = {};
  const rowRefs = rows.map((r, i) => {
    const ref = `inventory:wiki-row-${i}`;
    const domain = r.domain ?? "ru.wikipedia.org";
    evidenceIndex[ref] = {
      kind: "wikipedia",
      region,
      title: r.title,
      domain,
      url: `https://${domain}/wiki/row${i}`,
      subjectDecision: r.decision ?? "AMBIGUOUS",
    };
    return ref;
  });
  // Заголовок маркера нейтрален — ровно как на прогоне 72, где записи
  // «статья не найдена» приходят с заголовком «Wikipedia». Признак маркера
  // живёт в юните (`emptyMarkerRefs`), а не в тексте заголовка.
  const markerRefs = Array.from({ length: input.markerCount ?? 0 }, (_, i) => {
    const ref = `inventory:wiki-marker-${i}`;
    evidenceIndex[ref] = { kind: "wikipedia", region, title: "Wikipedia" };
    return ref;
  });
  for (const [i, c] of (input.checks ?? []).entries()) {
    const language = c.language ?? "ru";
    evidenceIndex[`inventory:wiki-check-${i}`] = {
      kind: "wikipedia_check",
      wikipediaExists: c.exists,
      language,
      title: c.title,
      url: c.url,
      checkedAt: c.checkedAt,
      subjectDecision: c.subjectDecision,
      domain: `${language}.wikipedia.org`,
      region: language.startsWith("ru") ? "RU" : "UAE",
    };
  }
  const decisionOf = (r: RowInput): string => r.decision ?? "AMBIGUOUS";
  const status = "MEASURED";
  const units = input.noUnit
    ? []
    : [
        {
          surface: "wikipedia",
          region,
          claims: [],
          metrics: [
            { key: "totalCount", value: rows.length, sampleStatus: status, denominator: rows.length },
            {
              key: "subjectMatchCount",
              value: rows.filter((r) => decisionOf(r) === "SUBJECT_MATCH").length,
              sampleStatus: status,
            },
            {
              key: "otherSubjectCount",
              value: rows.filter((r) => decisionOf(r) === "OTHER_SUBJECT").length,
              sampleStatus: status,
            },
            {
              key: "ambiguousCount",
              value: rows.filter((r) => decisionOf(r) === "AMBIGUOUS").length,
              sampleStatus: status,
            },
            { key: "adverseSubjectCount", value: 0, sampleStatus: status, denominator: 0 },
            { key: "emptyMarkerCount", value: markerRefs.length, sampleStatus: "MEASURED" },
          ],
          evidenceRefs: [...rowRefs, ...markerRefs],
          emptyMarkerRefs: markerRefs,
        },
      ];
  return {
    subject: { displayName: "Anders Holmström", aliases: [] },
    findings: [],
    surfaceUnits: units,
    evidenceIndex,
    scope: { regions: [region], surfaces: ["wikipedia"], subjectMatch: null, findingIds: null },
    metricSnapshot: {},
    surfaceCollectionHints: input.hints,
  } as unknown as ScopedFragmentInput;
}

function build(input: ScopedInput): SlideContentContract {
  const uae = input.region === "UAE";
  const [slide] = buildIdentityFragment(
    uae ? "UAE_IDENTITY_WIKIPEDIA" : "RU_IDENTITY_WIKIPEDIA",
    uae ? "UAE_PROFILE" : "RU_PROFILE",
    uae ? "ОАЭ / международный" : "Россия",
    wikiScoped(input)
  ).slides;
  return slide!;
}

/** Весь клиентский текст страницы — то, что прочитает читатель отчёта. */
function pageText(slide: SlideContentContract): string {
  const c = slide.content;
  return [
    c.narrative,
    ...(c.bullets ?? []),
    c.whatWasFound,
    c.whyItMatters,
    c.whatToCheck,
    c.statusNote,
    c.sourceNote,
  ]
    .filter(Boolean)
    .join(" ");
}

function countOf(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

const ARTICLE_FOUND = {
  checks: [
    {
      exists: true,
      language: "ru",
      title: "Anders Holmström",
      url: "https://ru.wikipedia.org/wiki/Anders_Holmstrom",
      checkedAt: "2026-07-01T12:00:00.000Z",
      subjectDecision: "SUBJECT_MATCH",
    },
  ],
  rows: [{ title: "Anders Holmström — биография", decision: "SUBJECT_MATCH" }],
} satisfies ScopedInput;

const ARTICLE_ABSENT = {
  checks: [{ exists: false, language: "ru", checkedAt: "2026-07-01T12:00:00.000Z" }],
  noUnit: true,
} satisfies ScopedInput;

describe("страница Википедии: статья найдена", () => {
  it("печатает метод проверки, результат и рекомендацию контролировать содержимое", () => {
    const slide = build(ARTICLE_FOUND);
    const narrative = slide.content.narrative ?? "";
    expect(narrative).toContain("официальный поисковый API Википедии");
    expect(narrative).toContain("в русскоязычном разделе (ru.wikipedia.org)");
    expect(narrative).toContain("проверка выполнена 01.07.2026");
    expect(narrative).toContain("статья о проверяемом лице найдена");
    expect(narrative).toContain("«Anders Holmström»");
    expect(narrative).toContain("ru.wikipedia.org/wiki/Anders_Holmstrom");
    expect(slide.content.whyItMatters ?? "").toMatch(/панел[ия] знаний/u);
    expect(slide.content.whyItMatters ?? "").toContain("Править статью может любой участник");
    expect(slide.content.whatToCheck ?? "").toMatch(/^Мы предлагаем контролировать/u);
    expect(slide.content.whatToCheck ?? "").toContain("историю правок");
  });

  it("без даты проверки не выдумывает её", () => {
    const slide = build({
      ...ARTICLE_FOUND,
      checks: [{ ...ARTICLE_FOUND.checks[0]!, checkedAt: undefined }],
    });
    expect(slide.content.narrative ?? "").toContain("официальный поисковый API Википедии");
    expect(pageText(slide)).not.toContain("проверка выполнена");
  });

  it("факт найденной статьи печатается один раз", () => {
    const slide = build(ARTICLE_FOUND);
    expect(countOf(pageText(slide), /найдена/gu)).toBe(1);
  });
});

describe("страница Википедии: статьи нет", () => {
  it("печатает метод проверки, оба «почему» и рекомендацию создать статью", () => {
    const slide = build(ARTICLE_ABSENT);
    expect(slide.templateId).toBe("coverage-empty-state");
    expect(slide.emptyStateReason).toBe("wikipedia-not-found");
    const narrative = slide.content.narrative ?? "";
    expect(narrative).toContain("официальный поисковый API Википедии");
    expect(narrative).toContain("в русскоязычном разделе (ru.wikipedia.org)");
    expect(narrative).toContain("статья о проверяемом лице не найдена");
    expect(narrative).toContain("итог выполненной проверки");
    const bullets = slide.content.bullets ?? [];
    expect(bullets).toHaveLength(2);
    expect(bullets[0]).toContain("панел");
    expect(bullets[1]).toContain("Пока статьи нет");
    expect(slide.content.whatToCheck ?? "").toMatch(/^Мы предлагаем рассмотреть создание/u);
    expect(pageText(slide)).not.toContain("контролировать");
  });

  it("собранные строки не отменяют методологию и рекомендацию", () => {
    const slide = build({
      checks: [{ exists: false, language: "ru", checkedAt: "2026-07-01T12:00:00.000Z" }],
      rows: [{ title: "Однофамилец — биография", decision: "OTHER_SUBJECT" }],
    });
    expect(slide.templateId).toBe("wikipedia-knowledge");
    expect(slide.content.narrative ?? "").toContain("официальный поисковый API Википедии");
    expect(slide.content.narrative ?? "").toContain("статья о проверяемом лице не найдена");
    expect(slide.content.whatToCheck ?? "").toMatch(/^Мы предлагаем рассмотреть создание/u);
  });
});

describe("рекомендация зависит от результата проверки", () => {
  it("«создать» и «контролировать» никогда не стоят на одной странице", () => {
    const found = build(ARTICLE_FOUND);
    const absent = build(ARTICLE_ABSENT);
    expect(found.content.whatToCheck ?? "").toMatch(/^Мы предлагаем контролировать/u);
    expect(absent.content.whatToCheck ?? "").toMatch(/^Мы предлагаем рассмотреть создание/u);
    expect(pageText(found)).not.toMatch(/рассмотреть создание/u);
    expect(pageText(absent)).not.toMatch(/контролировать/u);
  });

  it("тёзка не выдаётся за проверяемое лицо", () => {
    const slide = build({
      ...ARTICLE_FOUND,
      checks: [{ ...ARTICLE_FOUND.checks[0]!, subjectDecision: "AMBIGUOUS" }],
      rows: [{ title: "Глинка (дворянский род)", decision: "AMBIGUOUS" }],
    });
    const narrative = slide.content.narrative ?? "";
    expect(narrative).toContain("заголовок которой совпадает с именем субъекта");
    expect(narrative).toContain("принадлежность статьи проверяемому лицу не подтверждена");
    expect(narrative).not.toContain("статья о проверяемом лице найдена");
    expect(slide.content.whatToCheck ?? "").toMatch(/^Мы предлагаем сначала подтвердить принадлежность/u);
  });

  it("«почему важно» тёзки не выдаёт статью за биографию субъекта", () => {
    const named = build({
      ...ARTICLE_FOUND,
      checks: [{ ...ARTICLE_FOUND.checks[0]!, subjectDecision: "AMBIGUOUS" }],
    });
    const confirmed = build(ARTICLE_FOUND);
    const why = named.content.whyItMatters ?? "";
    expect(why).not.toBe(confirmed.content.whyItMatters);
    expect(why).toContain("независимо от того, о ком");
    // Подтверждённый вариант утверждает, что читатель видит биографию субъекта;
    // здесь принадлежность не подтверждена, и утверждать этого нельзя.
    expect(why).not.toContain("воспринимается читателем как проверенная биография");
  });
});

describe("дата проверки принадлежит той проверке, о которой сказано", () => {
  const check = (language: string, checkedAt?: string): CheckInput => ({
    exists: false,
    language,
    checkedAt,
  });

  it("две проверки одного контура с разными датами называют обе даты", () => {
    const slide = build({
      region: "UAE",
      noUnit: true,
      checks: [
        check("en", "2026-07-01T12:00:00.000Z"),
        check("ar", "2026-07-03T12:00:00.000Z"),
      ],
    });
    const narrative = slide.content.narrative ?? "";
    expect(narrative).toContain("в англоязычном разделе (en.wikipedia.org) и в разделе ar.wikipedia.org");
    expect(narrative).toContain("проверки выполнены 01.07.2026 и 03.07.2026");
  });

  it("одна дата на две проверки печатается один раз", () => {
    const slide = build({
      region: "UAE",
      noUnit: true,
      checks: [
        check("en", "2026-07-01T12:00:00.000Z"),
        check("ar", "2026-07-01T12:00:00.000Z"),
      ],
    });
    expect(slide.content.narrative ?? "").toContain("проверка выполнена 01.07.2026");
  });

  it("проверка без даты рядом с датированной не даёт назвать дату вовсе", () => {
    const slide = build({
      region: "UAE",
      noUnit: true,
      checks: [check("en", "2026-07-01T12:00:00.000Z"), check("ar")],
    });
    const narrative = slide.content.narrative ?? "";
    expect(narrative).toContain("в англоязычном разделе (en.wikipedia.org) и в разделе ar.wikipedia.org");
    expect(narrative).not.toContain("2026");
    expect(narrative).not.toContain("проверка выполнена");
    expect(narrative).not.toContain("проверки выполнены");
  });
});

describe("страница Википедии: результат проверки недоступен", () => {
  it("не собранная поверхность не делает вывода о статье и не называет метод", () => {
    const slide = build({ noUnit: true });
    expect(slide.templateId).toBe("coverage-empty-state");
    expect(slide.content.narrative ?? "").toContain("Поверхность не собиралась в этом прогоне");
    const text = pageText(slide);
    expect(text).not.toContain("API Википедии");
    expect(text).not.toContain("wikipedia.org");
    expect(text).not.toMatch(/найдена/u);
    expect(slide.content.whatToCheck).toBe(COVERAGE_EMPTY_COPY["no-identity-data"]!.measuredCheck);
    expect(slide.content.whatToCheck ?? "").toMatch(/^Мы предлагаем проверить наличие статьи вручную/u);
  });

  it("сорвавшийся сбор тоже не делает вывода о статье", () => {
    const slide = build({
      noUnit: true,
      hints: [{ surface: "wikipedia", region: "RU", status: "HTTP_500", errorCode: null }],
    });
    expect(slide.content.narrative ?? "").toMatch(/[Нн]е удалось собрать/u);
    const text = pageText(slide);
    expect(text).not.toContain("API Википедии");
    expect(text).not.toMatch(/найдена/u);
  });

  it("собранные строки без проверки статьи печатаются с прямым отказом от вывода", () => {
    const slide = build({ rows: [{ title: "Глинка (дворянский род)", decision: "AMBIGUOUS" }] });
    expect(slide.templateId).toBe("wikipedia-knowledge");
    const narrative = slide.content.narrative ?? "";
    expect(narrative).toContain("Результат отдельной проверки");
    expect(narrative).toContain("не делается");
    expect(narrative).toMatch(/принадлежность[^.]*не подтверждена/u);
    expect(pageText(slide)).not.toContain("о проверяемом субъекте");
    expect(slide.content.whatToCheck).toBe(COVERAGE_EMPTY_COPY["no-identity-data"]!.measuredCheck);
  });
});

describe("маркеры «статья не найдена» — не материалы", () => {
  it("два маркера без строк выдачи дают пустое состояние, а не материалы о субъекте", () => {
    const slide = build({ region: "UAE", markerCount: 2 });
    expect(slide.templateId).toBe("coverage-empty-state");
    expect(slide.emptyStateReason).toBe("no-identity-data");
    const text = pageText(slide);
    expect(text).not.toContain("зафиксированы энциклопедические материалы");
    expect(text).not.toContain("Wikipedia (en): статья не найдена");
    expect(slide.evidenceRefs).not.toContain("inventory:wiki-marker-0");
    expect(slide.evidenceRefs).not.toContain("inventory:wiki-marker-1");
  });

  it("маркер с нейтральным заголовком рядом со строкой выдачи не печатается плиткой", () => {
    // Форма прогона 72: маркер называется «Wikipedia», и по заголовку его не
    // отличить от материала. Опознать его может только тот, кто видел сниппет,
    // — анализатор; страница берёт его ответ.
    const slide = build({
      region: "UAE",
      markerCount: 1,
      rows: [{ title: "Encyclopedia entry", domain: "en.wikipedia.org", decision: "SUBJECT_MATCH" }],
    });
    expect(slide.content.bullets ?? []).toEqual(["Encyclopedia entry — en.wikipedia.org"]);
    expect(slide.evidenceRefs).not.toContain("inventory:wiki-marker-0");
  });
});

describe("маркер опознаётся один раз — в анализаторе", () => {
  it("запись «статья не найдена» с нейтральным заголовком не считается материалом", () => {
    const item = (over: Partial<RawInventoryItem>): RawInventoryItem => ({
      inventoryId: "x",
      caseId: "case-1",
      reportRunId: "run-1",
      source: "wikipedia_check",
      provider: "wikipedia",
      region: "UAE",
      collectedAt: "2026-07-01T12:00:00.000Z",
      evidenceType: "wikipedia_check",
      title: "Wikipedia",
      ...over,
    });
    const analysis = runSurfaceAnalyzers({
      caseId: "case-1",
      datasetId: "dataset-1",
      sourceHashes: [],
      resolutionLookup: new Map(),
      items: [
        item({
          inventoryId: "wiki-1",
          snippet: "Фактическая проверка Wikipedia: статья не найдена.",
        }),
        item({ inventoryId: "wiki-2", title: "Encyclopedia entry", snippet: "Биография." }),
      ],
    });
    const [unit] = analysis.wikipedia.units;
    const metric = (key: string): number => Number(unit!.metrics.find((m) => m.key === key)?.value);
    expect(metric("totalCount")).toBe(1);
    expect(metric("emptyMarkerCount")).toBe(1);
    // Счётчик и перечень — один и тот же ответ, и его читает страница.
    expect(unit!.emptyMarkerRefs).toEqual(["inventory:wiki-1"]);
  });
});

describe("языковой раздел называется по данным проверки", () => {
  it("английский раздел подписан по-русски", () => {
    const slide = build({
      region: "UAE",
      checks: [{ exists: false, language: "en", checkedAt: "2026-07-01T12:00:00.000Z" }],
      noUnit: true,
    });
    expect(slide.content.narrative ?? "").toContain("в англоязычном разделе (en.wikipedia.org)");
  });

  it("незнакомый код языка называет домен без выдуманного названия", () => {
    const slide = build({
      region: "UAE",
      checks: [{ exists: false, language: "de", checkedAt: "2026-07-01T12:00:00.000Z" }],
      noUnit: true,
    });
    const narrative = slide.content.narrative ?? "";
    expect(narrative).toContain("в разделе de.wikipedia.org");
    expect(narrative).not.toMatch(/немецк/iu);
  });

  it("русская проверка не попадает на страницу ОАЭ", () => {
    const slide = build({
      region: "UAE",
      checks: [{ exists: true, language: "ru", title: "Тёзка", subjectDecision: "SUBJECT_MATCH" }],
      noUnit: true,
    });
    const text = pageText(slide);
    expect(text).not.toContain("русскоязычном разделе");
    expect(text).not.toMatch(/найдена/u);
    expect(slide.content.whatToCheck).toBe(COVERAGE_EMPTY_COPY["no-identity-data"]!.measuredCheck);
  });
});

describe("бюджеты страницы закреплены числом", () => {
  /**
   * Карточки пустого состояния рендерер режет **тихо**: `content_card`
   * уменьшает кегль и отбрасывает предложения без телеметрии. Единственный
   * громкий рубеж этой страницы — эти числа.
   */
  const branches: Array<{ name: string; input: ScopedInput }> = [
    { name: "статья есть", input: ARTICLE_FOUND },
    { name: "статьи нет", input: ARTICLE_ABSENT },
    {
      name: "статьи нет, строки есть",
      input: {
        checks: [{ exists: false, language: "ru", checkedAt: "2026-07-01T12:00:00.000Z" }],
        rows: [{ title: "Однофамилец — биография", decision: "OTHER_SUBJECT" }],
      },
    },
    { name: "проверка не выполнялась", input: { noUnit: true } },
    { name: "маркеры без строк", input: { region: "UAE", markerCount: 2 } },
    { name: "строки без проверки", input: { rows: [{ title: "Глинка (дворянский род)" }] } },
    {
      name: "тёзка",
      input: {
        ...ARTICLE_FOUND,
        checks: [{ ...ARTICLE_FOUND.checks[0]!, subjectDecision: "AMBIGUOUS" }],
      },
    },
  ];

  const budgets = getClientTextFieldBudgets();

  for (const { name, input } of branches) {
    it(`«${name}» держится в бюджетах полей`, () => {
      const slide = build(input);
      const c = slide.content;
      expect((c.whatToCheck ?? "").length).toBeLessThanOrEqual(280);
      expect((c.whyItMatters ?? "").length).toBeLessThanOrEqual(400);
      expect((c.narrative ?? "").length).toBeLessThanOrEqual(budgets.narrative);
      expect((c.whatWasFound ?? "").length).toBeLessThanOrEqual(budgets.whatWasFound);
      for (const bullet of c.bullets ?? []) {
        expect(bullet.length).toBeLessThanOrEqual(budgets.bullet);
      }
      if (slide.templateId === "coverage-empty-state") {
        // Карточка «Статус сбора» — самая тесная на листе.
        expect((c.narrative ?? "").length).toBeLessThanOrEqual(520);
      }
    });
  }
});
