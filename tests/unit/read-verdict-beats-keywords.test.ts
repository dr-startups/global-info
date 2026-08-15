/**
 * Тема повышенного внимания не цитирует страницу, признанную нейтральной.
 *
 * Тему материалу назначает словарь ключевых слов — по заголовку. Слово «суд» в
 * заголовке телеинтервью тянет его в криминальный блок, и клиент читает
 * интервью как доказательство судебного сюжета. Решение же вынесено по тексту
 * страницы: она прочитана, разобрана моделью и признана нейтральной. Оно и
 * решает, что можно цитировать.
 *
 * Непрочитанной страницы правило не касается: там словарь — всё, что есть.
 */

import { describe, expect, it } from "vitest";
import { localizedThemedClaim } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

const FINDING = {
  findingId: "finding-criminal_legal-subject_match-test",
  theme: "Криминальные / судебные материалы",
  claim:
    "Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами:\nВсего по теме: 2 материала.",
  riskLevel: "high",
  regions: ["RU", "UAE"],
  evidenceRefs: ["inventory:read-neutral", "inventory:read-adverse"],
  sourceDomains: ["tv.example", "news.example"],
} as unknown as Finding;

function scoped(
  tones: Record<string, "adverse" | "neutral" | "supportive" | undefined>
): ScopedFragmentInput {
  return {
    findings: [FINDING],
    surfaceUnits: [],
    evidenceIndex: {
      "inventory:read-neutral": {
        title: "Тимати в суде дал интервью о новом альбоме и планах на тур",
        domain: "tv.example",
        region: "RU",
        readVerdictTone: tones["inventory:read-neutral"],
      },
      "inventory:read-adverse": {
        title: "Суд по иску о взыскании 72 млн рублей с предпринимателя",
        domain: "news.example",
        region: "RU",
        readVerdictTone: tones["inventory:read-adverse"],
      },
    },
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

describe("вердикт прочитанной страницы сильнее словаря", () => {
  it("нейтральная страница не цитируется в теме повышенного внимания", () => {
    const claim = localizedThemedClaim(
      FINDING,
      scoped({ "inventory:read-neutral": "neutral", "inventory:read-adverse": "adverse" })
    );
    expect(claim).not.toContain("дал интервью о новом альбоме");
    expect(claim).toContain("Суд по иску о взыскании 72 млн рублей");
  });

  it("поддерживающая страница тоже не цитируется", () => {
    const claim = localizedThemedClaim(
      FINDING,
      scoped({ "inventory:read-neutral": "supportive", "inventory:read-adverse": "adverse" })
    );
    expect(claim).not.toContain("дал интервью о новом альбоме");
  });

  it("непрочитанная страница остаётся доказательством: словарь — всё, что есть", () => {
    const claim = localizedThemedClaim(
      FINDING,
      scoped({ "inventory:read-neutral": undefined, "inventory:read-adverse": undefined })
    );
    expect(claim).toContain("дал интервью о новом альбоме");
  });

  it("тема без повышенного внимания вердиктом не ограничивается", () => {
    // Деловой профиль не обвиняет ни в чём: там нейтральная страница уместна.
    const business = { ...FINDING, theme: "Деловой профиль", riskLevel: "low" } as Finding;
    const claim = localizedThemedClaim(
      business,
      scoped({ "inventory:read-neutral": "neutral", "inventory:read-adverse": "neutral" })
    );
    expect(claim).toContain("дал интервью о новом альбоме");
  });
});
