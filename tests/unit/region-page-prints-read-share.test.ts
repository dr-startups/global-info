/**
 * Страница профиля региона называет долю негатива среди прочитанных страниц.
 *
 * Эталон отрасли пишет на этом месте «29 % ссылок — негатив» и рядом — базу,
 * по которой процент посчитан. Без базы процент — число из воздуха: 83 % от
 * шести прочитанных и 83 % от шестидесяти читаются одинаково, а весят
 * по-разному. Поэтому доля и её основание печатаются одной фразой.
 *
 * Прогон, в котором страницы не читались, доли не приводит вовсе: «0 %» здесь
 * означал бы измеренный ноль негатива, то есть утверждение о фактах, которых
 * никто не проверял.
 */

import { describe, expect, it } from "vitest";
import { buildRegionalSummaryFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import type { MetricSnapshot, ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
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
    const narrative = String(ruSummarySlide(LINK_READ_BY_REGION).content.narrative);
    expect(narrative).toContain(
      "Негатив среди прочитанных страниц региона: 5 из 15 (33%); прочитано 17 из 20 отобранных. Страницы о других людях (2) в долю не входят."
    );
  });

  it("не берёт числа соседнего региона", () => {
    const narrative = String(ruSummarySlide(LINK_READ_BY_REGION).content.narrative);
    expect(narrative).not.toContain("из 19");
    expect(narrative).not.toContain("прочитано 20 из 25");
    expect(narrative).not.toContain("(5%)");
  });

  it("без чужих страниц хвост о них не печатается", () => {
    const narrative = String(
      ruSummarySlide({ RU: { requested: 18, read: 15, readOther: 0, adverseRead: 5 } }).content
        .narrative
    );
    expect(narrative).toContain(
      "Негатив среди прочитанных страниц региона: 5 из 15 (33%); прочитано 15 из 18 отобранных."
    );
    expect(narrative).not.toContain("другом");
    expect(narrative).not.toContain("других людях");
  });

  it("измеренный ноль негатива печатается нулём", () => {
    const narrative = String(
      ruSummarySlide({ RU: { requested: 15, read: 15, readOther: 0, adverseRead: 0 } }).content
        .narrative
    );
    expect(narrative).toContain(
      "Негатив среди прочитанных страниц региона: 0 из 15 (0%); прочитано 15 из 15 отобранных."
    );
  });

  it("машинные поля слайда повторяют числитель и знаменатель", () => {
    const slide = ruSummarySlide(LINK_READ_BY_REGION);
    expect(slide.metrics.linkRead).toBe(15);
    expect(slide.metrics.linkAdverse).toBe(5);
  });

  it("один вход даёт один и тот же слайд", () => {
    const first = JSON.stringify(ruSummarySlide(LINK_READ_BY_REGION));
    const second = JSON.stringify(ruSummarySlide(LINK_READ_BY_REGION));
    expect(first).toBe(second);
  });
});

describe("прогон без чтения страниц доли не приводит", () => {
  it("страницы не читались — сказано словами, без процента", () => {
    const narrative = String(ruSummarySlide(undefined).content.narrative);
    expect(narrative).toContain(
      "Доля негатива среди прочитанных страниц не приводится: страницы выдачи в этом прогоне не читались."
    );
    expect(narrative).not.toContain("%");
  });

  it("пустая корзина региона — та же фраза", () => {
    const narrative = String(
      ruSummarySlide({ UAE: { requested: 5, read: 5, readOther: 0, adverseRead: 1 } }).content
        .narrative
    );
    expect(narrative).toContain("страницы выдачи в этом прогоне не читались.");
    expect(narrative).not.toContain("%");
  });

  it("страницы отбирали, но ни одной не прочитали — названа неудача чтения", () => {
    const narrative = String(
      ruSummarySlide({ RU: { requested: 12, read: 0, readOther: 0, adverseRead: 0 } }).content
        .narrative
    );
    expect(narrative).toContain(
      "Прочитать страницы выдачи региона не удалось (запрошено 12, прочитано 0) — доля негатива не приводится."
    );
    expect(narrative).not.toContain("%");
  });

  it("всё прочитанное оказалось о других лицах — доля не приводится", () => {
    const narrative = String(
      ruSummarySlide({ RU: { requested: 9, read: 6, readOther: 6, adverseRead: 0 } }).content
        .narrative
    );
    expect(narrative).toContain(
      "Все прочитанные страницы региона (6) отнесены к другим лицам; доля негатива о проверяемом лице не приводится."
    );
    expect(narrative).not.toContain("%");
  });
});

describe("прежние предложения нарратива остаются на месте", () => {
  it("в ветке с подтверждёнными темами четвёртое предложение ничего не вытесняет", () => {
    const narrative = String(ruSummarySlide(LINK_READ_BY_REGION).content.narrative);
    expect(narrative).toContain("Предмет аудита по региону «Россия» — ТОП-20 выдачи: 20");
    expect(narrative).toContain("Подтверждённых тем: 1, все — повышенного внимания.");
    expect(narrative).toContain("Ключевые темы для проверки: Криминальные / судебные материалы.");
    expect(narrative).toContain("Негатив среди прочитанных страниц региона:");
  });

  it("в ветке материалов без подтверждённых тем доля печатается тоже", () => {
    const slide = ruSummarySlide(LINK_READ_BY_REGION, { withFindings: false });
    const narrative = String(slide.content.narrative);
    expect(narrative).toContain("По региону Россия собрано и проанализировано материалов: 60.");
    expect(narrative).toContain(
      "Подтверждённых тем повышенного внимания, однозначно связанных с проверяемым лицом, по итогам идентификации не выявлено."
    );
    expect(narrative).toContain(
      "Негатив среди прочитанных страниц региона: 5 из 15 (33%); прочитано 17 из 20 отобранных."
    );
  });
});
