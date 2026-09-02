/**
 * Главный пин честности чтения — на числах живого прогона 76.
 *
 * Прогон запросил 120 страниц, прочитал 74, получил 46 отказов — и ни на одной
 * странице отчёта об этом не было сказано. Оба носителя честности уничтожены
 * разными механизмами: строку покрытия срезал двухпредложный лимит шаблона
 * таблицы, а базу «прочитано 50 из 86 отобранных» на российской странице
 * региона съела переписка GPT-стадии 2. На странице ОАЭ база уцелела только
 * потому, что ту переписку отклонил гард чужих доменов.
 *
 * Поэтому проверяется весь набор страниц одного снимка сразу: утверждение
 * «прочитаны» без базы «(N из M)» не должно встречаться нигде, а региональная доля
 * обязана лежать в поле, которого модель не видит, — `content.statusNote`.
 */

import { describe, expect, it } from "vitest";
import { buildSerpFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import { buildRegionalSummaryFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/regional-summary";
import type {
  MetricSnapshot,
  ScopedFragmentInput,
} from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
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
  evidenceRefs: ["inventory:ru-1"],
  recommendedAction: "Проверить актуальные статусы дел.",
  promotionPriority: "P1",
} as unknown as Finding;

/** Снимок метрик прогона 76: глобальное чтение и обе региональные корзины. */
const SNAPSHOT = {
  metricSnapshotId: "m",
  datasetId: "d",
  reportRunId: "r",
  baseCount: 527,
  enrichmentCount: 0,
  compositeCount: 527,
  analysisTopN: 20,
  analysisLanes: [
    { engine: "YANDEX", region: "RU", analyzed: 20 },
    { engine: "GOOGLE", region: "UAE", analyzed: 20 },
  ],
  subjectMatchCount: 360,
  likelySubjectCount: 12,
  ambiguousCount: 40,
  otherSubjectCount: 15,
  adverseFindingCount: 9,
  perRegionCounts: { RU: 404, UAE: 123 },
  perRegionLikelyCounts: { RU: 8, UAE: 4 },
  linkReading: {
    status: "PARTIAL",
    requested: 120,
    read: 74,
    failed: 46,
    retried: 3,
    byReason: { blocked: 23, empty_text: 17, not_fetched: 6 },
  },
  linkUnreadCount: 46,
  linkReadByRegion: {
    RU: { requested: 86, read: 50, readOther: 0, adverseRead: 15 },
    UAE: { requested: 34, read: 24, readOther: 0, adverseRead: 12 },
  },
  linkThemesByRegion: {
    RU: [
      { theme: "Криминальные / судебные материалы", count: 20, adverseCount: 10 },
      { theme: "Деловая репутация", count: 12, adverseCount: 5 },
    ],
    UAE: [{ theme: "Деловая репутация", count: 14, adverseCount: 12 }],
  },
} as unknown as MetricSnapshot;

function scopedFor(region: "RU" | "UAE"): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  for (let n = 1; n <= 3; n += 1) {
    const ref = `inventory:${region.toLowerCase()}-${n}`;
    evidenceIndex[ref] = {
      title: `Материал ${n}`,
      url: `https://news.example/material-${n}`,
      domain: "news.example",
      engine: region === "RU" ? "YANDEX" : "GOOGLE",
      region,
      rank: n,
      query: "тестов иван",
      queryPurpose: "subject_lookup",
    };
    refs.push(ref);
  }
  return {
    subject: { displayName: "Тестов", aliases: [] },
    findings: region === "RU" ? [FINDING] : [],
    surfaceUnits: [
      {
        surface: "organic",
        region,
        engine: region === "RU" ? "YANDEX" : "GOOGLE",
        claims: [],
        metrics: [],
        evidenceRefs: refs,
      },
    ],
    evidenceIndex,
    scope: { regions: [region], surfaces: [], subjectMatch: null, findingIds: null },
    metricSnapshot: SNAPSHOT,
  } as unknown as ScopedFragmentInput;
}

