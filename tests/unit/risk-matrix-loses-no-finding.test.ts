/**
 * Матрица рисков: вход равен сумме карточек всех страниц.
 *
 * На прогоне 72 страница 6 несла три темы в модели и две на бумаге: карточка
 * «PEP / RCA / watchlist-сигналы» не была нарисована нигде в деке, а все ворота
 * приёмки оставались зелёными. Отрисовку судит смок рендерера; здесь
 * закрепляется сторона модели — ни одна тема не исчезает между входом и
 * страницами, и на вопрос «сколько карточек на листе» отвечает одно место.
 */

import { describe, expect, it } from "vitest";
import {
  buildRiskMatrixFragment,
  packRiskMatrixPages,
  RISK_MATRIX_LIKELY_AGGREGATE_ID,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/executive";
import {
  DECK_TEMPLATE_REGISTRY,
  toRendererPayload,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const CAPACITY = DECK_TEMPLATE_REGISTRY["risk-matrix"].maxTableRowsPerSlide;

function finding(id: string, subjectMatch: "SUBJECT_MATCH" | "LIKELY_SUBJECT"): Finding {
  return {
    findingId: id,
    theme: `Тема ${id}`,
    subjectMatch,
    claim: `«Тема ${id}»\n7 свидетельств (5 негативных) в источниках audit-it.ru, x.com.\nПримеры: Заголовок один · Заголовок два`,
    riskLevel: subjectMatch === "SUBJECT_MATCH" ? "high" : "low",
    promotionPriority: "P1",
    evidenceRefs: [`inventory:${id}`],
    recommendedAction: "Проверить статусы дел и первоисточники до принятия решений.",
  } as unknown as Finding;
}

function scopedWith(findings: Finding[], likelySubjectCount = 0): ScopedFragmentInput {
  return {
    subject: { displayName: "Тест", aliases: [] },
    findings,
    surfaceUnits: [],
    evidenceIndex: {},
    scope: {},
    metricSnapshot: { likelySubjectCount },
  } as unknown as ScopedFragmentInput;
}

function confirmed(n: number): Finding[] {
  return Array.from({ length: n }, (_, i) => finding(`c${i + 1}`, "SUBJECT_MATCH"));
}

function likely(n: number): Finding[] {
  return Array.from({ length: n }, (_, i) => finding(`l${i + 1}`, "LIKELY_SUBJECT"));
}

/** Темы, разложенные построителем по страницам, — то, что увидит клиент. */
function pagesOf(findings: Finding[], likelySubjectCount = 0): string[][] {
  const { slides } = buildRiskMatrixFragment("EXECUTIVE" as never, scopedWith(findings, likelySubjectCount));
  return slides.map((s) => (s.content.table?.rows ?? []).map((r) => r[3] ?? ""));
}

describe("матрица рисков не теряет находок", () => {
  it("ни один findingId не пропадает при 0–12 подтверждённых × 0–3 вероятных", () => {
    for (let c = 0; c <= 12; c += 1) {
      for (let l = 0; l <= 3; l += 1) {
        const findings = [...confirmed(c), ...likely(l)];
        const { slides } = buildRiskMatrixFragment("EXECUTIVE" as never, scopedWith(findings));
        const drawn = slides.flatMap((s) => s.findingIds);
        expect(new Set(drawn), `подтверждённых ${c}, вероятных ${l}`).toEqual(
          new Set(findings.map((f) => f.findingId))
        );
        expect(drawn.length, `дубли при ${c}+${l}`).toBe(findings.length);
      }
    }
  });

  it("синтетический агрегат вероятных не попадает в findingIds", () => {
    const { slides } = buildRiskMatrixFragment("EXECUTIVE" as never, scopedWith(confirmed(4), 55));
    const drawn = slides.flatMap((s) => s.findingIds);
    expect(drawn).toEqual(["c1", "c2", "c3", "c4"]);
    expect(drawn).not.toContain(RISK_MATRIX_LIKELY_AGGREGATE_ID);
    // Строка агрегата на странице есть — из findingIds исключён только он сам.
    const rows = slides.flatMap((s) => s.content.table?.rows ?? []);
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r[3] === "сводка")).toEqual([
      ["Материалы с вероятной принадлежностью", "Требует подтверждения", "APPENDIX", "сводка"],
    ]);
  });

  it("пустая матрица остаётся одной честной страницей", () => {
    const { slides, emptyStateReason } = buildRiskMatrixFragment(
      "EXECUTIVE" as never,
      scopedWith([])
    );
    expect(slides).toHaveLength(1);
    expect(slides[0]!.subtitle).toBe("Недостаточно подтверждённых данных");
    expect(emptyStateReason).toBe("no-verified-findings");
  });
});

