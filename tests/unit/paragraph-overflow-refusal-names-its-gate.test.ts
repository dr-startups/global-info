/**
 * Отказ, который повтор не лечит, называет себя гейтом.
 *
 * Вопрос «лечится ли отказ подготовки повтором» в проекте один, и ответ на
 * него один — `DETERMINISTIC_GATES` и маркер `<ГЕЙТ>=` в тексте отказа. Абзац,
 * не влезший в лист, и текст, выброшенный резаком, — чистые функции от
 * составного набора: те же паки дают тот же текст и ту же длину, поэтому
 * второй заход по определению получит то же самое.
 *
 * Различать при этом нужно **отказы**, а не код: `ASSEMBLY_QA_FAILED` выдают
 * два места разной природы, и второе — ворота сборки — читает текст модели,
 * где повтор законен. Маркер ставит только перевод отказа сборки; ворота
 * сборки своих слов не метят и остаются возобновляемыми.
 *
 * Модуль чистый: ни сети, ни базы, ни файлов.
 */

import { describe, expect, it } from "vitest";
import {
  deterministicGateOf,
  isDeterministicPrepareGate,
  prepareGateAdvice,
  prepareGateFailureMessage,
} from "@/modules/digital-profile/services/prepare-gate-advice";
import { prepareBlockedErrorFor } from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  NarrativeOverBudgetError,
  NarrativeReflowLossError,
} from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { blockingIssues } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";

/** Ровно тот отказ, на котором встали два оплаченных прогона владельца. */
const OVER_BUDGET = new NarrativeOverBudgetError([
  { slideKey: "p13_ru_wikipedia", templateId: "wikipedia-check", length: 1013, budget: 998 },
  { slideKey: "p29_uae_wikipedia", templateId: "wikipedia-check", length: 1101, budget: 998 },
]);

const REFLOW_LOSS = new NarrativeReflowLossError([
  { slideKey: "p03_persona", before: 403, after: 344 },
]);

describe("отказ переполнения абзаца — детерминированный гейт", () => {
  it("называет себя маркером с числом листов", () => {
    const blocked = prepareBlockedErrorFor(OVER_BUDGET);

    expect(blocked?.message).toContain("NARRATIVE_OVER_BUDGET=2");
    expect(deterministicGateOf(blocked?.message)).toBe("NARRATIVE_OVER_BUDGET");
    expect(isDeterministicPrepareGate(blocked?.message)).toBe(true);
  });

  it("прежний код и прежний текст отказа сохранены", () => {
    // Маркер добавляется к сообщению, а не заменяет его: по тексту ищут в
    // журнале, а по коду решает восстановление.
    const blocked = prepareBlockedErrorFor(OVER_BUDGET);

    expect(blocked?.code).toBe("ASSEMBLY_QA_FAILED");
    expect(blocked?.message).toContain("narrative over template budget");
    expect(blocked?.message).toContain("p13_ru_wikipedia [wikipedia-check] 1013>998");
    expect(blocked?.message).toContain("p29_uae_wikipedia [wikipedia-check] 1101>998");
  });

  it("потеря резака абзацев — тот же ответ, своим именем", () => {
    const blocked = prepareBlockedErrorFor(REFLOW_LOSS);

    expect(blocked?.message).toContain("NARRATIVE_REFLOW_LOSS=1");
    expect(deterministicGateOf(blocked?.message)).toBe("NARRATIVE_REFLOW_LOSS");
    expect(blocked?.code).toBe("ASSEMBLY_QA_FAILED");
    expect(blocked?.message).toContain("narrative reflow dropped text: p03_persona 403->344");
  });

  it("маркер переживает обёртку для оператора", () => {
    // Кнопку восстановления считают из `job.lastError`, а туда сообщение
    // попадает уже через `prepareGateFailureMessage`. Технический текст этот
    // контракт сохраняет в скобках — вместе с маркером.
    const blocked = prepareBlockedErrorFor(OVER_BUDGET);

    expect(isDeterministicPrepareGate(prepareGateFailureMessage(blocked?.message))).toBe(true);
  });
});

describe("ворота сборки тем же кодом остаются обычным отказом", () => {
  it("их собственные слова маркера не несут", () => {
    // Слова берутся у самих ворот, а не сочиняются здесь: сообщение
    // подготовки — это `качество сборки: <строки ворот>`.
    const blocking = blockingIssues({
      quoteDefectSlides: new Set(),
      codeSlides: new Set(),
      repeatedTextSlides: new Set(["p13_ru_wikipedia"]),
    });
    expect(blocking.length).toBeGreaterThan(0);

    const message = `качество сборки: ${blocking.join("; ")}`;

    expect(deterministicGateOf(message)).toBeNull();
    expect(isDeterministicPrepareGate(message)).toBe(false);
  });

  it("чужая ошибка гейтом не становится", () => {
    expect(prepareBlockedErrorFor(new Error("boom"))).toBeNull();
    expect(isDeterministicPrepareGate("render failed: renderer returned 502")).toBe(false);
  });

  it("имя гейта без «=» упоминанием и остаётся", () => {
    // Свойство модуля, распространённое на новые имена: гейт называет себя
    // значением, а пересказ в свободном тексте решением не является.
    expect(isDeterministicPrepareGate("см. NARRATIVE_OVER_BUDGET в документации")).toBe(false);
    expect(isDeterministicPrepareGate("NARRATIVE_REFLOW_LOSS — про резак абзацев")).toBe(false);
  });
});

/*
 * Оператору отказ объясняется словами, и место для этого в проекте одно —
 * `prepareGateAdvice`. Без ветки под новые имена в панель уезжает машинный
 * маркер первой строкой, то есть хуже, чем было до шага.
 */
describe("причина названа словами, а не маркером", () => {
  it("переполнение абзаца: что случилось, что цело и что делать", () => {
    const shown = prepareGateFailureMessage(prepareBlockedErrorFor(OVER_BUDGET)?.message);

    expect(shown.startsWith("Отчёт не собрался")).toBe(true);
    expect(shown).toContain("p13_ru_wikipedia");
    expect(shown).toContain("Собранные данные целы");
    expect(shown).toContain("платить за сбор заново не нужно");
    expect(shown).toContain("Пересобрать отчёт");
  });

  it("технический текст сохранён, но идёт после объяснения и в скобках", () => {
    // По нему ищут в диагностике — это контракт функции, а не недосмотр.
    const shown = prepareGateFailureMessage(prepareBlockedErrorFor(OVER_BUDGET)?.message);

    expect(shown).toMatch(/\(NARRATIVE_OVER_BUDGET=2 narrative over template budget: [^)]+\)$/u);
    expect(shown.indexOf("Отчёт не собрался")).toBeLessThan(
      shown.indexOf("narrative over template budget")
    );
  });

  it("потеря резака объясняется своей строкой и называет свою страницу", () => {
    const shown = prepareGateFailureMessage(prepareBlockedErrorFor(REFLOW_LOSS)?.message);

    expect(shown.startsWith("Отчёт не собрался")).toBe(true);
    expect(shown).toContain("p03_persona");
    expect(shown).toContain("Пересобрать отчёт");
  });

  it("совет соседних гейтов не тронут", () => {
    // Контроль: ветки добавлены рядом, а не поверх.
    expect(prepareGateAdvice("MATERIAL_THEME_COVERAGE=87.5")).toContain("Повтор сборки это не изменит");
    expect(prepareGateAdvice("качество сборки: страница печатает текст дважды")).toBeNull();
  });
});
