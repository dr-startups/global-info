/**
 * Снятый пункт — закрытый пункт, и снятие отменяется дословно.
 *
 * Открытость считалась по принадлежности и не спрашивала о снятии: материал,
 * убранный из отчёта, оставался в счёте открытых до пересборки, и «выпустить
 * при N открытых» называл число, которого нет. А пункт, рождённый решением о
 * снятии, после отмены решения продолжал стоять в листе с состоянием «снят».
 */

import { describe, expect, it } from "vitest";
import {
  applyDecisionsToSheet,
  buildReviewSheet,
} from "@/modules/digital-profile/services/review-sheet";

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
      evidenceRefs: ["inventory:gone"],
    },
  ],
  observations: [
    { url: "https://gone.example/1", title: "Материал", domain: "gone.example", evidenceRefs: ["inventory:gone"] },
  ],
  subjectResolution: [
    { evidenceRef: "inventory:gone", decision: "AMBIGUOUS", reasonCode: "surname_only" },
  ],
};
const EXCLUDED = {
  itemKind: "evidence",
  itemKey: KEY,
  decisionKind: "presence",
  status: "EXCLUDED",
  decidedAt: "2026-09-07T10:00:00.000Z",
};

describe("снятие и открытость пункта", () => {
  it("материал, ещё стоящий в деке, после снятия открытым не считается", () => {
    const built = buildReviewSheet({ ...INPUT, decisions: [EXCLUDED] });
    expect(built.items[0]!.open).toBe(false);
    expect(built.summary.evidence.open).toBe(0);

    const overlaid = applyDecisionsToSheet(buildReviewSheet(INPUT), [EXCLUDED]);
    expect(overlaid.items[0]!.open).toBe(false);
    expect(overlaid.summary.evidence.open).toBe(0);
  });

  it("отмена снятия возвращает открытость дословно", () => {
    const overlaid = applyDecisionsToSheet(buildReviewSheet({ ...INPUT, decisions: [EXCLUDED] }), []);
    expect(overlaid.items[0]!.open).toBe(true);
    expect(overlaid.items[0]!.decisions).toBeUndefined();
  });

  it("пункт, рождённый снятием, исчезает вместе с отменой", () => {
    // В деке материала нет — пункт добавлен из решения.
    const sheet = buildReviewSheet({
      ...INPUT,
      slides: [{ ...INPUT.slides[0]!, evidenceRefs: [] }],
      decisions: [EXCLUDED],
    });
    expect(sheet.items.find((i) => i.key === KEY)?.fromDecision).toBe(true);

    const cleared = applyDecisionsToSheet(sheet, []);
    expect(cleared.items.find((i) => i.key === KEY)).toBeUndefined();
    expect(cleared.summary.evidence.total).toBe(0);
  });

  it("снятая тема тоже закрыта и уходит с отменой", () => {
    const theme = {
      itemKind: "finding",
      itemKey: "theme:criminal_legal",
      decisionKind: "presence",
      status: "EXCLUDED",
      decidedAt: "2026-09-07T10:00:00.000Z",
    };
    const sheet = buildReviewSheet({ ...INPUT, decisions: [theme] });
    const item = sheet.items.find((i) => i.key === theme.itemKey)!;
    expect(item.open).toBe(false);
    expect(item.fromDecision).toBe(true);
    expect(applyDecisionsToSheet(sheet, []).items.find((i) => i.key === theme.itemKey)).toBeUndefined();
  });
});
