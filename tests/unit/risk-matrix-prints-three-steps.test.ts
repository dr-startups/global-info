/**
 * Матрица рисков печатает три ступени, а статус остаётся статусом.
 *
 * Уровень данных у находки по-прежнему четырёхступенчатый, и порядок задаёт
 * именно он: бывший `critical` стоит первым внутри «Высокого». На бумаге
 * ступеней три, а «Требует подтверждения» и «Нет данных» — не ступени: они
 * тональности не печатают.
 *
 * Словарь колонки «Уровень» закреплён списком: любое другое слово — включая
 * «Критический» — означает, что уровень стал словом мимо клиентской шкалы.
 */

import { describe, expect, it } from "vitest";
import { buildRiskMatrixFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/executive";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections";
import {
  buildPageEvidenceView,
  pageScopedConclusion,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

/** Слова, которые вообще может нести колонка «Уровень» клиентской матрицы. */
const ALLOWED_LEVEL_WORDS = new Set([
  "Высокий",
  "Средний",
  "Низкий",
  "Требует подтверждения",
  "Нет данных",
]);

function finding(over: Partial<Finding> & { findingId: string }): Finding {
  return {
    theme: `Тема ${over.findingId}`,
    subjectMatch: "SUBJECT_MATCH",
    claim: `«Тема ${over.findingId}»\n7 свидетельств (5 негативных) в источниках audit-it.ru, x.com.`,
    riskLevel: "high",
    promotionPriority: "P1",
    evidenceRefs: [`inventory:${over.findingId}`],
    recommendedAction: "Проверить статусы дел и первоисточники до принятия решений.",
    ...over,
  } as unknown as Finding;
}

function scopedWith(findings: Finding[], likelySubjectCount = 0): ScopedFragmentInput {
  return {
    subject: { displayName: "Тест", aliases: [] },
    findings,
    surfaceUnits: [],
    evidenceIndex: {},
    scope: {},
    metricSnapshot: {
      likelySubjectCount,
      compositeCount: 100,
      subjectMatchCount: 10,
      adverseFindingCount: 2,
      perRegionCounts: {},
    },
  } as unknown as ScopedFragmentInput;
}

/** Строки матрицы всех страниц: [тема, уровень, приоритет, идентификатор]. */
function rowsOf(findings: Finding[], likelySubjectCount = 0): string[][] {
  const { slides } = buildRiskMatrixFragment(
    "EXECUTIVE" as never,
    scopedWith(findings, likelySubjectCount)
  );
  return slides.flatMap((s) => s.content.table?.rows ?? []);
}

/** Карточки матрицы в том виде, в каком их получит рендерер. */
function cardsOf(findings: Finding[], likelySubjectCount = 0): Array<Record<string, string>> {
  const { slides } = buildRiskMatrixFragment(
    "EXECUTIVE" as never,
    scopedWith(findings, likelySubjectCount)
  );
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
  return finalSlides.flatMap(
    (s) => (s.keyFindings as Array<Record<string, string>> | undefined) ?? []
  );
}

describe("матрица рисков печатает три ступени", () => {
  it("находка уровня critical печатается «Высоким» и тоном danger", () => {
    const rows = rowsOf([finding({ findingId: "c1", riskLevel: "critical" })]);
    expect(rows.map((r) => r[1])).toEqual(["Высокий"]);
    expect(cardsOf([finding({ findingId: "c1", riskLevel: "critical" })])).toEqual([
      expect.objectContaining({ status: "Высокий", tone: "danger" }),
    ]);
  });

  it("подтверждённая тема без негатива печатается «Низким», а не «Нет»", () => {
    const rows = rowsOf([finding({ findingId: "n1", riskLevel: "none" })]);
    expect(rows.map((r) => r[1])).toEqual(["Низкий"]);
  });

  it("«Требует подтверждения» тональности не печатает", () => {
    const cards = cardsOf([finding({ findingId: "l1", subjectMatch: "LIKELY_SUBJECT", riskLevel: "critical" })], 3);
    const likely = cards.filter((c) => c.status === "Требует подтверждения");
    expect(likely.length).toBeGreaterThan(0);
    for (const card of likely) {
      expect(card.tone).toBe("warn");
      expect(`${card.status} ${card.detail ?? ""}`).not.toMatch(
        /Высокий|Средний|Низкий|Критический/
      );
    }
  });

  it("словарь колонки «Уровень» закрыт", () => {
    const findings = [
      finding({ findingId: "c1", riskLevel: "critical" }),
      finding({ findingId: "h1", riskLevel: "high" }),
      finding({ findingId: "m1", riskLevel: "medium" }),
      finding({ findingId: "lo1", riskLevel: "low" }),
      finding({ findingId: "n1", riskLevel: "none" }),
      finding({ findingId: "l1", subjectMatch: "LIKELY_SUBJECT", riskLevel: "low" }),
    ];
    for (const row of rowsOf(findings, 4)) {
      expect(ALLOWED_LEVEL_WORDS).toContain(row[1]);
    }
    for (const card of cardsOf(findings, 4)) {
      expect(ALLOWED_LEVEL_WORDS).toContain(card.status);
    }
    // Пустая матрица — тоже честный статус, а не ступень шкалы.
    for (const row of rowsOf([])) {
      expect(ALLOWED_LEVEL_WORDS).toContain(row[1]);
    }
  });
});

describe("порядок внутри «Высокого» задан уровнем данных", () => {
  it("бывший critical стоит первым на странице матрицы", () => {
    const rows = rowsOf([
      finding({ findingId: "h1", riskLevel: "high" }),
      finding({ findingId: "c1", riskLevel: "critical" }),
    ]);
    expect(rows.map((r) => [r[3], r[1]])).toEqual([
      ["c1", "Высокий"],
      ["h1", "Высокий"],
    ]);
  });

  it("тематический блок страницы называет ту же ступень и тот же порядок", () => {
    const scoped = {
      ...scopedWith([
        finding({ findingId: "h1", riskLevel: "high" }),
        finding({ findingId: "c1", riskLevel: "critical" }),
      ]),
      evidenceIndex: {
        "inventory:h1": { domain: "a.example", url: "https://a.example/1" },
        "inventory:c1": { domain: "b.example", url: "https://b.example/1" },
      },
    } as unknown as ScopedFragmentInput;
    const view = buildPageEvidenceView(scoped, ["inventory:h1", "inventory:c1"]);
    expect(view.findings.map((f) => f.findingId)).toEqual(["c1", "h1"]);
    for (const f of view.findings) {
      expect(pageScopedConclusion(f, view)).toContain("высокий уровень внимания");
    }
  });
});
