/**
 * Страница профиля региона называет долю негатива среди прочитанных страниц.
 *
 * Эталон отрасли пишет на этом месте «29 % ссылок — негатив» и рядом — базу,
 * по которой процент посчитан. Без базы процент — число из воздуха: 83 % от
 * шести прочитанных и 83 % от шестидесяти читаются одинаково, а весят
 * по-разному. Поэтому доля и её основание печатаются одной фразой.
 *
 * Фраза живёт в `content.statusNote`, а не в нарративе: нарратив переписывает
 * стадия 2 (на прогоне 76 она выбросила и процент, и базу) и подгоняет по
 * высоте рендерер, отбрасывая предложения с конца. statusNote не уходит модели
 * и печатается своей строкой.
 *
 * Прогон, в котором страницы не читались, доли не приводит вовсе: «0 %» здесь
 * означал бы измеренный ноль негатива, то есть утверждение о фактах, которых
 * никто не проверял.
 */

import { describe, expect, it } from "vitest";
import { buildRegionalSummaryFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import { withContinuations } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { MetricSnapshot, ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

const FINDING = {
  findingId: "finding-criminal_legal-subject_match-a1",
  theme: "Криминальные / судебные материалы",
  claim: "В выдаче видны судебные сюжеты.\nВсего по теме: 2 материала.",
  subjectMatch: "SUBJECT_MATCH",
  riskLevel: "high",
  confidence: 0.9,
  regions: ["RU"],
  sourceDomains: ["news.example"],
  evidenceRefs: ["ev-1"],
  recommendedAction: "Проверить актуальные статусы дел.",
  promotionPriority: "P1",
} as unknown as Finding;

/** Доли двух регионов различаются во всех четырёх числах — смешение видно сразу. */
const LINK_READ_BY_REGION: MetricSnapshot["linkReadByRegion"] = {
  RU: { requested: 20, read: 17, readOther: 2, adverseRead: 5 },
  UAE: { requested: 25, read: 20, readOther: 1, adverseRead: 1 },
};

function scopedFor(
  linkReadByRegion: MetricSnapshot["linkReadByRegion"],
  opts: { withFindings?: boolean } = {}
): ScopedFragmentInput {
  const withFindings = opts.withFindings ?? true;
  return {
    subject: { displayName: "Тестов", aliases: [] },
    findings: withFindings ? [FINDING] : [],
    surfaceUnits: [],
    metricSnapshot: {
      metricSnapshotId: "m",
      datasetId: "d",
      reportRunId: "r",
      baseCount: 100,
      enrichmentCount: 0,
      compositeCount: 100,
      analysisTopN: 20,
      analysisLanes: [{ engine: "YANDEX", region: "RU", analyzed: 20 }],
      subjectMatchCount: 40,
      likelySubjectCount: 3,
      ambiguousCount: 5,
      otherSubjectCount: 2,
      adverseFindingCount: 1,
      perRegionCounts: { RU: 60, UAE: 40 },
      perRegionLikelyCounts: { RU: 2, UAE: 1 },
      linkReadByRegion,
    },
    scope: { regions: ["RU"], surfaces: [], subjectMatch: null, findingIds: null },
    evidenceIndex: { "ev-1": { domain: "news.example", region: "RU", title: "Суд" } },
  } as unknown as ScopedFragmentInput;
}

function ruSummarySlide(
  linkReadByRegion: MetricSnapshot["linkReadByRegion"],
  opts: { withFindings?: boolean } = {}
) {
  const out = buildRegionalSummaryFragment(
    "RU_SUMMARY" as never,
    "RU" as never,
    "Россия",
    scopedFor(linkReadByRegion, opts),
    {}
  );
  return out.slides.find((s) => s.templateId === "regional-summary")!;
}

describe("доля негатива на странице региона", () => {
  it("печатается своими числами и с базой в той же фразе", () => {
    expect(ruSummarySlide(LINK_READ_BY_REGION).content.statusNote).toBe(
      "Негатив среди прочитанных страниц региона: 5 из 15 (33%); прочитано 17 из 20 отобранных. Страницы о других людях (2) в долю не входят."
    );
  });

  it("не берёт числа соседнего региона", () => {
    const note = String(ruSummarySlide(LINK_READ_BY_REGION).content.statusNote);
    expect(note).not.toContain("из 19");
    expect(note).not.toContain("прочитано 20 из 25");
    expect(note).not.toContain("(5%)");
  });

  it("без чужих страниц хвост о них не печатается", () => {
    const note = String(
      ruSummarySlide({ RU: { requested: 18, read: 15, readOther: 0, adverseRead: 5 } }).content
        .statusNote
    );
    expect(note).toBe(
      "Негатив среди прочитанных страниц региона: 5 из 15 (33%); прочитано 15 из 18 отобранных."
    );
    expect(note).not.toContain("других людях");
  });

  it("измеренный ноль негатива печатается нулём", () => {
    expect(
      ruSummarySlide({ RU: { requested: 15, read: 15, readOther: 0, adverseRead: 0 } }).content
        .statusNote
    ).toBe("Негатив среди прочитанных страниц региона: 0 из 15 (0%); прочитано 15 из 15 отобранных.");
  });

  it("машинные поля слайда повторяют числитель, знаменатель и базу", () => {
    const slide = ruSummarySlide(LINK_READ_BY_REGION);
    expect(slide.metrics.linkRead).toBe(15);
    expect(slide.metrics.linkAdverse).toBe(5);
    expect(slide.metrics.linkRequested).toBe(20);
  });

  it("один вход даёт один и тот же слайд", () => {
    const first = JSON.stringify(ruSummarySlide(LINK_READ_BY_REGION));
    const second = JSON.stringify(ruSummarySlide(LINK_READ_BY_REGION));
    expect(first).toBe(second);
  });
});

describe("прогон без чтения страниц доли не приводит", () => {
  it("страницы не читались — сказано словами, без процента", () => {
    const note = String(ruSummarySlide(undefined).content.statusNote);
    expect(note).toBe(
      "Доля негатива среди прочитанных страниц не приводится: страницы выдачи в этом прогоне не читались."
    );
    expect(note).not.toContain("%");
  });

  it("пустая корзина региона — та же фраза", () => {
    const note = String(
      ruSummarySlide({ UAE: { requested: 5, read: 5, readOther: 0, adverseRead: 1 } }).content
        .statusNote
    );
    expect(note).toContain("страницы выдачи в этом прогоне не читались.");
    expect(note).not.toContain("%");
  });

  it("страницы отбирали, но ни одной не прочитали — названа неудача чтения", () => {
    const note = String(
      ruSummarySlide({ RU: { requested: 12, read: 0, readOther: 0, adverseRead: 0 } }).content
        .statusNote
    );
    expect(note).toBe(
      "Прочитать страницы выдачи региона не удалось (запрошено 12, прочитано 0) — доля негатива не приводится."
    );
    expect(note).not.toContain("%");
  });

  it("всё прочитанное оказалось о других лицах — доля не приводится", () => {
    const note = String(
      ruSummarySlide({ RU: { requested: 9, read: 6, readOther: 6, adverseRead: 0 } }).content
        .statusNote
    );
    expect(note).toBe(
      "Все прочитанные страницы региона (6) отнесены к другим лицам; доля негатива о проверяемом лице не приводится."
    );
    expect(note).not.toContain("%");
  });
});

describe("нарратив региона о чтении не говорит", () => {
  it("в ветке с подтверждёнными темами остались прежние предложения, но не доля", () => {
    const narrative = String(ruSummarySlide(LINK_READ_BY_REGION).content.narrative);
    expect(narrative).toContain("Предмет аудита по региону «Россия» — ТОП-20 выдачи: 20");
    expect(narrative).toContain("Подтверждённых тем: 1, все — повышенного внимания.");
    expect(narrative).toContain("Ключевые темы для проверки: Криминальные / судебные материалы.");
    expect(narrative).not.toMatch(/прочитан/iu);
  });

  it("в ветке материалов без подтверждённых тем доля тоже ушла в statusNote", () => {
    const slide = ruSummarySlide(LINK_READ_BY_REGION, { withFindings: false });
    const narrative = String(slide.content.narrative);
    expect(narrative).toContain("По региону Россия собрано и проанализировано материалов: 60.");
    expect(narrative).toContain(
      "Подтверждённых тем повышенного внимания, однозначно связанных с проверяемым лицом, по итогам идентификации не выявлено."
    );
    expect(narrative).not.toMatch(/прочитан/iu);
    expect(slide.content.statusNote).toBe(
      "Негатив среди прочитанных страниц региона: 5 из 15 (33%); прочитано 17 из 20 отобранных. Страницы о других людях (2) в долю не входят."
    );
  });
});

describe("продолжения блока доли не повторяют", () => {
  function baseSlide(bullets: string[]): SlideContentContract {
    return {
      schemaVersion: "slide-content-v1",
      slideId: "p07_ru_summary",
      baseSlotId: "p07_ru_summary",
      sectionId: "RU_PROFILE",
      isContinuation: false,
      continuationOf: null,
      continuationIndex: null,
      templateId: "regional-summary",
      title: "Россия: в выдаче есть материалы повышенного внимания",
      content: {
        narrative: "Предмет аудита по региону «Россия» — ТОП-20 выдачи: 20 материалов.",
        statusNote:
          "Негатив среди прочитанных страниц региона: 5 из 15 (33%); прочитано 17 из 20 отобранных.",
        bullets,
        kpis: [{ label: "Собрано по региону", value: "60", tone: "neutral" }],
        whatToCheck: "Проверить актуальные статусы дел.",
      },
      evidenceRefs: [],
      findingIds: [],
      metrics: {},
      visualAssetRefs: [],
    } as unknown as SlideContentContract;
  }

  it("заголовочные числа блока принадлежат его первой странице", () => {
    const bullets = Array.from(
      { length: 8 },
      (_, i) =>
        `Тема ${i + 1}. Найдены публикации о судебных разбирательствах и корпоративных конфликтах, ` +
        "которые проверяющий увидит в выдаче по имени субъекта. Всего по теме: 3 материала."
    );
    const slides = withContinuations(baseSlide(bullets), "regional-summary");
    expect(slides.length).toBeGreaterThan(1);
    expect(slides[0]!.content.statusNote).toContain("Негатив среди прочитанных страниц региона:");
    for (const cont of slides.slice(1)) {
      expect(cont.isContinuation).toBe(true);
      expect(cont.content.statusNote).toBeUndefined();
    }
  });
});
