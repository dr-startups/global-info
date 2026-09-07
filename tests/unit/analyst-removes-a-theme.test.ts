/**
 * Снятая аналитиком тема не печатается, а её материалы остаются.
 *
 * «Снять тему» и «снять материал» — разные действия. Тема это наше утверждение
 * о субъекте: сняли — значит отчёт его не делает. Материалы при этом реальны:
 * поисковик их показывает, и вычёркивать строку выдачи ради снятого вывода
 * значило бы соврать о выдаче.
 *
 * Решение о теме не может примениться там же, где решения о материалах: на тот
 * момент находок ещё нет — их синтезирует шаг после. Поэтому запись правки
 * несёт ключ темы, а снимает находку загрузчик входов деки, когда находки уже
 * собраны.
 */

import { describe, expect, it } from "vitest";
import { applyAnalystOverrides } from "@/modules/digital-profile/services/analyst-overrides-loader";
import { dropExcludedFindingsFromDeckInputs } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";
import type { SubjectResolution } from "@/modules/digital-profile/orion-golden/contracts/subject-resolution";

const THEME_KEY = "theme:criminal_legal";

function emptyResolution(): SubjectResolution {
  return {
    schemaVersion: "subject-resolution-v2",
    caseId: "case-1",
    datasetId: "ds",
    sourceHashes: [],
    evidenceRefs: [],
    subjectDisplayName: "Егоров Алексей Евгеньевич",
    items: [],
  } as SubjectResolution;
}

describe("снятие темы", () => {
  it("решение о теме записывается правкой с ключом темы", () => {
    const subjectResolution = emptyResolution();
    const { applied } = applyAnalystOverrides({
      items: [],
      resolutionByRef: new Map(),
      subjectResolution,
      overrides: {
        version: "analyst-overrides-v1",
        caseId: "case-1",
        classification: [],
        manualReview: [],
        approvedFindings: [],
        reviewDecisions: [
          {
            itemKind: "finding",
            itemKey: THEME_KEY,
            decisionKind: "presence",
            status: "EXCLUDED",
            source: "review_decision",
          },
        ],
      },
    });
    expect(applied).toEqual([
      expect.objectContaining({ kind: "review_finding_excluded", matchKey: THEME_KEY }),
    ]);
  });

  it("снятое решение записи не оставляет", () => {
    const { applied } = applyAnalystOverrides({
      items: [],
      resolutionByRef: new Map(),
      subjectResolution: emptyResolution(),
      overrides: {
        version: "analyst-overrides-v1",
        caseId: "case-1",
        classification: [],
        manualReview: [],
        approvedFindings: [],
        reviewDecisions: [
          {
            itemKind: "finding",
            itemKey: THEME_KEY,
            decisionKind: "presence",
            status: "CLEARED",
            source: "review_decision",
          },
        ],
      },
    });
    expect(applied).toHaveLength(0);
  });

  it("находки снятой темы уходят из деки, чужие остаются", () => {
    const findings = [
      {
        findingId: "finding-criminal_legal-subject_match-98de229b",
        theme: "Криминальные / судебные материалы",
        evidenceRefs: ["inventory:obs-a"],
      },
      {
        findingId: "finding-criminal_legal-ambiguous-88fdb56a",
        theme: "Криминальные / судебные материалы",
        evidenceRefs: ["inventory:obs-b"],
      },
      {
        findingId: "finding-business_profile-subject_match-8ced675a",
        theme: "Деловой профиль",
        evidenceRefs: ["inventory:obs-c"],
      },
    ] as unknown as Finding[];

    const removed = dropExcludedFindingsFromDeckInputs({
      findings,
      excludedThemeKeys: new Set([THEME_KEY]),
    });

    expect(findings.map((f) => f.findingId)).toEqual([
      "finding-business_profile-subject_match-8ced675a",
    ]);
    expect(removed.count).toBe(2);
  });

  it("без снятых тем находки не двигаются", () => {
    const findings = [
      { findingId: "finding-criminal_legal-subject_match-1", theme: "т", evidenceRefs: [] },
    ] as unknown as Finding[];
    const removed = dropExcludedFindingsFromDeckInputs({
      findings,
      excludedThemeKeys: new Set<string>(),
    });
    expect(findings).toHaveLength(1);
    expect(removed.count).toBe(0);
  });
});
