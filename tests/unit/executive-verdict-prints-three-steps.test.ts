/**
 * Плашка резюме и вывод говорят теми же тремя словами, что и карточки.
 *
 * Четвёртое слово шкалы на первой содержательной странице («Повышенный риск»,
 * «Смешанный фон») стояло бы рядом с трёхсловными карточками матрицы — это две
 * шкалы в одном документе. Нюанс вердикта не теряется: он живёт в предложении
 * вывода, а не в отдельном слове шкалы.
 *
 * Отдельно закреплено наследие: составное резюме, собранное до шага, содержит
 * слово «критический», и плашка обязана привести его к печатной ступени, а не
 * напечатать как есть.
 */

import { describe, expect, it } from "vitest";
import {
  buildExecutiveSummaryFragment,
  buildExecutiveSummaryFromComposed,
  composeSlideNarrative,
  fragmentScope,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import {
  sampleCanonicalClaimsBundle,
  sampleClientSummaryPack,
  sampleComposedClientSummary,
  sampleRepresentativeEvidenceSelection,
} from "@/modules/digital-profile/orion-golden/contracts/sample-contracts";
import { buildClientSummaryPack } from "@/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import { composeClientSummary } from "@/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import type { ComposedClientSummary } from "@/modules/digital-profile/orion-golden/contracts/composed-client-summary";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const EXECUTIVE_SUMMARY = {
  verdict: "ELEVATED",
  executiveConclusion: "Собранные материалы формируют заметный негативный фон вокруг субъекта.",
  keyFindings: [],
  priorityActions: ["Проверить первоисточники по незакрытым направлениям."],
  identityCaveats: [],
  dataLimitations: [],
};

function scoped(): ScopedFragmentInput {
  return {
    subject: { displayName: "Тестов", aliases: [] },
    findings: [],
    surfaceUnits: [],
    evidenceIndex: {},
    scope: fragmentScope("EXECUTIVE_SUMMARY"),
    metricSnapshot: {
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
    },
  } as unknown as ScopedFragmentInput;
}

function subtitleFor(verdict: string): string {
  const out = buildExecutiveSummaryFragment("EXECUTIVE" as never, scoped(), {
    executiveSummary: { ...EXECUTIVE_SUMMARY, verdict },
  } as never);
  return String(out.slides[0]!.subtitle ?? "");
}

/** Составное резюме, собранное до шага: в тексте стоит «критический». */
function legacyComposed(): ComposedClientSummary {
  const composed = sampleComposedClientSummary();
  const legacy = "Итоговая оценка: критический риск. Основные основания: Коррупционные и этические риски.";
  return {
    ...composed,
    fullText: composed.fullText.replace(composed.sections.overallAssessment, legacy),
    sections: { ...composed.sections, overallAssessment: legacy },
  };
}

describe("плашка резюме", () => {
  it("ELEVATED печатается «Высоким риском», а не «Повышенным»", () => {
    expect(subtitleFor("ELEVATED")).toBe("Итоговая оценка: Высокий риск");
    expect(subtitleFor("HIGH")).toBe("Итоговая оценка: Высокий риск");
  });

  it("MIXED печатается «Средним риском», а не «Смешанным фоном»", () => {
    expect(subtitleFor("MIXED")).toBe("Итоговая оценка: Средний риск");
  });

  it("недостаток данных ступенью не подменяется", () => {
    expect(subtitleFor("INSUFFICIENT_DATA")).toBe("Итоговая оценка: Недостаточно данных");
  });

  it("составное резюме со старым словом даёт печатную ступень", () => {
    const composed = legacyComposed();
    const out = buildExecutiveSummaryFromComposed(
      "EXECUTIVE" as never,
      scoped(),
      { composedClientSummary: composed } as never,
      composed
    );
    expect(out.slides[0]!.subtitle).toBe("Итоговая оценка: Высокий риск");
  });

  it("подзаголовок, повторяющий первое предложение, по-прежнему снимается", () => {
    expect(
      composeSlideNarrative(
        "Итоговая оценка: Высокий риск",
        "Итоговая оценка: высокий риск. Основные основания: судебные материалы."
      )
    ).toBe("Итоговая оценка: высокий риск. Основные основания: судебные материалы.");
  });
});

describe("предложение вывода", () => {
  it("составленное резюме печатает вывод пакета и своей ступени не приписывает", () => {
    // Ступень называет тот, кто её вычислил. Пока композитор приписывал свою,
    // на одном слайде стояли две оценки: его — по уровню тем, и плашка — по
    // вердикту аналитики.
    const pack = sampleClientSummaryPack();
    pack.overallAssessment.riskLevel = "critical";
    pack.overallAssessment.conclusion = "Основные основания: судебные и коррупционные материалы.";
    const summary = composeClientSummary({ pack });
    expect(summary.sections.overallAssessment).toContain(
      "Основные основания: судебные и коррупционные материалы."
    );
    expect(summary.sections.overallAssessment).not.toMatch(/Итоговая оценка/);
    expect(summary.sections.overallAssessment).not.toMatch(/критическ/i);
  });

  it("вердикт ELEVATED звучит «высоким», а не «повышенным»", () => {
    const built = buildClientSummaryPack({
      caseId: "case-scale",
      datasetId: "ds-scale",
      subjectId: "subject-sample",
      sourceHashes: ["sha256:scale"],
      claimsBundle: sampleCanonicalClaimsBundle(),
      representative: sampleRepresentativeEvidenceSelection(),
      overallVerdict: "ELEVATED",
    } as never);
    expect(built.overallAssessment.conclusion).toContain("Итоговая оценка: высокий риск");
    expect(built.overallAssessment.conclusion).not.toMatch(/повышенн/i);
  });

  it("без переданного вердикта критический уровень тем печатается «высоким»", () => {
    const claimsBundle = sampleCanonicalClaimsBundle();
    claimsBundle.claims[0]!.materialityLevel = "CRITICAL";
    const representative = sampleRepresentativeEvidenceSelection();
    for (const list of Object.values(representative.selectedByTheme)) {
      for (const item of list) item.materialityLevel = "CRITICAL";
    }
    const built = buildClientSummaryPack({
      caseId: "case-scale",
      datasetId: "ds-scale",
      subjectId: "subject-sample",
      sourceHashes: ["sha256:scale"],
      claimsBundle,
      representative,
    } as never);
    expect(built.overallAssessment.riskLevel).toBe("critical");
    expect(built.overallAssessment.conclusion).toContain("Итоговая оценка: высокий риск");
    expect(built.overallAssessment.conclusion).not.toMatch(/критическ/i);
  });
});

describe("пустая матрица: ступень не выдумывается", () => {
  /** Пакет без единой существенной темы — то, что даёт пустая матрица рисков. */
  function emptyPack() {
    const claimsBundle = sampleCanonicalClaimsBundle();
    claimsBundle.claims = [];
    const representative = sampleRepresentativeEvidenceSelection();
    representative.materialThemeIds = [];
    representative.selectedByTheme = {};
    return buildClientSummaryPack({
      caseId: "case-empty",
      datasetId: "ds-empty",
      subjectId: "subject-sample",
      sourceHashes: ["sha256:empty"],
      claimsBundle,
      representative,
    } as never);
  }

  it("вывод остаётся честным: тем не выделено, ступень не названа", () => {
    const pack = emptyPack();
    expect(pack.overallAssessment.riskLevel).toBe("none");
    const summary = composeClientSummary({ pack });
    // Ставить «низкий риск» и следом «вывод ограничен доступностью данных» —
    // два ответа в двух соседних предложениях.
    expect(summary.sections.overallAssessment).toContain("существенных рисковых тем");
    expect(summary.sections.overallAssessment).not.toMatch(/Итоговая оценка/);
    expect(summary.sections.overallAssessment).not.toMatch(/низкий|средний|высокий/i);
  });

  it("плашка на таком резюме ступень не печатает", () => {
    const composed = composeClientSummary({ pack: emptyPack() });
    const out = buildExecutiveSummaryFromComposed(
      "EXECUTIVE" as never,
      scoped(),
      { composedClientSummary: composed } as never,
      composed
    );
    expect(out.slides[0]!.subtitle).toBe("Итоговая оценка: по открытым источникам");
  });
});
