/**
 * Карточка «Материалы с вероятной принадлежностью» не указывает место, которого нет.
 *
 * Стр. 9 прогона 92 советовала «проверить принадлежность материалов с оценкой
 * «Вероятно» в выдаче и приложении». Приложения в той деке нет вовсе, а в
 * выдаче этих материалов почти нет: на 20 посчитанных наблюдений по всей деке
 * приходится **две** строки с оценкой «Вероятно» (`p09_ru_serp_table__cont2` и
 * `p26_uae_serp_table__extra2`). Рекомендация была неисполнима целиком, а не
 * наполовину, поэтому она называет исполнимое действие — запросить разбор, — и
 * честно говорит, что материалы учтены числом.
 *
 * Спящая фраза резюме («см. матрицу рисков и приложение») не напечаталась ни в
 * одной из трёх дек, но неправда в ней та же, и она тоже снята.
 */

import { describe, expect, it } from "vitest";
import {
  buildRiskMatrixFragment,
  composeExecutivePageStructure,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/executive";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { ExecutiveSummaryExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

/** Столько «вероятных» наблюдений посчитала дека прогона 92. */
const LIKELY = 20;

function scopedWithLikely(likelySubjectCount: number): ScopedFragmentInput {
  return {
    subject: { displayName: "Тест", aliases: [] },
    findings: [],
    surfaceUnits: [],
    evidenceIndex: {},
    scope: {},
    metricSnapshot: {
      likelySubjectCount,
      ambiguousCount: 0,
      compositeCount: 100,
      subjectMatchCount: 10,
      adverseFindingCount: 0,
      perRegionCounts: { RU: 100 },
    },
  } as unknown as ScopedFragmentInput;
}

function matrixText(likelySubjectCount: number): string {
  const { slides } = buildRiskMatrixFragment(
    "EXECUTIVE" as never,
    scopedWithLikely(likelySubjectCount)
  );
  return slides
    .flatMap((s) => [
      ...(s.content.bullets ?? []),
      ...(s.content.table?.rows ?? []).flat(),
      String(s.content.whatToCheck ?? ""),
    ])
    .join(" ");
}

describe("синтетическая карточка вероятных материалов", () => {
  it("сохраняет своё число", () => {
    expect(matrixText(LIKELY)).toContain(`${LIKELY} материалов`);
  });

  it("не называет приложение", () => {
    expect(matrixText(LIKELY)).not.toMatch(/приложени/iu);
  });

  it("просит поимённый разбор и говорит, что видно поимённо", () => {
    /*
     * «Учтены числом, но не перечислены» — абсолют, который дека опровергает:
     * материал с решением `LIKELY_SUBJECT` печатается строкой таблицы выдачи с
     * оценкой «Вероятно» (на прогоне 92 таких строк две при двадцати
     * посчитанных наблюдениях). Формулировка владельца от 02.09.2026 верна на
     * любом прогоне: часть видна поимённо, остальные — только числом.
     */
    expect(matrixText(LIKELY)).toContain(
      "Запросить поимённый разбор: в этом отчёте они учтены числом; " +
        "поимённо видны только те из них, что попали в таблицы выдачи с оценкой «Вероятно»."
    );
  });

  it("не утверждает, что материалы не перечислены вовсе", () => {
    expect(matrixText(LIKELY)).not.toMatch(/не перечислен/iu);
  });
});

describe("спящая фраза резюме", () => {
  const structure = (): ReturnType<typeof composeExecutivePageStructure> =>
    composeExecutivePageStructure(scopedWithLikely(LIKELY), {
      identityCaveats: [],
    } as unknown as ExecutiveSummaryExtras);

  it("оставляет число и адресует к матрице рисков", () => {
    expect(structure().narrativeParagraphs).toContain(
      `Материалы, требующие подтверждения: ${LIKELY} — см. матрицу рисков.`
    );
  });

  it("не называет приложение", () => {
    const all = [
      ...structure().narrativeParagraphs,
      ...structure().factCards,
      structure().recommendations,
    ].join(" ");
    expect(all).not.toMatch(/приложени/iu);
  });
});
