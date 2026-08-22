/**
 * Редактор деки не переписывает то, что написано детерминированно.
 *
 * На вопрос «переписывает ли модель этот пак» отвечали двое: признак фрагмента
 * (`prompt.deterministic`) и признак пака (`isComposedSummaryPack` — «текст уже
 * написан детерминированно, только признак не у фрагмента целиком, а у пака»).
 * Редактор деки знал только первый, поэтому пак резюме, который стадия 2 не
 * трогает намеренно, уходил модели целиком.
 *
 * Цена видна на живом отчёте 22.08 (кейс Кремлёв), стр. 3: одна и та же тема
 * названа дважды по-разному — «репутационные риски — судимости, обвинения и
 * санкции» в предложении вердикта и «Репутационные риски: судимости, обвинения
 * и санкции» в буллете ниже. Название темы приходит данными
 * (`link-verdicts.json`) и печатается ещё на странице «о чём публикации в
 * ТОП-20», в матрице и в «следующих проверках»; модель переписала одно
 * вхождение, и документ разошёлся сам с собой (пункт CW).
 *
 * Комментарий у `isComposedSummaryPack` это предсказывал: модель — «единственный
 * участник, способный подставить в резюме сюжет, которого нет в
 * `link-verdicts.json`: гарды стадии 2 сверяют домены и цитаты, а название темы
 * не закрепляют никак».
 */

import { describe, expect, it } from "vitest";
import { runGptDeckEditorPass } from "@/modules/digital-profile/orion-golden/deck-sections/gpt-deck-editor";
import { packRewriteBlock } from "@/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const EVIDENCE_INDEX = {
  "inventory:a": { domain: "di.se", title: "Tax probe", adverse: true },
} as never;
const okValidate = () => ({ passed: true, issues: [] });

/** Название темы приходит данными и печатается на нескольких страницах. */
const THEME_TITLE = "Репутационные риски: судимости, обвинения и санкции";

function pack(input: {
  fragmentKey: string;
  slideId: string;
  composedSummary?: boolean;
  narrative: string;
}): SectionPackV2 {
  return {
    schemaVersion: "section-pack-v3",
    sectionId: "EXECUTIVE",
    sectionType: "EXECUTIVE",
    fragmentKey: input.fragmentKey,
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-v113",
    promptVersion: "executive-summary-v4",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: ["f1"],
    evidenceRefs: ["inventory:a"],
    inputs: { findingIds: ["f1"], evidenceRefs: ["inventory:a"], metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: "slide-content-v1",
        slideId: input.slideId,
        baseSlotId: input.slideId,
        sectionId: "EXECUTIVE",
        fragmentKey: input.fragmentKey,
        templateId: "executive-summary",
        title: "Резюме",
        findingIds: ["f1"],
        evidenceRefs: ["inventory:a"],
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        visualAssetRefs: [],
        metrics: input.composedSummary ? { composedSummary: 1 } : {},
        content: { narrative: input.narrative },
      },
    ],
    metrics: {},
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: ["inventory:a"] },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

function composedSummaryPack(): SectionPackV2 {
  return pack({
    fragmentKey: "EXECUTIVE_SUMMARY",
    slideId: "p03_executive",
    composedSummary: true,
    narrative: `Итоговая оценка: высокий риск. Основные сюжеты в выдаче: ${THEME_TITLE}.`,
  });
}

function ordinaryPack(): SectionPackV2 {
  return pack({
    fragmentKey: "RU_SERP",
    slideId: "p10_ru_serp",
    narrative: "Черновой вывод по странице.",
  });
}

describe("пак составленного резюме модели не показывают", () => {
  it("его слайдов нет в полезной нагрузке вызова", async () => {
    const shown: string[] = [];
    await runGptDeckEditorPass({
      packs: [composedSummaryPack()],
      subject: { displayName: "Тестов Иван", aliases: [] },
      caller: async ({ userPayload }) => {
        const p = userPayload as { slides?: Array<{ slideId: string }> };
        shown.push(...(p.slides ?? []).map((s) => s.slideId));
        return { slides: [] };
      },
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });
    expect(shown).toEqual([]);
  });

  it("название темы остаётся дословным, что бы модель ни ответила", async () => {
    const out = await runGptDeckEditorPass({
      packs: [composedSummaryPack()],
      subject: { displayName: "Тестов Иван", aliases: [] },
      // Модель отвечает переименованной темой — ровно тем, что случилось на
      // живом отчёте. Пак обязан остаться байт в байт прежним.
      caller: async () => ({
        slides: [
          {
            slideId: "p03_executive",
            narrative:
              "Итоговая оценка: высокий риск. Основные темы в выдаче: репутационные риски — судимости, обвинения и санкции.",
          },
        ],
      }),
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });
    const narrative = String(out.packs[0]!.slides[0]!.content.narrative);
    expect(narrative).toContain(THEME_TITLE);
    expect(narrative).toContain("Основные сюжеты в выдаче");
  });

  it("обычный пак модель по-прежнему видит", async () => {
    // Проверка, не умеющая пропустить, ничего не проверяет: редактор должен
    // остаться рабочим на всех прочих фрагментах.
    const shown: string[] = [];
    await runGptDeckEditorPass({
      packs: [ordinaryPack()],
      subject: { displayName: "Тестов Иван", aliases: [] },
      caller: async ({ userPayload }) => {
        const p = userPayload as { slides?: Array<{ slideId: string }> };
        shown.push(...(p.slides ?? []).map((s) => s.slideId));
        return { slides: [] };
      },
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });
    expect(shown).toEqual(["p10_ru_serp"]);
  });
});

describe("один ответ на вопрос «переписывает ли модель этот пак»", () => {
  it("причина называется, а не выводится каждым по-своему", () => {
    expect(packRewriteBlock(composedSummaryPack())).toBe("composed-summary");
    expect(
      packRewriteBlock(
        pack({
          fragmentKey: "FRONT_MATTER_MAIN",
          slideId: "p01_cover",
          narrative: "Конфиденциально.",
        })
      )
    ).toBe("deterministic-fragment");
    expect(packRewriteBlock(ordinaryPack())).toBeNull();
  });

  it("пропуск виден в отчёте прогона, а не молчит", async () => {
    /*
     * За молчанием дефект и прятался: по артефакту редактора нельзя было
     * понять, что резюме вообще отдавалось модели.
     */
    const out = await runGptDeckEditorPass({
      packs: [composedSummaryPack(), ordinaryPack()],
      subject: { displayName: "Тестов Иван", aliases: [] },
      caller: async () => ({ slides: [] }),
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });
    expect(out.report.skippedFragments).toEqual([
      { fragmentKey: "EXECUTIVE_SUMMARY", reason: "composed-summary" },
    ]);
  });
});