describe("на вопрос «сколько карточек на листе» отвечает реестр шаблонов", () => {
  it("packRiskMatrixPages по умолчанию берёт ёмкость из реестра", () => {
    expect(packRiskMatrixPages(confirmed(CAPACITY), [])).toHaveLength(1);
    expect(packRiskMatrixPages(confirmed(CAPACITY + 1), [])).toHaveLength(2);
  });

  it("маппинг в полезную нагрузку рендерера строки матрицы не режет", () => {
    const rows = Array.from({ length: CAPACITY + 2 }, (_, i) => [
      `Тема ${i + 1}`,
      "Высокий",
      "P1",
      `finding-${i + 1}`,
    ]);
    const payload = toRendererPayload({
      deckManifest: {
        toc: [],
        sectionPageRanges: [{ sectionType: "EXECUTIVE", firstPage: 6, lastPage: 6 }],
      } as never,
      subjectName: "Тест",
      rendererSlides: [
        {
          slideKey: "p04_risk_dashboard",
          sectionKey: "EXECUTIVE",
          template: "orion_golden_risk_matrix_grid",
          title: "Матрица комплаенс-рисков",
          pageNumber: 6,
          totalPageCount: 48,
          baseSlotId: "p04_risk_dashboard",
          table: { headers: ["Тема", "Уровень", "Приоритет", "Идентификатор"], rows },
          bullets: rows.map((r) => `${r[0]}: коротко.\nЧто делать: проверить.`),
          visualAssetRefs: [],
          evidenceRefs: [],
        } as never,
      ],
    });
    const slide = (payload.deckManifest as { finalSlides: Array<Record<string, unknown>> })
      .finalSlides[0]!;
    expect((slide.keyFindings as unknown[]).length).toBe(rows.length);
  });
});

