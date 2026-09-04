import { describe, expect, it } from "vitest";
import { assertAnchoredRunHasSubjectMatches } from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import {
  deterministicGateOf,
  isDeterministicPrepareGate,
  prepareGateAdvice,
} from "@/modules/digital-profile/services/prepare-gate-advice";
import type { SubjectAnchors } from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";

/**
 * Прогон по якорям, не подтвердивший ни одного материала, до стадий модели не
 * доходит.
 *
 * Отчёт из нуля подтверждённых материалов — это лист «ничего не найдено» ценой
 * четырёх стадий GPT. Причина почти всегда одна: якорь написан не теми словами,
 * какими пишет выдача («Арбитражный суд Краснодарского края» против «АС
 * Краснодарского края»). Это чинится правкой признаков и пересборкой отчёта,
 * а не повтором той же подготовки.
 */

const ANCHORS: SubjectAnchors = {
  birthDate: "1977-11-30",
  phrases: [],
  inn: [],
  domains: [],
};

const items = (decisions: string[]) => decisions.map((decision, i) => ({ decision, evidenceRef: `e${i}` }));

describe("остановка прогона по якорям без подтверждённых материалов", () => {
  it("подтверждённых нет — отказ называет себя гейтом и числом", () => {
    expect(() =>
      assertAnchoredRunHasSubjectMatches({ anchors: ANCHORS, items: items(["AMBIGUOUS", "OTHER_SUBJECT"]) })
    ).toThrow(/SUBJECT_ANCHORS_NO_MATCH=2/u);
  });

  it("хотя бы один подтверждён — прогон идёт дальше", () => {
    expect(() =>
      assertAnchoredRunHasSubjectMatches({ anchors: ANCHORS, items: items(["SUBJECT_MATCH", "AMBIGUOUS"]) })
    ).not.toThrow();
  });

  it("«вероятно» тоже считается: слабый признак — всё же признак", () => {
    expect(() =>
      assertAnchoredRunHasSubjectMatches({ anchors: ANCHORS, items: items(["LIKELY_SUBJECT"]) })
    ).not.toThrow();
  });

  it("якорей нет — прежнее поведение: пустой отчёт собирается, как собирался", () => {
    expect(() =>
      assertAnchoredRunHasSubjectMatches({ anchors: null, items: items(["AMBIGUOUS"]) })
    ).not.toThrow();
  });

  it("материалов нет вовсе — это не отказ якорей", () => {
    // Пустой корпус — другой разговор, и о нём говорят другие ворота.
    expect(() => assertAnchoredRunHasSubjectMatches({ anchors: ANCHORS, items: [] })).not.toThrow();
  });

  it("гейт детерминированный: кнопки «повторить» оператор не увидит", () => {
    const message = "SUBJECT_ANCHORS_NO_MATCH=2";
    expect(deterministicGateOf(message)).toBe("SUBJECT_ANCHORS_NO_MATCH");
    expect(isDeterministicPrepareGate(message)).toBe(true);
    const advice = prepareGateAdvice(message);
    expect(advice).toContain("признак");
    expect(advice).toContain("Пересобрать отчёт");
  });
});
