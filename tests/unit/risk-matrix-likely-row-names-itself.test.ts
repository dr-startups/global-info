/**
 * Строка матрицы с неподтверждённой принадлежностью называет себя заголовком.
 *
 * На живом отчёте 21.08 матрица показывала две карточки с одинаковым
 * заголовком «Криминальные / судебные материалы»: одну «Высокий» на восьми
 * материалах, другую «Требует подтверждения» на одном. Читатель, просматривающий
 * заголовки, видел тему дважды и не понимал, зачем (пункт CQ).
 *
 * Заголовок теперь говорит о статусе, а тело карточки — только о его следствии:
 * статус называется один раз, а не трижды (заголовок, чип уровня, оговорка).
 * Решение владельца 21.08.
 *
 * Агрегат вероятных материалов суффикса не получает: его собственная тема
 * («Материалы с вероятной принадлежностью») ни с чем не совпадает и статус
 * называет сама.
 */

import { describe, expect, it } from "vitest";
import { buildRiskMatrixFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/executive";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const THEME = "Криминальные / судебные материалы";

function finding(over: Partial<Finding> & { findingId: string }): Finding {
  return {
    theme: THEME,
    subjectMatch: "SUBJECT_MATCH",
    claim: `«${THEME}»\nВсего по теме: 8 материалов, с негативным контекстом — 8.`,
    riskLevel: "high",
    promotionPriority: "P1",
    evidenceRefs: [`inventory:${over.findingId}`],
    recommendedAction: "Проверить статусы дел и первоисточники до принятия решений.",
    ...over,
  } as unknown as Finding;
}

function scopedWith(findings: Finding[], likelySubjectCount = 0): ScopedFragmentInput {
  return {
    subject: { displayName: "Тест", aliases: [] },
    findings,
    surfaceUnits: [],
    evidenceIndex: {},
    scope: {},
    metricSnapshot: {
      likelySubjectCount,
      compositeCount: 100,
      subjectMatchCount: 10,
      adverseFindingCount: 2,
      perRegionCounts: {},
    },
  } as unknown as ScopedFragmentInput;
}

function fragment(findings: Finding[], likelySubjectCount = 0) {
  const { slides } = buildRiskMatrixFragment(
    "EXECUTIVE" as never,
    scopedWith(findings, likelySubjectCount)
  );
  return {
    rows: slides.flatMap((s) => s.content.table?.rows ?? []),
    bullets: slides.flatMap((s) => s.content.bullets ?? []),
  };
}

const CONFIRMED = finding({ findingId: "conf-1" });
const LIKELY = finding({
  findingId: "lik-1",
  subjectMatch: "LIKELY_SUBJECT",
  claim: `«${THEME}»\nВсего по теме: 1 материал, с негативным контекстом — 1.`,
});

describe("две строки матрицы с одной темой", () => {
  it("различаются заголовком, а не только чипом уровня", () => {
    const { rows } = fragment([CONFIRMED, LIKELY]);
    const titles = rows.map((r) => r[0]);
    expect(titles).toHaveLength(2);
    expect(new Set(titles).size).toBe(2);
    expect(titles).toContain(THEME);
    expect(titles).toContain(`${THEME} — принадлежность не подтверждена`);
  });

  it("уровень по-прежнему говорит своё слово", () => {
    const { rows } = fragment([CONFIRMED, LIKELY]);
    expect(rows.map((r) => r[1])).toEqual(["Высокий", "Требует подтверждения"]);
  });

  it("тело карточки не повторяет статус, но оставляет его следствие", () => {
    const { rows, bullets } = fragment([CONFIRMED, LIKELY]);
    const idx = rows.findIndex((r) => r[1] === "Требует подтверждения");
    const card = bullets[idx] ?? "";
    expect(card).not.toContain("Принадлежность пока не подтверждена");
    expect(card).toContain("итог");
  });

  it("агрегат вероятных материалов суффикса не получает", () => {
    const { rows } = fragment([CONFIRMED], 4);
    const aggregate = rows.find((r) => r[3] === "сводка");
    expect(aggregate).toBeDefined();
    expect(aggregate![0]).toBe("Материалы с вероятной принадлежностью");
  });
});
