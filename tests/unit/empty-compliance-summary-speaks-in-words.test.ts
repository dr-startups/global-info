/**
 * Пустая сводка комплаенса говорит словами, а не пустой таблицей.
 *
 * При нуле совпадений построитель всё равно объявлял сводный лист таблицей с
 * `rows: []`, и рендерер уходил в запасную ветку `if not rows and bullets`:
 * перетирал заголовки комплаенса заголовками таблицы поиска и печатал
 * `["—", "—", <обрезанное по 80 слов примечание>, "·"]`. Клиент видел шапку
 * «Поз. / Домен / Заголовок / Риск» над строкой прочерков — выдуманную
 * таблицу поиска на странице комплаенса.
 *
 * Решение уже принято однажды, на соседнем листе: страница базы при нуле
 * записей печатала таблицу «Параметр / Значение», где значениями была проза,
 * и с шага 13 (C13) уходит на `coverage-empty-state` без таблицы. Сводный лист
 * той правки не получил.
 *
 * Эту ветку не исполняет ни один эталон — в `report-72` три совпадения, в
 * золотом кейсе два, — поэтому юнит здесь единственный сторож.
 *
 * Отчёт читает **сам субъект**: клиент, который оценивает свой цифровой профиль.
 * Поэтому лист говорит, что отсутствие совпадений значит для читателя и чего не
 * значит, и не поручает ему нашу работу — «подключить доступ по договору» он
 * выполнить не может.
 */

import { describe, expect, it } from "vitest";
import { buildComplianceFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { DeckTemplateId } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import { listComplianceProviderStatus } from "@/modules/digital-profile/compliance-providers/config";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const METRIC_SNAPSHOT = {
  metricSnapshotId: "m-1",
  datasetId: "d-1",
  reportRunId: "r-1",
  baseCount: 40,
  enrichmentCount: 0,
  compositeCount: 40,
  subjectMatchCount: 5,
  likelySubjectCount: 0,
  ambiguousCount: 0,
  otherSubjectCount: 0,
  adverseFindingCount: 0,
  perRegionCounts: { RU: 40 },
};

function buildSlides(input: {
  extras?: Partial<FragmentExtras>;
  evidenceIndex?: Record<string, unknown>;
}): SlideContentContract[] {
  const scoped = {
    subject: { displayName: "Сергей Глинка", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "compliance",
        region: "GLOBAL",
        metrics: [{ key: "totalCount", value: 0 }],
        claims: [],
        evidenceRefs: [],
      },
    ],
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: null, surfaces: ["compliance"], subjectMatch: null, findingIds: null },
    evidenceIndex: input.evidenceIndex ?? {},
  };
  return buildComplianceFragment(
    "COMPLIANCE" as never,
    scoped as never,
    (input.extras ?? {}) as never
  ).slides;
}

function slideOf(slides: SlideContentContract[], slideId: string): SlideContentContract {
  const found = slides.find((s) => s.slideId === slideId);
  if (!found) throw new Error(`нет слайда ${slideId}`);
  return found;
}

const summaryOf = (slides: SlideContentContract[]): SlideContentContract =>
  slideOf(slides, "p33_compliance_toc");

/** Два рана: одна база проверена и чиста, вторая не проверена вовсе. */
const MIXED_SCREENINGS: Partial<FragmentExtras> = {
  complianceScreenings: [
    {
      provider: "DOW_JONES",
      status: "NOT_CONFIGURED",
      hitCount: 0,
      finishedAt: "2026-05-12T09:30:00.000Z",
      errorCode: "PROVIDER_NOT_CONFIGURED",
    },
    {
      provider: "LEXISNEXIS",
      status: "SUCCESS",
      hitCount: 0,
      finishedAt: "2026-05-12T09:35:00.000Z",
    },
  ],
};

/** Все базы, по которым был ран, проверены и записей о субъекте не нашли. */
const ALL_CLEAN_SCREENINGS: Partial<FragmentExtras> = {
  complianceScreenings: [
    {
      provider: "OPEN_SANCTIONS",
      status: "SUCCESS",
      hitCount: 0,
      finishedAt: "2026-05-12T09:35:00.000Z",
    },
    {
      provider: "DOW_JONES",
      status: "SUCCESS",
      hitCount: 0,
      finishedAt: "2026-05-12T09:30:00.000Z",
    },
  ],
};

/**
 * Весь текст листа, который увидит читатель, — одной строкой.
 *
 * Вместе с футнотом: подпись источника принадлежит слайду, методологическая
 * сноска — шаблону, но на странице их печатает одна строка внизу, и читает её
 * тот же человек. Проверка регистра, смотрящая мимо футнота, обещала бы
 * больше, чем делает.
 */
