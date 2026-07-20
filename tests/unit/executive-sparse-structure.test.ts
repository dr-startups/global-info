/**
 * REMEDIATION §7.3 — sparse executive keeps ≥3 content blocks.
 * Golden-case sparse acceptance (offline; no report-72 fixture load).
 */

import { describe, expect, it } from "vitest";
import {
  buildExecutiveSummaryFragment,
  composeExecutivePageStructure,
  fragmentScope,
} from "../../src/modules/digital-profile/orion-golden/deck-sections";

describe("REMEDIATION §7.3 executive sparse structure", () => {
  const es = {
    verdict: "INSUFFICIENT_DATA",
    executiveConclusion:
      "Собранных подтверждённых данных по субъекту недостаточно для доказательного вывода о репутационных рисках. Значительная часть найденных материалов относится к другому лицу и не может использоваться в выводах.",
    keyFindings: [] as Array<{
      findingId: string;
      title: string;
      factualBasis: string;
      clientImpact: string;
      recommendedAction: string;
    }>,
    priorityActions: ["Расширить проверку по незакрытым направлениям до принятия решений."],
    identityCaveats: [
      "В выдаче присутствуют материалы о другом лице — Тёзка (12 набл.); они исключены из выводов о проверяемом субъекте.",
      "4 наблюдений не удалось однозначно отнести к проверяемому лицу; они не учитывались как факты.",
    ],
    dataLimitations: ["Комплаенс-базы: выборка ограничена доступными провайдерами."],
    regionalOverview: [
      { region: "RU", oneLiner: "Регион RU: негативные материалы — 2 из 40 (5%).", totalCount: 40 },
    ],
  };

  const scoped = {
    subject: { displayName: "Тестов Иван", aliases: ["Ivan Testov"] },
    findings: [],
    surfaceUnits: [
      { surface: "organic" as const, region: "RU", metrics: [], claims: [], evidenceRefs: [] },
      { surface: "suggestions" as const, region: "RU", metrics: [], claims: [], evidenceRefs: [] },
      { surface: "images" as const, region: "RU", metrics: [], claims: [], evidenceRefs: [] },
      { surface: "wikipedia" as const, region: "RU", metrics: [], claims: [], evidenceRefs: [] },
      { surface: "ai_answers" as const, region: "RU", metrics: [], claims: [], evidenceRefs: [] },
      { surface: "organic" as const, region: "UAE", metrics: [], claims: [], evidenceRefs: [] },
    ],
    metricSnapshot: {
      metricSnapshotId: "m-sparse",
      datasetId: "d-sparse",
      reportRunId: "r-sparse",
      baseCount: 80,
      enrichmentCount: 0,
      compositeCount: 80,
      subjectMatchCount: 3,
      likelySubjectCount: 7,
      ambiguousCount: 4,
      otherSubjectCount: 12,
      adverseFindingCount: 0,
      perRegionCounts: { RU: 50, UAE: 30 },
    },
    scope: fragmentScope("EXECUTIVE_SUMMARY"),
    evidenceIndex: {},
  };

  it("composeExecutivePageStructure yields ≥3 blocks (coverage + identity + actions)", () => {
    const structure = composeExecutivePageStructure(scoped as never, es);
    const blockCount =
      structure.narrativeParagraphs.length +
      structure.factCards.length +
      (structure.recommendations ? 1 : 0);
    expect(blockCount).toBeGreaterThanOrEqual(3);
    expect(structure.narrativeParagraphs.some((p) => /Карта покрытия/i.test(p))).toBe(true);
    expect(
      structure.narrativeParagraphs.some((p) =>
        /другом лице|требуют подтвержд|неоднознач/i.test(p)
      ) ||
        structure.factCards.some((p) => /другом лице|требуют подтвержд|неоднознач/i.test(p))
    ).toBe(true);
    expect(structure.recommendations).toMatch(/Расширить проверку|проверка/i);
  });

  it("sparse fragment slide keeps multi-block narrative, bullets, actions, LIKELY KPI", () => {
    const out = buildExecutiveSummaryFragment("EXECUTIVE" as never, scoped as never, {
      executiveSummary: es,
    });
    expect(out.status).toBe("READY");
    const slide = out.slides[0]!;
    const paras = String(slide.content.narrative ?? "")
      .split(/\n+/)
      .filter(Boolean);
    expect(paras.length).toBeGreaterThanOrEqual(2);
    expect(slide.content.bullets?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(String(slide.content.whatToCheck ?? "").length).toBeGreaterThan(20);
    expect(slide.content.kpis?.some((k) => k.label === "Вероятно о субъекте" && k.value === "7")).toBe(
      true
    );
    expect(Number(slide.metrics?.structureBlocks ?? 0)).toBeGreaterThanOrEqual(3);
    expect(slide.metrics?.sparse).toBe(1);
  });
});
