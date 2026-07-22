/**
 * Stage 6 — semantic pagination for ComposedClientSummary.
 * NETWORK_CALLS=0.
 */

import { describe, expect, it } from "vitest";
import {
  assertSemanticSummaryGatesPass,
  packSentencesNoTruncate,
  paginateComposedClientSummary,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";
import {
  buildExecutiveSummaryFromComposed,
  fragmentScope,
} from "../../src/modules/digital-profile/orion-golden/deck-sections";
import { sampleComposedClientSummary } from "../../src/modules/digital-profile/orion-golden/contracts/sample-contracts";
import type { ComposedClientSummary } from "../../src/modules/digital-profile/orion-golden/contracts/composed-client-summary";
import type { ClientSummaryPack } from "../../src/modules/digital-profile/orion-golden/contracts/client-summary-pack";
import { sampleClientSummaryPack } from "../../src/modules/digital-profile/orion-golden/contracts/sample-contracts";
import { composeClientSummary } from "../../src/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import { getClientTextFieldBudgets } from "../../src/modules/digital-profile/orion-golden/client/load-client-text-contract";

function longThemeBody(title: string, sentences: number): string {
  const s = `${title}. В материале описывается сюжет с конкретными деталями и оговоркой об уровне доказанности.`;
  return Array.from({ length: sentences }, (_, i) =>
    i === 0 ? s : `Дополнительный тезис номер ${i + 1} завершает мысль полностью.`
  ).join(" ");
}

function multiThemeComposed(themeCount: number): ComposedClientSummary {
  const pack = sampleClientSummaryPack();
  const themeIds = [
    "corruption_integrity",
    "political_public_exposure",
    "sanctions_pep_rca_compliance",
    "criminal_judicial",
    "business_ownership_associates",
    "offshore_financial_transparency",
    "reputational_scandal",
    "family_personal_risk_relevant",
  ] as const;
  const multi: ClientSummaryPack = {
    ...pack,
    materialThemes: themeIds.slice(0, themeCount).map((themeId, i) => ({
      ...pack.materialThemes[0]!,
      themeId,
      clientTitle: `Тема риска ${i + 1}`,
      conclusion: `Вывод по теме ${i + 1} сформулирован полностью.`,
      representativeArticles: [
        {
          ...pack.materialThemes[0]!.representativeArticles[0]!,
          title: `Article ${i + 1}: Mixed RU/EN title «Проверка»`,
          domain: `news${i}.example`,
          conciseCompleteDescription: longThemeBody(`Тема риска ${i + 1}`, 3),
          evidenceRefs: [`inventory:obs-${i}`],
        },
      ],
      evidenceRefs: [`inventory:obs-${i}`],
      sourceDomains: [`news${i}.example`],
    })),
  };
  return composeClientSummary({ pack: multi });
}

const scoped = {
  subject: { displayName: "Тестов", aliases: [] as string[] },
  findings: [
    {
      findingId: "finding-criminal_legal-subject_match-a1",
      subjectMatch: "SUBJECT_MATCH" as const,
      promotionPriority: "P1" as const,
      riskLevel: "high" as const,
      claim: "claim",
      theme: "criminal",
      evidenceRefs: ["inventory:obs-1"],
    },
  ],
  surfaceUnits: [],
  metricSnapshot: {
    metricSnapshotId: "m1",
    datasetId: "d1",
    reportRunId: "r1",
    baseCount: 10,
    enrichmentCount: 0,
    compositeCount: 10,
    subjectMatchCount: 4,
    likelySubjectCount: 1,
    ambiguousCount: 0,
    otherSubjectCount: 0,
    adverseFindingCount: 2,
    perRegionCounts: { RU: 10 },
  },
  scope: fragmentScope("EXECUTIVE_SUMMARY"),
  evidenceIndex: {},
};

describe("semantic-summary-pagination Stage 6", () => {
  it("packSentencesNoTruncate never mid-cuts a sentence", () => {
    const text =
      "Первое предложение целиком. Второе тоже полное. Третье завершает блок.";
    const chunks = packSentencesNoTruncate(text, 40);
    for (const c of chunks) {
      expect(c).toMatch(/[.!?…]$/u);
      expect(c).not.toMatch(/\s(и|в|на|по|с)\s*$/iu);
    }
    expect(chunks.join(" ")).toContain("Первое предложение целиком.");
    expect(chunks.join(" ")).toContain("Третье завершает блок.");
  });

  it("long summary with all risk themes paginates without dropping blocks", () => {
    const composed = multiThemeComposed(8);
    const plan = paginateComposedClientSummary(composed, { leadThemeCount: 3 });
    assertSemanticSummaryGatesPass(plan);
    expect(plan.overviewBlocks.length).toBe(3);
    expect(plan.continuationPages.length).toBeGreaterThan(0);
    expect(plan.gates.CLIENT_TEXT_TRUNCATIONS).toBe(0);
    const allText = [
      ...plan.overviewNarrative,
      ...plan.overviewBlocks.map((b) => b.text),
      ...plan.continuationPages.flatMap((p) => p.map((b) => b.text)),
    ].join("\n");
    for (const t of composed.sections.themes) {
      expect(allText).toContain(t.heading);
    }
  });

  it("one very long theme splits into internal semantic parts without truncation", () => {
    const base = sampleComposedClientSummary();
    const longBody = longThemeBody("Коррупционные и этические риски", 40);
    expect(longBody.length).toBeGreaterThan(getClientTextFieldBudgets().bullet);
    const composed: ComposedClientSummary = {
      ...base,
      sections: {
        ...base.sections,
        themes: [
          {
            ...base.sections.themes[0]!,
            body: longBody,
            articleTitles: ["Very long article title about investigation and ethics"],
          },
        ],
      },
      fullText: longBody,
    };
    const plan = paginateComposedClientSummary(composed, { leadThemeCount: 1 });
    assertSemanticSummaryGatesPass(plan);
    const themeParts = [
      ...plan.overviewBlocks,
      ...plan.continuationPages.flat(),
    ].filter((b) => b.themeId === "corruption_integrity");
    expect(themeParts.length).toBeGreaterThan(1);
    expect(themeParts.map((b) => b.text).join(" ")).toContain(
      "Коррупционные и этические риски"
    );
    expect(plan.gates.CLIENT_TEXT_TRUNCATIONS).toBe(0);
  });

  it("mixed RU/EN article titles stay intact on slides", () => {
    const composed = multiThemeComposed(2);
    const out = buildExecutiveSummaryFromComposed(
      "EXECUTIVE",
      scoped as never,
      {
        executiveSummary: {
          verdict: "HIGH_RISK",
          executiveConclusion: "Итоговая оценка: высокий риск.",
          keyFindings: [
            {
              findingId: "finding-criminal_legal-subject_match-a1",
              title: "Криминал",
              factualBasis: "basis",
              clientImpact: "impact",
              recommendedAction: "action",
            },
          ],
          priorityActions: ["Проверить первоисточники."],
          identityCaveats: [],
          dataLimitations: [],
        },
        composedClientSummary: composed,
      },
      composed
    );
    expect(out.status).toBe("READY");
    const blob = out.slides.flatMap((s) => s.content.bullets ?? []).join("\n");
    expect(blob).toMatch(/Mixed RU\/EN|«Проверка»/u);
    expect(out.slides.some((s) => s.isContinuation)).toBe(true);
    // Continuations immediately follow base in the pack.
    for (let i = 1; i < out.slides.length; i += 1) {
      const s = out.slides[i]!;
      expect(s.isContinuation).toBe(true);
      expect(s.continuationOf).toBe(out.slides[0]!.slideId);
      expect(s.continuationIndex).toBe(i);
    }
    expect(out.slides[0]!.findingIds).toContain("finding-criminal_legal-subject_match-a1");
    expect(out.slides[0]!.metrics?.CLIENT_TEXT_TRUNCATIONS).toBe(0);
  });

  it("does not break sentences across overview/continuation pages", () => {
    const composed = multiThemeComposed(5);
    const out = buildExecutiveSummaryFromComposed(
      "EXECUTIVE",
      scoped as never,
      { composedClientSummary: composed },
      composed
    );
    const texts = out.slides.flatMap((s) => [
      s.content.narrative ?? "",
      ...(s.content.bullets ?? []),
    ]);
    for (const t of texts.filter(Boolean)) {
      for (const para of t.split("\n")) {
        if (!para.trim()) continue;
        expect(para.trim()).not.toMatch(
          /\s(?:и|в|во|на|по|с|со|о|об|and|or|of|the|to)\s*$/iu
        );
      }
    }
  });
});
