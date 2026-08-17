/**
 * Резюме повторяет долю негатива одной строкой — и она доезжает до клиента.
 *
 * Карточка резюме собирается тремя разными путями (детерминированный fallback,
 * семантическая раскладка по составленному резюме, подмена нарратива на стадии
 * GPT), и строка обязана выжить во всех: число, которое видно только в одном
 * пути, читатель считает случайным. Доставка — тот же пост-проход, который уже
 * удерживает строку §7.2, поэтому строка доли не клампится никогда: обрезанное
 * число — это ложь, а не сокращение.
 *
 * Регион, в котором читать было нечего, в строке не упоминается: честное
 * отсутствие уже сказано на его собственной странице.
 */

import { describe, expect, it } from "vitest";
import {
  applyExecutiveFreshnessChangeToPacks,
  buildExecutiveSummaryFragment,
  buildExecutiveSummaryFromComposed,
  fragmentScope,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import { sampleComposedClientSummary } from "@/modules/digital-profile/orion-golden/contracts/sample-contracts";
import type { MetricSnapshot, ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const SHARE_LINE =
  "Негатив среди прочитанных страниц: Россия — 33% (5 из 15), ОАЭ — 5% (1 из 19).";

const BOTH_REGIONS: MetricSnapshot["linkReadByRegion"] = {
  RU: { requested: 20, read: 17, readOther: 2, adverseRead: 5 },
  UAE: { requested: 25, read: 20, readOther: 1, adverseRead: 1 },
};

function metricSnapshot(linkReadByRegion: MetricSnapshot["linkReadByRegion"]): MetricSnapshot {
  return {
    metricSnapshotId: "m",
    datasetId: "d",
    reportRunId: "r",
    baseCount: 100,
    enrichmentCount: 0,
    compositeCount: 100,
    subjectMatchCount: 40,
    likelySubjectCount: 3,
    ambiguousCount: 5,
    otherSubjectCount: 2,
    adverseFindingCount: 1,
    perRegionCounts: { RU: 60, UAE: 40 },
    linkReadByRegion,
  };
}

function scopedFor(linkReadByRegion: MetricSnapshot["linkReadByRegion"]): ScopedFragmentInput {
  return {
    subject: { displayName: "Тестов", aliases: [] },
    findings: [],
    surfaceUnits: [],
    metricSnapshot: metricSnapshot(linkReadByRegion),
    scope: fragmentScope("EXECUTIVE_SUMMARY"),
    evidenceIndex: {},
  } as unknown as ScopedFragmentInput;
}

const EXECUTIVE_SUMMARY = {
  verdict: "INSUFFICIENT_DATA",
  executiveConclusion:
    "Подтверждённых тем повышенного внимания по собранным источникам не выявлено.",
  keyFindings: [],
  priorityActions: ["Проверить первоисточники по незакрытым направлениям."],
  identityCaveats: [],
  dataLimitations: [],
};

function fallbackNarrative(linkReadByRegion: MetricSnapshot["linkReadByRegion"]): string {
  const out = buildExecutiveSummaryFragment("EXECUTIVE" as never, scopedFor(linkReadByRegion), {
    executiveSummary: EXECUTIVE_SUMMARY,
  } as never);
  return String(out.slides[0]!.content.narrative ?? "");
}

describe("строка доли в резюме", () => {
  it("детерминированный путь печатает её целиком", () => {
    expect(fallbackNarrative(BOTH_REGIONS)).toContain(SHARE_LINE);
  });

  it("путь составленного резюме печатает ту же строку", () => {
    const composed = sampleComposedClientSummary();
    const out = buildExecutiveSummaryFromComposed(
      "EXECUTIVE" as never,
      scopedFor(BOTH_REGIONS),
      { executiveSummary: EXECUTIVE_SUMMARY, composedClientSummary: composed } as never,
      composed
    );
    expect(String(out.slides[0]!.content.narrative ?? "")).toContain(SHARE_LINE);
  });

  it("регион без прочитанных страниц о субъекте в строке не назван", () => {
    const narrative = fallbackNarrative({
      RU: { requested: 20, read: 17, readOther: 2, adverseRead: 5 },
      UAE: { requested: 8, read: 0, readOther: 0, adverseRead: 0 },
    });
    // Сверяется сама строка доли: «ОАЭ» законно встречается в соседнем абзаце
    // о покрытии («Россия — 60; ОАЭ — 40»), и поиск по всему нарративу ловил бы
    // его вместо доли.
    const shareLine = narrative
      .split("\n")
      .find((p) => p.startsWith("Негатив среди прочитанных страниц:"));
    expect(shareLine).toBe("Негатив среди прочитанных страниц: Россия — 33% (5 из 15).");
  });

  it("прогон без чтения страниц строки не печатает вовсе", () => {
    const narrative = fallbackNarrative(undefined);
    expect(narrative).not.toContain("Негатив среди прочитанных");
    expect(narrative).not.toContain("%");
  });
});

describe("пост-проход держит строку доли после GPT и кэша", () => {
  const packs = () => [
    {
      fragmentKey: "EXECUTIVE_SUMMARY",
      slides: [
        {
          isContinuation: false,
          content: { narrative: "Основной вывод по субъекту сформулирован полностью." },
        },
      ],
    },
  ];

  it("повторное применение не удваивает строку", () => {
    const ms = metricSnapshot(BOTH_REGIONS);
    const once = applyExecutiveFreshnessChangeToPacks(packs() as never, {} as never, ms);
    const twice = applyExecutiveFreshnessChangeToPacks(once, {} as never, ms);
    const narrative = String(twice[0]!.slides[0]!.content.narrative ?? "");
    expect(narrative.match(/Негатив среди прочитанных/gu) ?? []).toHaveLength(1);
    expect(narrative).toContain(SHARE_LINE);
  });

  it("подменённый на стадии GPT нарратив снова получает строку целиком", () => {
    const ms = metricSnapshot(BOTH_REGIONS);
    const stage2 = [
      {
        fragmentKey: "EXECUTIVE_SUMMARY",
        slides: [
          {
            isContinuation: false,
            content: {
              narrative:
                "Стадия 2 переписала карточку одним длинным абзацем про цифровой профиль субъекта и его окружение, и прежние короткие карточки исчезли.",
            },
          },
        ],
      },
    ];
    const out = applyExecutiveFreshnessChangeToPacks(stage2 as never, {} as never, ms);
    const narrative = String(out[0]!.slides[0]!.content.narrative ?? "");
    expect(narrative.match(/Негатив среди прочитанных/gu) ?? []).toHaveLength(1);
    // Числа целы: кламп режет соседнюю строку §7.2, но не долю.
    expect(narrative).toContain(SHARE_LINE);
  });

  it("без данных о чтении пост-проход ничего не меняет", () => {
    const before = packs();
    const out = applyExecutiveFreshnessChangeToPacks(
      before as never,
      {} as never,
      metricSnapshot(undefined)
    );
    expect(String(out[0]!.slides[0]!.content.narrative ?? "")).toBe(
      "Основной вывод по субъекту сформулирован полностью."
    );
  });
});
