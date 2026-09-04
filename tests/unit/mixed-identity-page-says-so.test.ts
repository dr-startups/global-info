import { describe, expect, it } from "vitest";
import {
  composePageRowComposition,
  pageRowCompositionBlocks,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

/**
 * Страница, где рядом стоят признаки двух разных людей, так и говорит.
 *
 * Нейро-ответ прогона DPA-2026-0049 сам оговорился, что «возможно, имелись в
 * виду разные люди», — а сайдбар отчёта под ним печатал «из них о субъекте — 6».
 * Число не ложь, но читается оно как подтверждение, которого разметка не давала.
 */

const scoped = (index: Record<string, { subjectDecision?: string; subjectReason?: string }>) =>
  ({ evidenceIndex: index }) as unknown as ScopedFragmentInput;

describe("страница со смешанными признаками", () => {
  it("считает строки, где признаки разных людей стоят рядом", () => {
    const composition = composePageRowComposition(
      scoped({
        a: { subjectDecision: "SUBJECT_MATCH" },
        b: { subjectDecision: "AMBIGUOUS", subjectReason: "mixed_identity_signals" },
      }),
      ["a", "b"]
    );
    expect(composition.mixedIdentity).toBe(1);
    expect(composition.subjectMatch).toBe(1);
  });

  it("говорит об этом первым, раньше негативного фона", () => {
    const blocks = pageRowCompositionBlocks(
      {
        shown: 2,
        subjectMatch: 1,
        likelySubject: 0,
        adverseHeadlines: 1,
        mixedIdentity: 1,
        topDomains: [],
      },
      { refs: [], domains: [] } as never
    );
    expect(String(blocks.whyItMatters)).toContain("разных людях");
  });

  it("смешанных строк нет — прежний текст слово в слово", () => {
    const blocks = pageRowCompositionBlocks(
      {
        shown: 2,
        subjectMatch: 1,
        likelySubject: 0,
        adverseHeadlines: 1,
        mixedIdentity: 0,
        topDomains: [],
      },
      { refs: [], domains: [] } as never
    );
    expect(String(blocks.whyItMatters)).toContain("негативные заголовки");
    expect(String(blocks.whyItMatters)).not.toContain("разных людях");
  });
});