function allSlides(): SlideContentContract[] {
  return [
    ...buildSerpFragment("RU_SERP" as never, "RU_PROFILE" as never, "Россия", scopedFor("RU")).slides,
    ...buildSerpFragment("UAE_SERP" as never, "UAE_PROFILE" as never, "ОАЭ", scopedFor("UAE")).slides,
    ...buildRegionalSummaryFragment("RU_SUMMARY" as never, "RU_PROFILE" as never, "Россия", scopedFor("RU")).slides,
    ...buildRegionalSummaryFragment("UAE_SUMMARY" as never, "UAE_PROFILE" as never, "ОАЭ", scopedFor("UAE")).slides,
  ];
}

/** Всё, что клиент прочтёт глазами, — одним списком строк. */
function clientTexts(slide: SlideContentContract): string[] {
  const c = slide.content;
  return [
    slide.title,
    slide.subtitle,
    c.narrative,
    c.statusNote,
    c.whatWasFound,
    c.whyItMatters,
    c.whatToCheck,
    c.sourceNote,
    ...(c.bullets ?? []),
    ...(c.table?.rows ?? []).flat(),
  ].filter((t): t is string => Boolean(t));
}

function summarySlide(region: "RU" | "UAE"): SlideContentContract {
  const out = buildRegionalSummaryFragment(
    region === "RU" ? ("RU_SUMMARY" as never) : ("UAE_SUMMARY" as never),
    region === "RU" ? ("RU_PROFILE" as never) : ("UAE_PROFILE" as never),
    region === "RU" ? "Россия" : "ОАЭ",
    scopedFor(region)
  );
  return out.slides.find((s) => s.templateId === "regional-summary")!;
}

describe("отчёт не утверждает того, чего не читал", () => {
  it("ни одно клиентское поле не говорит «прочитаны» без базы", () => {
    // Абсолют разрешён только вместе с «(N из M)»: на прогоне 76 фраза
    // «Публикации из ТОП-20 прочитаны» несла число «20» из названия глубины
    // выдачи и выглядела подкреплённой, ничего при этом не подкрепляя.
    for (const slide of allSlides()) {
      for (const text of clientTexts(slide)) {
        for (const sentence of text.split(/(?<=[.!?…])\s+/u)) {
          if (!/прочитаны/u.test(sentence)) continue;
          expect(sentence, `${slide.slideId}: абсолют без базы — ${sentence}`).toMatch(
            /\(\d+ из \d+\)/u
          );
        }
      }
    }
  });

  it("страница тем несёт базу и прочитанное машинными полями", () => {
    const themes = buildSerpFragment(
      "RU_SERP" as never,
      "RU_PROFILE" as never,
      "Россия",
      scopedFor("RU")
    ).slides.find((s) => s.slideId.endsWith("__themes"))!;
    expect(themes.metrics.requested).toBe(120);
    expect(themes.metrics.read).toBe(74);
  });
});

describe("доля негатива региона живёт в непереписываемом поле", () => {
  it("российская страница называет процент и базу в statusNote", () => {
    expect(summarySlide("RU").content.statusNote).toBe(
      "Негатив среди прочитанных страниц региона: 15 из 50 (30%); прочитано 50 из 86 отобранных."
    );
  });

  it("страница ОАЭ называет свои числа, а не соседние", () => {
    expect(summarySlide("UAE").content.statusNote).toBe(
      "Негатив среди прочитанных страниц региона: 12 из 24 (50%); прочитано 24 из 34 отобранных."
    );
  });

  it("нарратив региона о чтении не говорит вовсе — второму ответу неоткуда взяться", () => {
    for (const region of ["RU", "UAE"] as const) {
      const narrative = String(summarySlide(region).content.narrative ?? "");
      expect(narrative).not.toMatch(/прочитан/iu);
      expect(narrative).not.toContain("отобранных");
    }
  });

  it("база чтения существует машинным полем, а не только словом во фразе", () => {
    expect(summarySlide("RU").metrics.linkRequested).toBe(86);
    expect(summarySlide("UAE").metrics.linkRequested).toBe(34);
  });
});
