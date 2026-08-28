/**
 * В карточке матрицы стоит масштаб темы, а не ввод к цитатам.
 *
 * «В чём проблема» на карточке — это числа: сколько материалов и сколько из них
 * с негативным контекстом. Ввод к цитатам («Найдены материалы делового и
 * биографического профиля») повторяет заголовок карточки и вместе с
 * рекомендацией склеивается в строку без точки: «Найдены материалы делового и
 * биографического профиля Что делать: …».
 *
 * Прежде масштаб подставлялся только тогда, когда ввод оканчивался двоеточием,
 * — а перекладка абзаца двоеточие снимает, и достаточно было одной цитаты
 * вместо двух, чтобы карточка напечатала ввод.
 */

import { describe, expect, it } from "vitest";
import { buildRiskMatrixFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/executive";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const SCALE = "Всего по теме: 3 материала, с негативным контекстом — 1.";

function findingWith(claim: string): Finding {
  return {
    findingId: "finding-business_profile-subject_match-1",
    theme: "Деловой профиль",
    subjectMatch: "SUBJECT_MATCH",
    claim,
    riskLevel: "low",
    promotionPriority: "P3",
    evidenceRefs: ["inventory:1"],
    recommendedAction: "Поддерживать позитивный деловой контент.",
  } as unknown as Finding;
}

function cardDetail(claim: string): string {
  const { slides } = buildRiskMatrixFragment("EXECUTIVE" as never, {
    subject: { displayName: "Тест", aliases: [] },
    findings: [findingWith(claim)],
    surfaceUnits: [],
    evidenceIndex: {},
    scope: {},
    metricSnapshot: {
      likelySubjectCount: 0,
      compositeCount: 100,
      subjectMatchCount: 10,
      adverseFindingCount: 1,
      perRegionCounts: {},
    },
  } as unknown as ScopedFragmentInput);
  // Карточки появляются на сборке нагрузки — там же, где их увидит рендерер.
  const payload = toRendererPayload({
    deckManifest: {
      toc: [],
      sectionPageRanges: [{ sectionType: "EXECUTIVE", firstPage: 6, lastPage: 6 }],
    } as never,
    subjectName: "Тест",
    rendererSlides: slides.map(
      (s, i) =>
        ({
          slideKey: `p04_risk_dashboard_${i}`,
          sectionKey: "EXECUTIVE",
          template: "orion_golden_risk_matrix_grid",
          title: "Матрица комплаенс-рисков",
          pageNumber: 6 + i,
          totalPageCount: 48,
          baseSlotId: "p04_risk_dashboard",
          table: s.content.table,
          bullets: s.content.bullets,
          visualAssetRefs: [],
          evidenceRefs: [],
        }) as never
    ),
  });
  const finalSlides = (payload.deckManifest as { finalSlides: Array<Record<string, unknown>> })
    .finalSlides;
  const cards = finalSlides.flatMap(
    (s) => (s.keyFindings as Array<Record<string, string>> | undefined) ?? []
  );
  return String(cards[0]?.detail ?? "");
}

describe("карточка матрицы называет масштаб темы", () => {
  /** Претензия синтезатора ровно в том виде, в каком её строит `buildClientFacingClaim`. */
  const claimWith = (quotes: string[]) =>
    [
      "Найдены материалы делового и биографического профиля:",
      ...quotes,
      SCALE,
      "Где видно: finansbladet.se, svenskt-naringsliv-nytt.se.",
      "Деловой фон важен для позиционирования, но сам по себе не перекрывает чувствительные темы риска.",
    ].join("\n");

  const QUOTE_1 =
    "«Anders Holmström, CEO of Nordkap Capital AB — fintech investor profile» — источник (finansbladet.se/anders-holmstr-m-ceo-of-nordkap-capital-ab-finte-3)";
  const QUOTE_2 =
    "«Контекст: Anders Holmström, CEO of Nordkap Capital AB — fintech investor profile» — источник (svenskt-naringsliv-nytt.se/anders-holmstr-m-ceo-of-nordkap-capital-ab-finte-23)";

  it("с одной цитатой карточка печатает масштаб, а не ввод к цитатам", () => {
    const detail = cardDetail(claimWith([QUOTE_1]));
    expect(detail).toContain(SCALE);
    // Ввод без точки склеивался с рекомендацией в одну строку.
    expect(detail).not.toContain("профиля Что делать");
  });

  it("с двумя цитатами ответ тот же", () => {
    expect(cardDetail(claimWith([QUOTE_1, QUOTE_2]))).toContain(SCALE);
  });

  it("без строки масштаба карточка печатает то, что есть", () => {
    const detail = cardDetail("7 свидетельств в источниках audit-it.ru, x.com.");
    expect(detail).toContain("7 свидетельств");
  });
});
