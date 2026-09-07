/**
 * Пункт-тема ключуется темой, а не находкой.
 *
 * Идентификатор находки хешируется от состава её улик и меняется вместе с ним:
 * решение, привязанное к нему, отвалилось бы на первой же пересборке — ровно
 * тогда, когда должно сработать. Ключом служит тема.
 *
 * Одна тема живёт в отчёте несколькими корзинами: подтверждённая — в матрице,
 * «принадлежность не подтверждена» — в приложении. Аналитик думает темой, а не
 * корзиной, поэтому пункт один, а состояние называет обе.
 *
 * «Подтвердить тему» — это подтвердить принадлежность её материалов, и ничего
 * сверх того: иначе отчёт объявил бы тему подтверждённой при неподтверждённых
 * уликах. Ключи материалов едут в пункте, чтобы решение разложилось на них.
 */

import { describe, expect, it } from "vitest";
import { buildReviewSheet } from "@/modules/digital-profile/services/review-sheet";

const INPUT = {
  caseId: "case-1",
  slides: [
    {
      slideKey: "p04_risk_dashboard",
      baseSlotId: "p04_risk_dashboard",
      templateId: "risk-matrix",
      pageNumber: 9,
      title: "Матрица комплаенс-рисков",
      findingIds: ["finding-criminal_legal-subject_match-98de229b"],
    },
    {
      slideKey: "appendix_main_base",
      baseSlotId: "appendix_main_base",
      templateId: "finding-cards",
      pageNumber: 62,
      title: "Приложение",
      findingIds: ["finding-criminal_legal-ambiguous-88fdb56a"],
    },
  ],
  observations: [
    {
      url: "https://zakrasnodar.ru/art/villa.html",
      title: "Вилла матери судьи",
      domain: "zakrasnodar.ru",
      evidenceRefs: ["inventory:obs-a"],
    },
  ],
  subjectResolution: [
    { evidenceRef: "inventory:obs-a", decision: "AMBIGUOUS", reasonCode: "surname_only" },
  ],
  findings: [
    {
      findingId: "finding-criminal_legal-subject_match-98de229b",
      theme: "Криминальные / судебные материалы",
      subjectMatch: "SUBJECT_MATCH",
      riskLevel: "critical",
      evidenceRefs: ["inventory:obs-a"],
    },
  ],
  ambiguousFindings: [
    {
      findingId: "finding-criminal_legal-ambiguous-88fdb56a",
      theme: "Криминальные / судебные материалы",
      subjectMatch: "AMBIGUOUS",
      riskLevel: "critical",
      evidenceRefs: ["inventory:obs-a"],
    },
  ],
};

describe("пункт-тема листа проверки", () => {
  it("ключуется темой, а обе корзины сходятся в один пункт", () => {
    const sheet = buildReviewSheet(INPUT);
    const themes = sheet.items.filter((i) => i.kind === "finding");
    expect(themes).toHaveLength(1);
    expect(themes[0]!.key).toBe("theme:criminal_legal");
    expect(themes[0]!.title).toBe("Криминальные / судебные материалы");
    // Страницы обеих корзин: аналитик видит всё, где тема напечатана.
    expect(themes[0]!.pages).toEqual([9, 62]);
    // Состояние называет обе корзины, а не одну из них наугад.
    expect(themes[0]!.state).toContain("подтверждена");
    expect(themes[0]!.state).toContain("приложении");
  });

  it("несёт ключи своих материалов — по ним решение и раскладывается", () => {
    const sheet = buildReviewSheet(INPUT);
    const theme = sheet.items.find((i) => i.kind === "finding")!;
    expect(theme.materialKeys).toEqual(["url:zakrasnodar.ru/art/villa.html"]);
  });

  it("снятая тема стоит в листе, хотя в деке её нет", () => {
    const sheet = buildReviewSheet({
      ...INPUT,
      slides: [INPUT.slides[0]!],
      findings: [],
      ambiguousFindings: [],
      decisions: [
        {
          itemKind: "finding",
          itemKey: "theme:criminal_legal",
          decisionKind: "presence",
          status: "EXCLUDED",
          decidedAt: "2026-09-07T10:00:00.000Z",
        },
      ],
    });
    const theme = sheet.items.find((i) => i.kind === "finding");
    expect(theme?.key).toBe("theme:criminal_legal");
    expect(theme?.state).toContain("снят");
    expect(theme?.open).toBe(false);
  });
});
