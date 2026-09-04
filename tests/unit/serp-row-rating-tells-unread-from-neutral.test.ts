/**
 * Оценка строки выдачи — собственный сигнал материала, и непрочитанная
 * страница называется словом.
 *
 * На отчёте Кремлёва 14 напечатанных строк из 38 стояли «Нейтральный» при
 * непрочитанной странице: девять с отказом чтения, пять без вердикта вовсе. И
 * наоборот: klerk.ru, чью страницу прочитали и признали благоприятной, стоял
 * «Нежелательным» — потому что его ссылка входила в доказательства темы
 * среднего уровня, а принадлежность к теме красила строку наравне с её
 * содержанием.
 */

import { describe, expect, it } from "vitest";
import { buildSerpFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  DECK_TEMPLATE_REGISTRY,
  RED_MARKER_LABEL,
  UNVERIFIED_LABEL,
} from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import { OTHER_SUBJECT_LABEL } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import { UNCONFIRMED_SUBJECT_LABEL } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const QUERY = "Умар Кремлёв";

type RowFixture = {
  ref: string;
  title: string;
  domain: string;
  url: string;
  snippet?: string;
  rank: number;
  subjectDecision?: string;
  readVerdictTone?: "adverse" | "neutral" | "supportive";
  adverse?: boolean;
  readFailure?: string;
  /** Код причины разметки: им отличается «совпало только имя». */
  subjectReason?: string;
  /** Второе наблюдение того же материала: свой ref, те же домен и заголовок. */
  alsoRef?: string;
};

