/**
 * Снятый материал виден в листе проверки — иначе решение нельзя отменить.
 *
 * Лист строится из напечатанного, а снятого материала в отчёте нет по
 * построению: без отдельного раздела он исчез бы вместе со своей кнопкой, и
 * аналитик не смог бы ни увидеть своё решение, ни вернуть материал. Решение,
 * которое нельзя отменить, — ловушка.
 */

import { describe, expect, it } from "vitest";
import { buildReviewSheet } from "@/modules/digital-profile/services/review-sheet";

const KEY = "url:gone.example/1";

const INPUT = {
  caseId: "case-1",
  slides: [
    {
      slideKey: "p09_ru_serp_table",
      baseSlotId: "p09_ru_serp_table",
      templateId: "serp-table",
      pageNumber: 15,
      title: "Россия — результаты поисковой выдачи",
      evidenceRefs: ["inventory:kept"],
    },
  ],
  observations: [
    {
      url: "https://kept.example/1",
      title: "Оставленный материал",
      domain: "kept.example",
      evidenceRefs: ["inventory:kept"],
    },
    {
      url: "https://gone.example/1",
      title: "Снятый материал",
      domain: "gone.example",
      evidenceRefs: ["inventory:gone"],
    },
  ],
  subjectResolution: [
    { evidenceRef: "inventory:kept", decision: "SUBJECT_MATCH", reasonCode: "full_name_match" },
    { evidenceRef: "inventory:gone", decision: "AMBIGUOUS", reasonCode: "surname_only" },
  ],
};

const REMOVED = {
  itemKind: "evidence",
  itemKey: KEY,
  decisionKind: "presence",
  status: "EXCLUDED",
  decidedBy: "analyst-1",
  decidedAt: "2026-09-07T10:00:00.000Z",
};

describe("лист проверки и снятые материалы", () => {
  it("снятый материал стоит в листе, хотя в деке его нет", () => {
    const sheet = buildReviewSheet({ ...INPUT, decisions: [REMOVED] });
    const gone = sheet.items.find((i) => i.key === KEY);
    expect(gone).toBeDefined();
    expect(gone?.kind).toBe("evidence");
    expect(gone?.url).toBe("https://gone.example/1");
    expect(gone?.state).toContain("снят");
    expect(gone?.decisions?.presence?.status).toBe("EXCLUDED");
    // Решение принято, решать нечего — пункт закрыт.
    expect(gone?.open).toBe(false);
    // Страниц у него нет: он нигде не напечатан, и обещать страницу нельзя.
    expect(gone?.pages).toEqual([]);
  });

  it("возвращённый материал снова считается напечатанным, если он в деке", () => {
    const sheet = buildReviewSheet({
      ...INPUT,
      slides: [
        {
          ...INPUT.slides[0]!,
          evidenceRefs: ["inventory:kept", "inventory:gone"],
        },
      ],
      decisions: [{ ...REMOVED, status: "CLEARED" }],
    });
    const gone = sheet.items.find((i) => i.key === KEY);
    expect(gone?.pages).toEqual([15]);
    expect(gone?.open).toBe(true);
  });

  it("снятый материал не считается открытым пунктом", () => {
    const sheet = buildReviewSheet({ ...INPUT, decisions: [REMOVED] });
    expect(sheet.summary.evidence.open).toBe(0);
  });
});