function clientTextOf(slide: SlideContentContract): string {
  const c = slide.content;
  const methodology =
    DECK_TEMPLATE_REGISTRY[slide.templateId as DeckTemplateId].methodologyNote ?? "";
  return [
    c.narrative,
    ...(c.bullets ?? []),
    c.whatWasFound,
    c.whyItMatters,
    c.whatToCheck,
    c.sourceNote,
    methodology,
  ]
    .filter(Boolean)
    .join(" ");
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((x) => x.trim())
    .filter(Boolean);
}

const HIT = (provider: string, name: string) => ({
  kind: "compliance_hit",
  providerLabel: provider,
  matchCategory: "PEP",
  matchScore: 78,
  reviewStatus: "PENDING",
  title: name,
});

describe("сводный лист комплаенса при нуле совпадений", () => {
  it("не объявляет таблицу вовсе", () => {
    const summary = summaryOf(buildSlides({ extras: MIXED_SCREENINGS }));
    expect(summary.templateId).toBe("coverage-empty-state");
    expect(summary.content.table).toBeUndefined();
    expect(String(summary.content.narrative ?? "")).toMatch(/не зафиксировано/u);
    expect(String(summary.emptyStateReason ?? "").length).toBeGreaterThan(0);
  });

  it("называет проверенные базы и исход каждой", () => {
    const bullets = summaryOf(buildSlides({ extras: MIXED_SCREENINGS })).content.bullets ?? [];
    const dow = bullets.find((b) => b.startsWith("Dow Jones"));
    const lexis = bullets.find((b) => b.startsWith("LexisNexis"));
    expect(dow, bullets.join(" | ")).toBeDefined();
    expect(lexis, bullets.join(" | ")).toBeDefined();
    // База, по которой проверки не было, и база, где проверка прошла и ничего
    // не нашла, различаются словами: смешать их — значит сказать клиенту, что
    // его профиль чист, когда он не проверен.
    expect(dow!).toMatch(/не выполнена: доступ к базе не настроен/u);
    expect(dow!).not.toMatch(/совпадений по субъекту не найдено/u);
    expect(lexis!).toMatch(/выполнена 12\.05\.2026: совпадений по субъекту не найдено/u);
  });

  /**
   * Читатель отчёта — сам субъект. Ни «верифицировать совпадение» (работы нет
   * вовсе), ни «подключить доступ по договору» (работа наша) он выполнить не
   * может: на месте рекомендации стоит то, что отсутствие совпадений значит и
   * чего не значит.
   */
  it("не поручает читателю нашу работу ни в одном поле листа", () => {
    for (const extras of [MIXED_SCREENINGS, ALL_CLEAN_SCREENINGS, {}]) {
      const summary = summaryOf(buildSlides({ extras }));
      const printed = clientTextOf(summary);
      expect(printed, JSON.stringify(extras)).not.toMatch(/[Вв]ерифицировать/u);
      expect(printed).not.toMatch(/[Пп]одключить (официальный )?доступ/u);
      expect(printed).not.toMatch(/[Вв]ыполнить проверку/u);
      expect(printed).not.toMatch(/[Пп]овторить сверку/u);
      expect(printed).not.toMatch(/импортировать запис/u);
      expect(printed).not.toMatch(/по договору/u);
      // И при этом лист говорит, чего пустота не значит.
      expect(printed).toMatch(/результатом проверки не является|не вывод об отсутствии рисков/u);
    }
  });

  /**
   * Оговорка «отсутствие совпадений результатом проверки не является» — один
   * ответ на один вопрос: на коротком листе она стояла в обеих карточках из
   * двух.
   */
  it("оговорку о смысле пустоты печатает один раз", () => {
    for (const extras of [MIXED_SCREENINGS, ALL_CLEAN_SCREENINGS, {}]) {
      const printed = clientTextOf(summaryOf(buildSlides({ extras })));
      const said = printed.match(/результатом проверки не является/gu) ?? [];
      expect(said.length, printed).toBeLessThanOrEqual(1);
    }
  });

  it("без единого рана говорит, что проверок не было, и баз не выдумывает", () => {
    const summary = summaryOf(buildSlides({}));
    expect(summary.content.table).toBeUndefined();
    expect(summary.content.bullets ?? []).toHaveLength(0);
    const narrative = String(summary.content.narrative ?? "");
    // Первым читается состояние проверки, а не форма результата: «совпадений
    // не зафиксировано» на странице, где не проверяли, читается как вывод.
    const first = sentences(narrative)[0] ?? "";
    expect(first, narrative).toMatch(/не проверял|проверок[^.]*нет/iu);
    expect(first, narrative).not.toMatch(/совпадений/iu);
    expect(narrative).toMatch(/результатом проверки не является/u);
    expect(summary.emptyStateReason).toBe("compliance-check-not-performed");
  });

  /**
   * Третье состояние листа: все базы, по которым был ран, проверены и чисты.
   * Оно продуктово отличается от «не проверяли» — и признаком в данных
   * (`emptyStateReason` уходит в разбор качества отчёта), и словами.
   */
  it("все базы проверены и чисты — лист говорит именно это", () => {
    const summary = summaryOf(buildSlides({ extras: ALL_CLEAN_SCREENINGS }));
    expect(summary.emptyStateReason).toBe("no-compliance-records");
    const narrative = String(summary.content.narrative ?? "");
    expect(narrative).toMatch(/результат на дату проверки/u);
    expect(narrative).not.toMatch(/не состоял|не выполнял/u);
    const bullets = summary.content.bullets ?? [];
    expect(bullets).toHaveLength(2);
    expect(bullets.every((b) => /совпадений по субъекту не найдено/u.test(b)), bullets.join(" | ")).toBe(
      true
    );
  });

  /**
   * Слова исхода живут в одном месте: подмена формулировки обязана краснить и
   * страницу базы, и сводный лист. Вторая формулировка того же исхода означала
   * бы, что одна и та же проверка на двух страницах отчёта названа по-разному.
   */
  it("исход базы назван на обеих страницах одними словами", () => {
    const slides = buildSlides({ extras: MIXED_SCREENINGS });
    const summaryBullets = summaryOf(slides).content.bullets ?? [];
    const dowPage = String(slideOf(slides, "p34_dow_jones").content.narrative ?? "");
    const lexisPage = String(slideOf(slides, "p35_lexis_visual").content.narrative ?? "");

    const notPerformed = "не выполнена: доступ к базе не настроен";
    const performedClean = "выполнена 12.05.2026: совпадений по субъекту не найдено";
    expect(dowPage).toContain(notPerformed);
    expect(summaryBullets.some((b) => b.includes(notPerformed))).toBe(true);
    expect(lexisPage).toContain(performedClean);
    expect(summaryBullets.some((b) => b.includes(performedClean))).toBe(true);
  });

  /**
   * Ёмкость карточки «Что это означает» — четыре строки, и столько же баз, по
   * которым бывает ран. Строка сверх ёмкости исчезла бы у рендерера молча
   * (`"\n".join(bullets[:4])`), причём на странице комплаенса, где неполный
   * перечень баз читается как «о базе умолчали».
   *
   * Число баз берётся из перечня провайдеров, а не переписывается сюда: иначе
   * проверка сравнивает четыре с четырьмя и молчит ровно тогда, когда баз
   * стало пять. Ран создаётся для всякого провайдера, кроме ручного импорта
   * (`runComplianceScreening` выходит на нём раньше), и это признак `kind`.
   */
  it("баз, по которым бывает ран, не больше, чем строк на листе", () => {
    const screened = listComplianceProviderStatus().filter((p) => p.kind === "REAL");
    expect(screened.length).toBeLessThanOrEqual(
      DECK_TEMPLATE_REGISTRY["coverage-empty-state"].maxBulletsPerSlide
    );
  });

  it("перечень баз укладывается в ёмкость листа", () => {
    const summary = summaryOf(
      buildSlides({
        extras: {
          complianceScreenings: [
            { provider: "DOW_JONES", status: "SUCCESS", hitCount: 0, finishedAt: null },
            { provider: "LEXISNEXIS", status: "NOT_CONFIGURED", hitCount: 0, finishedAt: null },
            { provider: "OPEN_SANCTIONS", status: "SUCCESS", hitCount: 0, finishedAt: null },
            { provider: "WORLD_CHECK", status: "DISABLED", hitCount: 0, finishedAt: null },
          ],
        },
      })
    );
    const bullets = summary.content.bullets ?? [];
    expect(bullets).toHaveLength(4);
    expect(bullets.length).toBeLessThanOrEqual(
      DECK_TEMPLATE_REGISTRY["coverage-empty-state"].maxBulletsPerSlide
    );
  });
});

describe("сводный лист комплаенса при непустом наборе", () => {
  it("строит таблицу со своими заголовками, как прежде", () => {
    const summary = summaryOf(
      buildSlides({
        extras: MIXED_SCREENINGS,
        evidenceIndex: {
          "h-1": HIT("DOW_JONES", "Глинка Сергей Михайлович"),
          "h-2": HIT("LEXISNEXIS", "Глинка Сергей Иванович"),
        },
      })
    );
    expect(summary.templateId).toBe("serp-table");
    expect(summary.content.table?.headers).toEqual([
      "База данных",
      "Тип совпадения",
      "Совпадение по имени",
      "Статус проверки",
    ]);
    expect(summary.content.table?.rows).toHaveLength(2);
    expect(String(summary.content.whatToCheck ?? "")).toMatch(/Верифицировать/u);
  });
});
