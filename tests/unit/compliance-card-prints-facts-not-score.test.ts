/**
 * Карточка комплаенса печатает факты записи, а не шкалу совпадения.
 *
 * На стр. 68–69 отчёта 25.08 обе записи выглядели одинаково — «100/100»,
 * «Требует ручной проверки», — и одна из них была о постороннем человеке.
 * Число 100 — честный ответ провайдера на вопрос «похожа ли запись на строку
 * запроса», а рядом со статусом «требует ручной проверки» клиент читает его как
 * ответ на вопрос «это он?». Слово «высокая» — уже наш перевод этого числа.
 *
 * Шкал при этом две и они не сравнимы: счёт провайдера и собственная
 * эвристика `computeMatchScore` для ручного импорта пишут в ту же колонку, и
 * 78 у одной означает не то же, что 78 у другой. Поэтому число и уверенность
 * остаются в базе и у аналитика, а клиенту печатается то, что позволяет
 * увидеть находку самому: имя записи в сводной таблице.
 */

import { describe, expect, it } from "vitest";
import { buildComplianceFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import { computeMatchScore } from "@/modules/digital-profile/compliance-providers/match-scoring";

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

function buildWith(evidenceIndex: Record<string, unknown>): SlideContentContract[] {
  const scoped = {
    subject: { displayName: "Умар Назарович Кремлев", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "compliance",
        region: "GLOBAL",
        metrics: [{ key: "totalCount", value: 4 }],
        claims: [],
        evidenceRefs: ["c-1"],
      },
    ],
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: null, surfaces: ["compliance"], subjectMatch: null, findingIds: null },
    evidenceIndex,
  };
  return buildComplianceFragment("COMPLIANCE" as never, scoped as never, {} as never).slides;
}

function slideOf(slides: SlideContentContract[], slideId: string): SlideContentContract {
  const found = slides.find((s) => s.slideId === slideId);
  if (!found) throw new Error(`нет слайда ${slideId}`);
  return found;
}

function paramRow(slide: SlideContentContract, key: string): string | undefined {
  return slide.content.table?.rows.find((r) => r[0] === key)?.[1];
}

/** Обе записи прогона 25.08: посторонний человек и настоящий субъект. */
const KULEBAKIN = {
  kind: "compliance_hit",
  providerLabel: "OPEN_SANCTIONS",
  matchCategory: "SANCTION_LINKED",
  matchScore: 100,
  confidence: "HIGH",
  reviewStatus: "PENDING",
  title: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
  matchedName: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
  countries: ["ru"],
  summary: "темы: связь с санкционным лицом; 2 источника в записи",
  url: "https://www.opensanctions.org/entities/ru-inn-504309044808/",
};

const SUBJECT_RECORD = {
  kind: "compliance_hit",
  providerLabel: "OPEN_SANCTIONS",
  matchCategory: "SANCTIONS",
  matchScore: 100,
  confidence: "HIGH",
  reviewStatus: "PENDING",
  title: "Умар Назарович Кремлев",
  matchedName: "Умар Назарович Кремлев",
  countries: ["ru"],
  datesOfBirth: ["1982-11-01"],
  summary: "темы: санкционные списки, публичные должностные лица (PEP)",
  url: "https://www.opensanctions.org/entities/Q55102113/",
};

describe("карточка записи комплаенса", () => {
  it("не печатает ни шкалу совпадения, ни уверенность сопоставления", () => {
    const slides = buildWith({ "h-1": KULEBAKIN });
    const card = slides.find((s) => s.continuationOf === "p33_compliance_toc");
    expect(card, "нет карточки записи OpenSanctions").toBeDefined();
    const keys = (card!.content.table?.rows ?? []).map((r) => r[0]);
    expect(keys).not.toContain("Оценка совпадения");
    expect(keys).not.toContain("Уверенность сопоставления");
    expect(JSON.stringify(card!.content)).not.toMatch(/\/100/u);
    expect(JSON.stringify(card!.content)).not.toMatch(/уверенност/iu);
  });

  it("печатает то, что о записи известно: имя, категорию, статус, страны, даты и ссылку", () => {
    const slides = buildWith({ "h-1": SUBJECT_RECORD });
    const card = slides.find((s) => s.continuationOf === "p33_compliance_toc")!;
    expect(paramRow(card, "Совпадение по имени")).toBe("Умар Назарович Кремлев");
    expect(paramRow(card, "Категория")).toBe("Санкционные списки");
    expect(paramRow(card, "Статус проверки")).toBe("Требует ручной проверки");
    expect(paramRow(card, "Страны в записи")).toBe("Россия");
    expect(paramRow(card, "Даты рождения в записи")).toBe("1982-11-01");
    expect(paramRow(card, "Карточка записи")).toBe(
      "https://www.opensanctions.org/entities/Q55102113/"
    );
  });

  it("проза страницы не называет оценку", () => {
    const slides = buildWith({ "h-1": KULEBAKIN });
    const card = slides.find((s) => s.continuationOf === "p33_compliance_toc")!;
    const found = String(card.content.whatWasFound ?? "");
    expect(found).not.toMatch(/оценк/iu);
    expect(found).not.toMatch(/\/100/u);
  });

  it("запись с единственной темой «связан с санкционным лицом» не называется санкционными списками", () => {
    const slides = buildWith({ "h-1": KULEBAKIN });
    const card = slides.find((s) => s.continuationOf === "p33_compliance_toc")!;
    expect(paramRow(card, "Категория")).toBe("Связь с санкционным лицом");
    expect(JSON.stringify(card.content)).not.toMatch(/SANCTION_LINKED/u);
  });
});