describe("страниц матрицы столько, сколько нужно", () => {
  // Числа выражены через ёмкость реестра намеренно: тест закрепляет правило
  // раскладки, а не число, которое у ёмкости одно и объявлено в одном месте.
  it("страница набирается до ёмкости реестра", () => {
    expect(pagesOf(confirmed(CAPACITY)).map((p) => p.length)).toEqual([CAPACITY]);
  });

  it("одна лишняя тема не оставляет одинокий хвост", () => {
    expect(pagesOf(confirmed(CAPACITY + 1)).map((p) => p.length)).toEqual([CAPACITY - 1, 2]);
  });

  it("две полных страницы остаются полными", () => {
    expect(pagesOf(confirmed(2 * CAPACITY)).map((p) => p.length)).toEqual([CAPACITY, CAPACITY]);
  });

  it("две полных и одна лишняя дают [ёмкость, ёмкость−1, 2]", () => {
    expect(pagesOf(confirmed(2 * CAPACITY + 1)).map((p) => p.length)).toEqual([
      CAPACITY,
      CAPACITY - 1,
      2,
    ]);
  });

  it("состав золотого кейса делится без одинокого хвоста", () => {
    // Четыре подтверждённых плюс синтетический агрегат «вероятно об этом лице».
    expect(pagesOf(confirmed(4), 55).map((p) => p.length)).toEqual([3, 2]);
  });

  it("последняя страница никогда не остаётся с одной карточкой", () => {
    for (let n = 2; n <= 24; n += 1) {
      const sizes = pagesOf(confirmed(n)).map((p) => p.length);
      expect(sizes.at(-1), `тем ${n}: ${sizes.join(", ")}`).toBeGreaterThan(1);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  it("одинокой не остаётся ни одна страница — при любом составе с вероятными", () => {
    // Составы с LIKELY раскладываются другой веткой: у первой страницы есть
    // резерв. Правило хвоста обязано работать и там — и не создавать одинокую
    // страницу вместо одинокой (перенос с двухкарточной страницы делает ровно
    // это), и не задвигать подтверждённую тему за резервную.
    for (let c = 0; c <= 12; c += 1) {
      for (let l = 0; l <= 3; l += 1) {
        const total = c + l;
        if (total < 2) continue;
        const sizes = packRiskMatrixPages(confirmed(c), likely(l)).map((p) => p.length);
        const where = `подтверждённых ${c}, вероятных ${l}: [${sizes.join(", ")}]`;
        expect(Math.min(...sizes), where).toBeGreaterThan(1);
        expect(sizes.reduce((a, b) => a + b, 0), where).toBe(total);
      }
    }
  });

  it("две вероятных при одной подтверждённой умещаются на одну страницу", () => {
    expect(packRiskMatrixPages(confirmed(1), likely(2)).map((p) => p.length)).toEqual([3]);
  });

  it("две вероятных без подтверждённых умещаются на одну страницу", () => {
    expect(packRiskMatrixPages(confirmed(0), likely(2)).map((p) => p.length)).toEqual([2]);
  });

  it("при ёмкости в две карточки одинокий хвост остаётся, а не переезжает", () => {
    // Ёмкость задаётся реестром и сегодня равна четырём; двойка приходит сюда
    // только параметром. Проверка держит оговорку правила хвоста: переносить с
    // двухкарточной страницы нечего — одинокой стала бы она сама, то есть
    // правило сработало бы против себя. Одинокий хвост при такой ёмкости
    // неизбежен, и это видно здесь, а не выясняется потом на странице.
    const pages = packRiskMatrixPages(confirmed(3), [], 2);
    expect(pages.map((p) => p.length)).toEqual([2, 1]);
    expect(pages.flat().map((f) => f.findingId)).toEqual(["c1", "c2", "c3"]);
  });

  it("страница не остаётся полупустой, когда подтверждённых мало", () => {
    // Резерв держит слот под «Требует подтверждения», а не ограничивает лист:
    // при одной подтверждённой теме и шести вероятных первая страница обязана
    // набраться до ёмкости, а не встать на двух карточках.
    const pages = packRiskMatrixPages(confirmed(1), likely(6));
    expect(pages.map((p) => p.length)).toEqual([CAPACITY, 7 - CAPACITY]);
    expect(pages[0]![0]!.subjectMatch).toBe("SUBJECT_MATCH");
  });
});

describe("резерв первой страницы под «Требует подтверждения»", () => {
  it("вероятная тема не вытесняется полным набором подтверждённых", () => {
    const pages = packRiskMatrixPages(confirmed(6), likely(2));
    expect(pages[0]!.filter((f) => f.subjectMatch === "LIKELY_SUBJECT")).toHaveLength(1);
    expect(pages[0]!.filter((f) => f.subjectMatch === "SUBJECT_MATCH")).toHaveLength(CAPACITY - 1);
  });

  it("вероятная тема видна на первой странице при любом составе", () => {
    for (let c = 0; c <= 12; c += 1) {
      for (let l = 1; l <= 3; l += 1) {
        const pages = packRiskMatrixPages(confirmed(c), likely(l));
        expect(
          pages[0]!.some((f) => f.subjectMatch === "LIKELY_SUBJECT"),
          `подтверждённых ${c}, вероятных ${l}`
        ).toBe(true);
      }
    }
  });

  it("выравнивание хвоста переносит подтверждённую тему, а не резервную", () => {
    // Полная первая страница (ёмкость−1 подтверждённых + резерв) и одна тема
    // в хвосте — случай, ради которого правило и заведено.
    const pages = packRiskMatrixPages(confirmed(CAPACITY), likely(1));
    expect(pages.map((p) => p.length)).toEqual([CAPACITY - 1, 2]);
    expect(pages[0]!.some((f) => f.subjectMatch === "LIKELY_SUBJECT")).toBe(true);
    expect(pages[1]!.every((f) => f.subjectMatch === "SUBJECT_MATCH")).toBe(true);
  });
});
