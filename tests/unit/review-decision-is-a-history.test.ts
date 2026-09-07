/**
 * Решение аналитика — история, а не перезапись.
 *
 * Выпуск отчёта юридически значим, и на вопрос «почему в отчёте нет X» надо
 * отвечать данными: кто решил, когда и что решал до этого. Файл на томе,
 * которым жил классический контур, не версионирует решения, не знает автора и
 * не переживает переезд тома.
 *
 * Вопрос у решения один. «Чей это материал» и «негативен ли он» — разные
 * вопросы, и одно поле статуса заставило бы аналитика выбирать между ответами:
 * материал однофамильца бывает и негативным, и чужим одновременно.
 */

import { describe, expect, it } from "vitest";
import {
  activeReviewDecisions,
  isValidReviewDecision,
  reviewDecisionsDigest,
  type ReviewDecisionRow,
} from "@/modules/digital-profile/services/review-decision-store";

const KEY = "url:zakrasnodar.ru/art/villa.html";

function row(over: Partial<ReviewDecisionRow> & { id: string }): ReviewDecisionRow {
  return {
    caseId: "case-1",
    itemKind: "evidence",
    itemKey: KEY,
    decisionKind: "belonging",
    status: "CONFIRMED_SUBJECT",
    isActive: true,
    decidedBy: "analyst-1",
    decidedAt: "2026-09-07T10:00:00.000Z",
    ...over,
  } as ReviewDecisionRow;
}

describe("решения аналитика", () => {
  it("допустимая пара «вопрос → ответ» названа явно", () => {
    expect(isValidReviewDecision("belonging", "CONFIRMED_SUBJECT")).toBe(true);
    expect(isValidReviewDecision("belonging", "OTHER_SUBJECT")).toBe(true);
    expect(isValidReviewDecision("belonging", "CLEARED")).toBe(true);
    expect(isValidReviewDecision("adverse", "NEUTRAL")).toBe(true);
    expect(isValidReviewDecision("adverse", "ADVERSE")).toBe(true);
    // Ответ не на свой вопрос не принимается: иначе «негатив» лёг бы в
    // принадлежность и молча ничего не изменил.
    expect(isValidReviewDecision("belonging", "NEUTRAL")).toBe(false);
    expect(isValidReviewDecision("adverse", "CONFIRMED_SUBJECT")).toBe(false);
    expect(isValidReviewDecision("wat", "CLEARED")).toBe(false);
  });

  it("действующее решение — последнее активное на пару «пункт + вопрос»", () => {
    const active = activeReviewDecisions([
      row({ id: "a", status: "OTHER_SUBJECT", isActive: false, decidedAt: "2026-09-06T10:00:00.000Z" }),
      row({ id: "b", status: "CONFIRMED_SUBJECT" }),
      row({ id: "c", decisionKind: "adverse", status: "NEUTRAL" }),
    ]);
    expect(active.get(`${KEY}|belonging`)?.status).toBe("CONFIRMED_SUBJECT");
    expect(active.get(`${KEY}|adverse`)?.status).toBe("NEUTRAL");
    expect(active.size).toBe(2);
  });

  it("«снимаю решение» действующим решением не является", () => {
    const active = activeReviewDecisions([
      row({ id: "a", isActive: false }),
      row({ id: "b", status: "CLEARED" }),
    ]);
    // Строка в истории осталась, но машинный ответ больше ничем не перекрыт.
    expect(active.has(`${KEY}|belonging`)).toBe(false);
  });

  it("отпечаток набора решений меняется вместе с ним и не зависит от порядка", () => {
    const a = row({ id: "a" });
    const b = row({ id: "b", decisionKind: "adverse", status: "NEUTRAL" });
    expect(reviewDecisionsDigest([a, b])).toBe(reviewDecisionsDigest([b, a]));
    expect(reviewDecisionsDigest([a])).not.toBe(reviewDecisionsDigest([a, b]));
    expect(reviewDecisionsDigest([])).toBe(reviewDecisionsDigest([]));
  });
});