function scopedRows(rows: RowFixture[], findings: unknown[] = []): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  for (const row of rows) {
    for (const ref of [row.ref, ...(row.alsoRef ? [row.alsoRef] : [])]) {
      evidenceIndex[ref] = {
        title: row.title,
        url: row.url,
        domain: row.domain,
        snippet: row.snippet,
        region: "RU",
        engine: "GOOGLE",
        rank: row.rank,
        rankSource: "serper",
        query: QUERY,
        queryPurpose: "subject_lookup",
        subjectDecision: row.subjectDecision ?? "SUBJECT_MATCH",
        subjectReason: row.subjectReason,
        // Загрузчик кладёт решение прочитанной страницы на все ссылки её
        // материала; второе наблюдение специально оставлено без него, чтобы
        // строка не зависела от того, какая ссылка оказалась первой.
        ...(ref === row.ref
          ? {
              ...(row.readVerdictTone ? { readVerdictTone: row.readVerdictTone } : {}),
              ...(row.adverse === undefined ? {} : { adverse: row.adverse }),
              ...(row.readFailure ? { readFailure: row.readFailure } : {}),
            }
          : {}),
      };
      refs.push(ref);
    }
  }
  return {
    findings,
    surfaceUnits: [
      { surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

/** Колонка «Оценка» первой страницы выдачи, строка за строкой. */
function ratings(rows: RowFixture[], findings: unknown[] = []): string[] {
  const slide = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scopedRows(rows, findings))
    .slides[0]!;
  const table = slide.content.table!;
  const column = table.headers.indexOf("Оценка");
  return table.rows.map((r) => r[column]!);
}

const CLEAN: RowFixture = {
  ref: "i1",
  title: "Интервью о планах федерации",
  domain: "sport-example.ru",
  url: "https://sport-example.ru/1",
  rank: 1,
};

describe("непрочитанная страница не печатается «Нейтральной»", () => {
  it("отказ чтения записан — «Не проверено»", () => {
    expect(ratings([{ ...CLEAN, readFailure: "blocked" }])).toEqual([UNVERIFIED_LABEL]);
  });

  it("вердикта нет вовсе — «Не проверено»", () => {
    expect(ratings([CLEAN])).toEqual([UNVERIFIED_LABEL]);
  });

  it("страницу прочитали и признали нейтральной — «Нейтральный»", () => {
    expect(ratings([{ ...CLEAN, readVerdictTone: "neutral" }])).toEqual(["Нейтральный"]);
  });

  it("вердикта нет, но словарь дал негатив — «Нежелательный», а не «Не проверено»", () => {
    expect(
      ratings([{ ...CLEAN, title: "Суд назначил слушание по делу федерации" }])
    ).toEqual([RED_MARKER_LABEL]);
  });
});

describe("порядок значений колонки", () => {
  it("вероятная принадлежность стоит выше непрочтения", () => {
    expect(ratings([{ ...CLEAN, subjectDecision: "LIKELY_SUBJECT" }])).toEqual(["Вероятно"]);
  });

  it("материал о другом лице называется прямо и без вердикта", () => {
    expect(ratings([{ ...CLEAN, subjectDecision: "OTHER_SUBJECT" }])).toEqual(["О другом лице"]);
  });
});

describe("принадлежность к теме сама по себе строку не красит", () => {
  const klerk: RowFixture = {
    ref: "i1",
    title: "Как считать амортизацию: разбор для бухгалтера",
    domain: "klerk.ru",
    url: "https://klerk.ru/buh/articles/1",
    snippet: "Материал для бухгалтеров о порядке расчёта.",
    rank: 1,
  };
  const offshoreTheme = [
    {
      findingId: "f-offshore",
      theme: "Офшоры / корпоративное владение",
      subjectMatch: "SUBJECT_MATCH",
      claim: "«Офшоры / корпоративное владение»\n2 свидетельства.",
      riskLevel: "medium",
      confidence: 0.8,
      promotionPriority: "P2",
      evidenceRefs: ["i1"],
      recommendedAction: "Сверить структуру владения.",
    },
  ];

  it("ссылка в доказательствах темы среднего уровня строку не краснит", () => {
    expect(ratings([klerk], offshoreTheme)).toEqual([UNVERIFIED_LABEL]);
  });

  it("та же строка с прочитанной нежелательной страницей краснеет", () => {
    expect(
      ratings([{ ...klerk, readVerdictTone: "adverse", adverse: true }], offshoreTheme)
    ).toEqual([RED_MARKER_LABEL]);
  });
});

describe("вердикт материала действует на все его наблюдения", () => {
  it("благоприятная страница не перебивается вторым наблюдением того же материала", () => {
    expect(
      ratings([
        {
          ref: "i1",
          alsoRef: "i1b",
          title: "Суд отказал в иске к федерации",
          domain: "sport-example.ru",
          url: "https://sport-example.ru/2",
          rank: 1,
          readVerdictTone: "supportive",
          adverse: false,
        },
      ])
    ).toEqual(["Нейтральный"]);
  });
});

describe("счётчики страницы называют непроверенные строки", () => {
  it("в метриках страницы стоит число строк без вердикта", () => {
    const scoped = scopedRows([
      CLEAN,
      { ...CLEAN, ref: "i2", url: "https://sport-example.ru/2", title: "Обзор турнира", rank: 2 },
      {
        ...CLEAN,
        ref: "i3",
        url: "https://sport-example.ru/3",
        title: "Итоги сезона",
        rank: 3,
        readVerdictTone: "neutral",
      },
    ]);
    const slide = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides[0]!;
    expect(slide.metrics?.unverifiedDisplayed).toBe(2);
  });
});

describe("легенда обещает ровно те оценки, которые бывают", () => {
  it("перечисляет все значения колонки в их порядке", () => {
    // Легенда обещала «Позитивный», которого построитель не печатает никогда, и
    // молчала о «О другом лице», который печатает. Порядок — тот же, в каком
    // значения выбираются: от самого сильного утверждения к самому слабому.
    expect(DECK_TEMPLATE_REGISTRY["serp-table"].legend).toEqual([
      OTHER_SUBJECT_LABEL,
      // Шаг 0054: «совпало только имя» стоит выше негатива — чужой материал,
      // покрашенный красным, уводит читателя удалять не своё.
      UNCONFIRMED_SUBJECT_LABEL,
      RED_MARKER_LABEL,
      "Вероятно",
      UNVERIFIED_LABEL,
      "Нейтральный",
    ]);
  });

  it("каждое значение легенды достижимо построителем", () => {
    const cases: Array<[string, RowFixture]> = [
      [OTHER_SUBJECT_LABEL, { ...CLEAN, subjectDecision: "OTHER_SUBJECT" }],
      [
        UNCONFIRMED_SUBJECT_LABEL,
        { ...CLEAN, subjectDecision: "AMBIGUOUS", subjectReason: "full_name_no_anchor" },
      ],
      [RED_MARKER_LABEL, { ...CLEAN, title: "Суд назначил слушание по делу федерации" }],
      ["Вероятно", { ...CLEAN, subjectDecision: "LIKELY_SUBJECT" }],
      [UNVERIFIED_LABEL, CLEAN],
      ["Нейтральный", { ...CLEAN, readVerdictTone: "neutral" }],
    ];
    for (const [label, row] of cases) expect(ratings([row])).toEqual([label]);
  });
});
