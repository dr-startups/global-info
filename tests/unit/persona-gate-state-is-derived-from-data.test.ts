import { describe, expect, it } from "vitest";
import {
  personaGateState,
  subjectInputHash,
} from "@/modules/digital-profile/services/subject-persona-check";

/**
 * Состояние — это данные, а не название: «подтверждено» означает, что среди
 * решённых строк кейса есть строка с хешем **нынешних** данных субъекта.
 * Слова статуса здесь нет намеренно — оно умело бы значить два разных случая.
 */

const CURRENT = subjectInputHash({
  fullName: "Петров Иван Иванович",
  aliases: [],
  dateOfBirth: "1970-03-05",
});
const OTHER = subjectInputHash({
  fullName: "Петров Иван Иванович",
  aliases: [],
  dateOfBirth: "1970-03-06",
});

describe("ворота считают состояние по данным", () => {
  it("решений нет — PENDING", () => {
    const state = personaGateState({
      isFixture: false,
      subjectInputHash: CURRENT,
      decidedHashes: [],
    });
    expect(state.mode).toBe("PENDING");
    expect(state.reason).toBe("PERSONA_NOT_CONFIRMED");
  });

  it("есть решение с нынешним хешем — CONFIRMED", () => {
    expect(
      personaGateState({
        isFixture: false,
        subjectInputHash: CURRENT,
        decidedHashes: [OTHER, CURRENT],
      }).mode
    ).toBe("CONFIRMED");
  });

  it("решения есть, но с другими хешами — STALE", () => {
    const state = personaGateState({
      isFixture: false,
      subjectInputHash: CURRENT,
      decidedHashes: [OTHER],
    });
    // Мутационная точка: снимут сравнение хешей — здесь встанет CONFIRMED.
    expect(state.mode).toBe("STALE");
    expect(state.reason).toBe("PERSONA_DECISION_STALE");
  });

  it("фикстурный кейс проходит при любом из первых трёх состояний", () => {
    for (const decidedHashes of [[], [OTHER], [CURRENT]]) {
      expect(
        personaGateState({ isFixture: true, subjectInputHash: CURRENT, decidedHashes }).mode
      ).toBe("FIXTURE_BYPASS");
    }
  });

  it("пятого состояния у предиката нет: недоступность выставляет вызывающий", () => {
    const modes = new Set(
      [
        personaGateState({ isFixture: true, subjectInputHash: CURRENT, decidedHashes: [] }).mode,
        personaGateState({ isFixture: false, subjectInputHash: CURRENT, decidedHashes: [CURRENT] })
          .mode,
        personaGateState({ isFixture: false, subjectInputHash: CURRENT, decidedHashes: [OTHER] })
          .mode,
        personaGateState({ isFixture: false, subjectInputHash: CURRENT, decidedHashes: [] }).mode,
      ].map(String)
    );
    expect([...modes].sort()).toEqual(["CONFIRMED", "FIXTURE_BYPASS", "PENDING", "STALE"]);
  });
});
