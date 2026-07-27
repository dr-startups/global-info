/**
 * PDF review 44 — phase H (ORION-level evidence essence) — offline acceptance.
 * - H.1: reject bare FIO / SEO-bio / truncated titles
 * - H.1: rank theme-relevant titles above weak adverse-first picks
 * - H.2: snippet / bucket fallback; honest gap without bare name quotes
 */

import { describe, expect, it } from "vitest";
import {
  buildClientFacingClaim,
  isWeakExampleTitle,
  pickClaimExamples,
  quoteForClaim,
  resolveExampleQuote,
  scoreExampleForTheme,
  type ThemeDef,
} from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { GPT_SLIDE_COPY_PROMPT_VERSION } from "../../src/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import { rejectWeakQuoteLines } from "../../src/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";

const financialTheme = {
  themeId: "financial_claims",
  label: "Финансовые претензии / долговые споры",
  keywords: /долг|debt|lawsuit|претенз|санкц|sanction|lending/iu,
  baseRisk: "high",
  recommendedAction: "Сверить обязательства.",
} as ThemeDef;

const criminalTheme = {
  themeId: "criminal_legal",
  label: "Криминальные / судебные материалы",
  keywords: /суд|court|contempt|арест|criminal/iu,
  baseRisk: "high",
  recommendedAction: "Проверить статусы дел.",
} as ThemeDef;

function item(partial: Partial<RawInventoryItem> & { title: string }): RawInventoryItem {
  return {
    inventoryId: partial.inventoryId ?? `id-${partial.title.slice(0, 12)}`,
    caseId: "c",
    reportRunId: "r",
    source: "test",
    provider: "test",
    region: "RU",
    collectedAt: "2026-01-01T00:00:00.000Z",
    evidenceType: "search_result",
    sourceUrl: partial.sourceUrl ?? "https://example.com/x",
    // title/snippet come from the spread below; listing them here as well made
    // the explicit values dead and tripped TS2783.
    ...partial,
  } as RawInventoryItem;
}

describe("H.1 — weak title gate", () => {
  it("flags bare FIO and SEO-bio without theme signal", () => {
    expect(isWeakExampleTitle("Oleg V Deripaska")).toBe(true);
    expect(isWeakExampleTitle("Олег Дерипаска")).toBe(true);
    expect(
      isWeakExampleTitle("Олег Дерипаска: биография предпринимателя, личная жизнь", {
        theme: criminalTheme,
      })
    ).toBe(true);
    expect(
      isWeakExampleTitle("Russian Oligarch Oleg Vladimirovich Deripaska and", {
        theme: criminalTheme,
      })
    ).toBe(true);
  });

  it("keeps substantive risk headlines", () => {
    expect(
      isWeakExampleTitle(
        "Deripaska and Allies Could Benefit From Sanctions Deal, Document Shows",
        { theme: financialTheme }
      )
    ).toBe(false);
    expect(
      isWeakExampleTitle(
        "Russian tycoon Deripaska cleared of contempt of court in London",
        { theme: criminalTheme }
      )
    ).toBe(false);
  });

  it("quoteForClaim skips unsafe mid-phrase cuts instead of dangling tails", () => {
    const q = quoteForClaim(
      "Russian Oligarch Oleg Vladimirovich Deripaska and more words here about sanctions",
      50
    );
    // No safe clause boundary under 50 chars → empty (caller picks another title).
    expect(q === "" || !/\band\s*$/iu.test(q)).toBe(true);
  });

  it("treats NYT topic hub titles as bare/weak", () => {
    expect(isWeakExampleTitle("Oleg V Deripaska - The New York Times")).toBe(true);
  });
});

describe("H.1/H.2 — rank and resolve quotes", () => {
  it("prefers theme-relevant title over bare adverse NYT name", () => {
    const bare = item({
      inventoryId: "bare",
      title: "Oleg V Deripaska",
      sourceUrl: "https://www.nytimes.com/topic/person/oleg-v-deripaska",
      snippet: "",
    });
    const strong = item({
      inventoryId: "strong",
      title: "Oleg Deripaska: VTB says it has stopped lending to sanctioned oligarch",
      sourceUrl: "https://www.cnbc.com/deripaska-vtb",
      snippet: "",
    });
    expect(scoreExampleForTheme(strong, financialTheme)).toBeGreaterThan(
      scoreExampleForTheme(bare, financialTheme)
    );
    const picked = pickClaimExamples([bare, strong], financialTheme, [bare, strong]);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.title).toMatch(/VTB|lending|sanctioned/i);
    expect(picked[0]!.domain).toContain("cnbc.com");
  });

  it("uses snippet when title is weak", () => {
    const row = item({
      title: "Олег Дерипаска",
      sourceUrl: "https://news.example.com/x",
      snippet:
        "Арбитражный иск о взыскании долга и неисполнении обязательств перед кредиторами на сумму 2 млрд рублей.",
    });
    const ex = resolveExampleQuote(row, financialTheme);
    expect(ex).not.toBeNull();
    expect(ex!.title).toMatch(/долг|иск|обязательств/iu);
  });

  it("buildClientFacingClaim drops bare FIO and adds Где видно domain line", () => {
    const claim = buildClientFacingClaim({
      theme: financialTheme,
      itemsCount: 6,
      adverseCount: 3,
      examples: [
        { title: "Oleg V Deripaska", domain: "nytimes.com" },
        {
          title: "Deripaska and Allies Could Benefit From Sanctions Deal, Document Shows",
          domain: "nytimes.com",
        },
      ],
      domains: ["nytimes.com", "cnbc.com"],
    });
    expect(claim).not.toMatch(/«Oleg V Deripaska»/u);
    expect(claim).not.toMatch(/\(в т\.ч\. материалы/u);
    expect(claim).toMatch(/Sanctions Deal|Allies Could Benefit/u);
    expect(claim).toMatch(/Где видно:.*nytimes\.com/u);
  });

  it("honest gap when no strong quotes remain", () => {
    const claim = buildClientFacingClaim({
      theme: financialTheme,
      itemsCount: 6,
      adverseCount: 3,
      examples: [{ title: "Oleg V Deripaska", domain: "nytimes.com" }],
      domains: ["nytimes.com"],
    });
    expect(claim).not.toMatch(/«Oleg V Deripaska»/u);
    expect(claim).toMatch(/не выделен|сверить первоисточники/u);
  });
});

describe("H.3 — GPT guard", () => {
  // См. pdf-review-phase-i: точная строка версии падала на любом подъёме
  // промпта. Охраняется невозврат назад, а не конкретное число.
  it("версия промпта slide-copy не откатывается назад", () => {
    const m = GPT_SLIDE_COPY_PROMPT_VERSION.match(/^gpt-slide-copy-v(\d+)$/u);
    expect(m, `неожиданный формат версии: ${GPT_SLIDE_COPY_PROMPT_VERSION}`).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(16);
  });

  it("rejectWeakQuoteLines catches bare FIO evidence quotes", () => {
    expect(
      rejectWeakQuoteLines(
        "«Финансовые претензии / долговые споры»\nНайдены публикации:\n«Oleg V Deripaska» — источник nytimes.com"
      )
    ).toMatch(/weak-quote/);
    expect(
      rejectWeakQuoteLines(
        "«Финансовые претензии / долговые споры»\n«VTB stopped lending to sanctioned oligarch» — источник cnbc.com"
      )
    ).toBeNull();
  });
});
