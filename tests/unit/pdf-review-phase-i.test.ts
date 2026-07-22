/**
 * PDF review 46 — phase I (fit without mid-cuts / footer bleed).
 * - I.1: Unicode dangling + SERP «…» titles rejected
 * - I.3: denser pagination (2 regional / 3 matrix / 3 exec cont)
 * - I.4: fitStructuredBullet keeps meta numbers whole
 */

import { describe, expect, it } from "vitest";
import {
  buildClientFacingClaim,
  hasDanglingTail,
  isWeakExampleTitle,
  quoteForClaim,
  type ThemeDef,
} from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { GPT_SLIDE_COPY_PROMPT_VERSION } from "../../src/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import { DECK_TEMPLATE_REGISTRY } from "../../src/modules/digital-profile/orion-golden/deck-sections/template-registry";
import { packRiskMatrixPages } from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/executive";
import { fitStructuredBullet } from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { Finding } from "../../src/modules/digital-profile/orion-golden/contracts/finding";

const politicalTheme = {
  themeId: "political_exposure",
  label: "Политические связи / публичная экспозиция",
  keywords: /полити|putin|navalny|рыбка|exposure/iu,
  baseRisk: "high",
  recommendedAction: "Проверить связи.",
} as ThemeDef;

describe("I.1 — Cyrillic dangling + SERP truncation", () => {
  it("detects Cyrillic hanging prepositions (\\b was broken)", () => {
    expect(hasDanglingTail("войну Путина в")).toBe(true);
    expect(hasDanglingTail("депутат из Красноярска: из-за")).toBe(true);
    expect(hasDanglingTail("visa over")).toBe(true);
    expect(hasDanglingTail("cleared of contempt of court in London")).toBe(false);
  });

  it("rejects provider-truncated SERP titles", () => {
    expect(
      isWeakExampleTitle("Рыбка, Навальный, Папа и депутат из Красноярска: из-за ...", {
        theme: politicalTheme,
      })
    ).toBe(true);
    expect(
      isWeakExampleTitle("Миллиардер Дерипаска назвал безумной войну Путина в ...", {
        theme: politicalTheme,
      })
    ).toBe(true);
    expect(quoteForClaim("Рыбка, Навальный, Папа и депутат из Красноярска: из-за ...")).toBe("");
  });

  it("buildClientFacingClaim uses at most one quote line", () => {
    const claim = buildClientFacingClaim({
      theme: politicalTheme,
      itemsCount: 14,
      adverseCount: 4,
      examples: [
        {
          title: "Oleg Deripaska: Putin 'favourite' with strong ties to UK politics",
          domain: "theguardian.com",
        },
        {
          title: "Deripaska and Allies Could Benefit From Sanctions Deal, Document Shows",
          domain: "nytimes.com",
        },
      ],
      domains: ["theguardian.com", "nytimes.com"],
    });
    const quotes = claim.split("\n").filter((l) => /— источник /u.test(l));
    expect(quotes).toHaveLength(1);
    expect(claim).toMatch(/Всего по теме: 14/u);
    expect(claim).toMatch(/негативным контекстом — 4/u);
  });
});

describe("I.3 — pagination density", () => {
  it("regional summary keeps 2 theme bullets per page", () => {
    expect(DECK_TEMPLATE_REGISTRY["regional-summary"].maxBulletsPerSlide).toBe(2);
  });

  it("risk matrix packs 3 cards per page", () => {
    const mk = (id: string): Finding =>
      ({
        findingId: id,
        theme: "t",
        claim: "c",
        subjectMatch: "SUBJECT_MATCH",
        riskLevel: "high",
        promotionPriority: "EXECUTIVE",
        evidenceRefs: [],
        recommendedAction: "x",
      }) as Finding;
    const pages = packRiskMatrixPages(
      [mk("a"), mk("b"), mk("c"), mk("d"), mk("e")],
      []
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(3);
    expect(pages[1]).toHaveLength(2);
  });

  it("continuation template caps theme bullets at 3", () => {
    expect(DECK_TEMPLATE_REGISTRY.continuation.maxBulletsPerSlide).toBe(3);
  });
});

describe("I.4 — structured fit preserves meta", () => {
  it("does not mid-cut «контекстом — N» when over budget", () => {
    const body = [
      "«Финансовые претензии / долговые споры»",
      "Найдены публикации о финансовых претензиях:",
      "«Why Oleg Deripaska is suing the US Treasury department» — источник cnbc.com",
      "«Russian billionaire Oleg Deripaska goes on the record» — источник youtube.com",
      "Всего по теме: 6 материалов, с негативным контекстом — 3.",
      "Где видно: cnbc.com, youtube.com.",
      "Банки и инвесторы обычно запрашивают статус обязательств и судебные справки.",
    ].join("\n");
    const fitted = fitStructuredBullet(body, 280);
    expect(fitted).not.toMatch(/контекстом\s+[—–-]\s*\.?$/u);
    expect(fitted).not.toMatch(/Всего по теме:\s*\.?$/u);
    if (/Всего по теме:/u.test(fitted)) {
      expect(fitted).toMatch(/Всего по теме: 6 материалов/u);
    }
  });

  it("drops dangling quote lines entirely", () => {
    const fitted = fitStructuredBullet(
      [
        "«Политические связи»",
        "Найдены материалы:",
        "«Рыбка, Навальный, Папа и депутат из Красноярска: из-за» — источник currenttime.tv",
        "Всего по теме: 14 материалов.",
      ].join("\n"),
      900
    );
    expect(fitted).not.toMatch(/из-за»/u);
  });
});

describe("I.5 — versions", () => {
  it("bumps GPT slide-copy prompt", () => {
    expect(GPT_SLIDE_COPY_PROMPT_VERSION).toBe("gpt-slide-copy-v13");
  });
});
