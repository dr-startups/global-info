/**
 * Строка уровня внимания остаётся предложением, а не подстановкой.
 *
 * Слово ступени встроено в две фразы страниц выдачи. Схлопывание шкалы сделало
 * с ними две вещи: рядом с «достоверность оценки высокая» появился второй
 * «высокий» об одном и том же предложении, а фолбэк неизвестного уровня
 * («требует уточнения») встал на место прилагательного — «требует уточнения
 * уровень внимания». Обе фразы проверяются целиком, а не по подстроке.
 */

import { describe, expect, it } from "vitest";
import {
  buildPageEvidenceView,
  pageScopedConclusion,
  statusLine,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

function finding(riskLevel: string, confidence = 0.9): Finding {
  return {
    findingId: "f1",
    theme: "Криминальные / судебные материалы",
    subjectMatch: "SUBJECT_MATCH",
    claim: "«Тема»\n7 свидетельств (5 негативных).",
    riskLevel,
    confidence,
    promotionPriority: "P1",
    evidenceRefs: ["inventory:f1"],
    recommendedAction: "Проверить статусы дел.",
  } as unknown as Finding;
}

function viewFor(f: Finding) {
  const scoped = {
    subject: { displayName: "Тест", aliases: [] },
    findings: [f],
    surfaceUnits: [],
    scope: {},
    metricSnapshot: {},
    evidenceIndex: { "inventory:f1": { domain: "a.example", url: "https://a.example/1" } },
  } as unknown as ScopedFragmentInput;
  return buildPageEvidenceView(scoped, ["inventory:f1"]);
}

describe("строка статуса темы", () => {
  it("не повторяет одно слово о степени и о достоверности", () => {
    const line = statusLine(finding("high", 0.9));
    expect(line).toBe("Тема подтверждена, уровень внимания — высокий; оценка достоверна.");
  });

  it("средняя достоверность называется по-прежнему", () => {
    expect(statusLine(finding("medium", 0.7))).toBe(
      "Тема подтверждена, уровень внимания — средний; достоверность оценки уверенная."
    );
  });

  it("неизвестный уровень не встаёт прилагательным", () => {
    const line = statusLine(finding("HIGH", 0.9));
    expect(line).toBe("Тема подтверждена, уровень внимания требует уточнения; оценка достоверна.");
  });
});

describe("вывод по теме на странице", () => {
  it("называет ступень как прежде", () => {
    const f = finding("critical");
    expect(pageScopedConclusion(f, viewFor(f))).toContain(
      "«Криминальные / судебные материалы» — высокий уровень внимания."
    );
  });

  it("неизвестный уровень читается предложением", () => {
    const f = finding("HIGH");
    expect(pageScopedConclusion(f, viewFor(f))).toContain(
      "«Криминальные / судебные материалы» — уровень внимания требует уточнения."
    );
  });
});
