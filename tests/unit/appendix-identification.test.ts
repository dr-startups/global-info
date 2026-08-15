/**
 * Приложение не повторяет один заголовок трижды.
 *
 * Прогон 14.08: на странице «Приложение: материалы, требующие идентификации»
 * подряд стояли три блока с заголовком «Деловой профиль». Материалы там
 * разные — вероятное совпадение, однофамилец и неразобранное, — но читатель
 * видит повтор и решает, что отчёт собран шаблоном.
 *
 * Степень идентификации выносится в заголовок: и повтор исчезает, и страница
 * отвечает на вопрос, ради которого её открывают.
 */

import { describe, expect, it } from "vitest";
import {
  buildAppendixFragment,
  withIdentificationLabel,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/appendix";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

function finding(id: string, theme: string, subjectMatch: string) {
  return {
    findingId: id,
    theme,
    subjectMatch,
    claim: `«${theme}»\nНайдены материалы делового и биографического профиля:\nВсего по теме: 4 материала.`,
    riskLevel: "low",
    regions: ["RU"],
    evidenceRefs: [`inventory:${id}`],
    sourceDomains: ["ru.ruwiki.ru"],
  };
}

const scoped = {
  findings: [
    finding("f1", "Деловой профиль", "LIKELY_SUBJECT"),
    finding("f2", "Деловой профиль", "OTHER_SUBJECT"),
    finding("f3", "Деловой профиль", "AMBIGUOUS"),
    finding("f4", "PEP / RCA / watchlist-сигналы", "OTHER_SUBJECT"),
  ],
  surfaceUnits: [],
  evidenceIndex: {},
  scope: {},
  metricSnapshot: {},
} as unknown as ScopedFragmentInput;

describe("степень идентификации в заголовке приложения", () => {
  it("одинаковых заголовков подряд не остаётся", () => {
    const { slides } = buildAppendixFragment("APPENDIX", scoped);
    const heads = slides
      .flatMap((s) => s.content.bullets ?? [])
      .map((b) => b.split("\n")[0]!);
    expect(new Set(heads).size).toBe(heads.length);
    expect(heads.some((h) => h.includes("вероятно о субъекте"))).toBe(true);
    expect(heads.some((h) => h.includes("о другом лице"))).toBe(true);
    expect(heads.some((h) => h.includes("принадлежность не разобрана"))).toBe(true);
  });

  it("материалы одной темы идут подряд", () => {
    const { slides } = buildAppendixFragment("APPENDIX", scoped);
    const themes = slides
      .flatMap((s) => s.content.bullets ?? [])
      .map((b) => (b.match(/^«([^»]+)»/u) ?? [])[1]);
    // Тема не появляется второй раз после того, как сменилась.
    const seen = new Set<string>();
    let previous: string | undefined;
    for (const t of themes) {
      if (t !== previous) {
        expect(seen.has(t!), `${t} встретилась второй раз вразбивку`).toBe(false);
        seen.add(t!);
        previous = t;
      }
    }
  });

  it("подтверждённый субъект в приложение не попадает", () => {
    const only = { ...scoped, findings: [finding("f5", "Деловой профиль", "SUBJECT_MATCH")] };
    const out = buildAppendixFragment("APPENDIX", only as unknown as ScopedFragmentInput);
    expect(out.status).toBe("EMPTY_VALID");
  });

  it("незнакомую степень идентификации не выдумывает", () => {
    const claim = "«Тема»\nтекст";
    expect(withIdentificationLabel(claim, "СТРАННОЕ")).toBe(claim);
  });

  it("пометку второй раз не дописывает", () => {
    const once = withIdentificationLabel("«Тема»\nтекст", "OTHER_SUBJECT");
    expect(withIdentificationLabel(once, "OTHER_SUBJECT")).toBe(once);
  });
});
