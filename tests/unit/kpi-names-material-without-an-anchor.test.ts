import { describe, expect, it } from "vitest";
import {
  buildDigitalProfileOverviewFragment,
  fragmentScope,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import type {
  MetricSnapshot,
  ScopedFragmentInput,
} from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

/**
 * Обложка не обещает проверенной принадлежности там, где её не проверяли.
 *
 * «Принадлежность каждого материала к проверяемому лицу проверена» — правда
 * только в режиме по якорям: без признака материал отнесён к субъекту по
 * одному совпадению ФИО, и прогон DPA-2026-0049 показал, чего эта фраза стоит.
 * В режиме по якорям на неё есть право, и рядом называется число материалов,
 * которым признака не хватило.
 */

function snapshot(extra: Partial<MetricSnapshot>): MetricSnapshot {
  return {
    metricSnapshotId: "m",
    datasetId: "d",
    reportRunId: "r",
    baseCount: 0,
    enrichmentCount: 0,
    compositeCount: 40,
    subjectMatchCount: 10,
    likelySubjectCount: 2,
    ambiguousCount: 25,
    otherSubjectCount: 3,
    adverseFindingCount: 1,
    perRegionCounts: { RU: 40 },
    ...extra,
  };
}

function narrativeOf(ms: MetricSnapshot): string {
  const scoped = {
    subject: { displayName: "Тестов", aliases: [] },
    findings: [],
    surfaceUnits: [],
    metricSnapshot: ms,
    scope: fragmentScope("DIGITAL_PROFILE_OVERVIEW"),
    evidenceIndex: {},
  } as unknown as ScopedFragmentInput;
  const out = buildDigitalProfileOverviewFragment("EXECUTIVE" as never, scoped);
  return String(out.slides[0]!.content.narrative ?? "");
}

describe("обложка о принадлежности материалов", () => {
  it("прогон по якорям вправе сказать, что принадлежность проверена", () => {
    const text = narrativeOf(snapshot({ anchoredRun: true, unconfirmedSubjectCount: 0 }));
    expect(text).toContain("Принадлежность каждого материала к проверяемому лицу проверена.");
  });

  it("прогон без якорей этого не обещает", () => {
    const text = narrativeOf(snapshot({}));
    expect(text).not.toContain("Принадлежность каждого материала");
  });

  it("материалы без подтверждающего признака названы числом", () => {
    const text = narrativeOf(snapshot({ anchoredRun: true, unconfirmedSubjectCount: 18 }));
    expect(text).toContain(
      "Из них 18 совпали с проверяемым лицом только полным именем, без подтверждающего признака."
    );
  });

  it("таких материалов нет — лишней фразы тоже нет", () => {
    const text = narrativeOf(snapshot({ anchoredRun: true, unconfirmedSubjectCount: 0 }));
    expect(text).not.toContain("только полным именем");
  });
});