describe("сводная таблица комплаенса", () => {
  it("называет совпавшее имя своей колонкой", () => {
    const slides = buildWith({ "h-1": KULEBAKIN, "h-2": SUBJECT_RECORD });
    const summary = slideOf(slides, "p33_compliance_toc");
    expect(summary.content.table?.headers).toEqual([
      "База данных",
      "Тип совпадения",
      "Совпадение по имени",
      "Статус проверки",
    ]);
    expect(summary.content.table?.rows).toEqual([
      [
        "OpenSanctions",
        "Связь с санкционным лицом",
        "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
        "Требует ручной проверки",
      ],
      ["OpenSanctions", "Санкционные списки", "Умар Назарович Кремлев", "Требует ручной проверки"],
    ]);
  });

  it("первая фраза сводки не выдаёт вернувшиеся записи за записи о субъекте", () => {
    const slides = buildWith({ "h-1": KULEBAKIN, "h-2": SUBJECT_RECORD });
    const narrative = String(slideOf(slides, "p33_compliance_toc").content.narrative ?? "");
    expect(narrative).not.toMatch(/Записей о субъекте/u);
    expect(narrative).toMatch(/по имени субъекта/u);
    expect(narrative).toMatch(/не подтверждается автоматически/u);
    expect(narrative).toMatch(/требует ручной проверки — 2/u);
  });
});

describe("ручной импорт", () => {
  it("считает по своей шкале, но клиенту её не печатает", () => {
    // Шкала ручного импорта остаётся: она живёт в базе и в кабинете аналитика.
    const scoring = computeMatchScore({
      subjectFullName: "Умар Назарович Кремлев",
      matchedName: "Умар Назарович Кремлев",
      riskTypes: ["SANCTIONS"],
    });
    expect(scoring).toMatchObject({
      matchScore: 50,
      confidence: "MEDIUM",
      signals: ["exact_full_name", "category_severity"],
    });

    const slides = buildWith({
      "h-1": {
        kind: "compliance_hit",
        providerLabel: "LEXISNEXIS",
        matchCategory: "ADVERSE_MEDIA",
        matchScore: scoring.matchScore,
        confidence: scoring.confidence,
        reviewStatus: "PENDING",
        importMethod: "MANUAL_IMPORT",
        title: "Кремлев Умар Назарович",
        matchedName: "Кремлев Умар Назарович",
        summary: "Импорт аналитика: запись базы с негативными публикациями.",
      },
    });
    const lexis = slideOf(slides, "p35_lexis_visual");
    expect(JSON.stringify(lexis.content)).not.toMatch(/\/100/u);
    expect(JSON.stringify(lexis.content)).not.toMatch(/уверенност/iu);
    expect(paramRow(lexis, "Совпадение по имени")).toBe("Кремлев Умар Назарович");
  });
});

/**
 * Побочное следствие снятия двух строк, объявленное намеренным.
 *
 * Продолжение сводной страницы появляется только у записи, у которой есть хоть
 * одно поле сверх трёх обязательных: лист ради трёх строк читателю ничего не
 * даёт, потому что те же три факта уже стоят строкой сводной таблицы. Раньше
 * оценка и уверенность делали содержательной запись, у которой больше ничего
 * нет; теперь такая запись своей страницы не получает — и не теряет ничего,
 * кроме шкалы, которую отчёт печатать перестал.
 */
describe("запись, у которой кроме шкалы ничего не было", () => {
  const BARE = {
    kind: "compliance_hit",
    providerLabel: "WORLD_CHECK",
    matchCategory: "WATCHLIST",
    matchScore: 88,
    confidence: "HIGH",
    reviewStatus: "PENDING",
    matchedName: "Кремлев Умар",
    title: "Кремлев Умар",
  };

  it("своей страницы-карточки не получает", () => {
    const slides = buildWith({ "h-1": BARE });
    expect(slides.find((s) => s.continuationOf === "p33_compliance_toc")).toBeUndefined();
  });

  it("но все её факты остаются строкой сводной таблицы", () => {
    const summary = slideOf(buildWith({ "h-1": BARE }), "p33_compliance_toc");
    expect(summary.content.table?.rows).toEqual([
      ["World-Check", "Сторожевые списки", "Кремлев Умар", "Требует ручной проверки"],
    ]);
  });
});
