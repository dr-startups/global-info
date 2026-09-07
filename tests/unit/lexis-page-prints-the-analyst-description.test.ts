/**
 * Страница LexisNexis со снимком печатает слова аналитика и происхождение.
 *
 * Просьба владельца: «в блок Lexis Nexis мы будем добавлять скриншот реального
 * отчёта из Lexis Nexis и руками его описывать». Описание ложится в те же три
 * поля, которые сайдбар печатает и без снимка, — новых мест для клиентского
 * текста не заводится.
 *
 * Под снимком стоит происхождение: «Отчёт LexisNexis от <дата отчёта>». Имени
 * аналитика там нет — пометок о правках аналитика в отчёте нет вовсе (решение
 * владельца 6), — но у напечатанного текста обязан быть источник, и им
 * назван документ.
 *
 * Снимка нет — страница печатается как сегодня (решение владельца 8).
 */

import { describe, expect, it } from "vitest";
import { buildComplianceFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/compliance";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const SLOT = "p35_lexis_visual";

const DESCRIPTION = {
  whatItShows: "Карточка профиля в LexisNexis: две публикации о судебном споре 2021 года.",
  whyItMatters: "Публикации связывают проверяемое лицо с судебным сюжетом и требуют проверки.",
  whatToDo: "Запросить первоисточники публикаций и полную карточку записи со связанными лицами.",
};

function scoped(): ScopedFragmentInput {
  return {
    findings: [],
    surfaceUnits: [],
    evidenceIndex: {},
    scope: {},
    subject: { displayName: "Егоров Алексей Евгеньевич" },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function extrasWithVisual(): FragmentExtras {
  return {
    visualAssets: {
      [SLOT]: [
        {
          assetRef: "lexisnexis_report_1",
          kind: "compliance_visual_page",
          title: "LexisNexis — страница профиля",
          hasImage: true,
          visibleItems: [],
          analystDescription: DESCRIPTION,
          sourceLine: "Отчёт LexisNexis от 14.08.2026",
        },
      ],
    },
  } as unknown as FragmentExtras;
}

function lexisSlide(extras: FragmentExtras) {
  return buildComplianceFragment("COMPLIANCE", scoped(), extras).slides.find(
    (s) => s.slideId === SLOT
  )!;
}

describe("страница LexisNexis со снимком", () => {
  it("печатает описание аналитика тремя полями сайдбара", () => {
    const slide = lexisSlide(extrasWithVisual());
    expect(slide.content.whatWasFound).toBe(DESCRIPTION.whatItShows);
    expect(slide.content.whyItMatters).toBe(DESCRIPTION.whyItMatters);
    expect(slide.content.whatToCheck).toBe(DESCRIPTION.whatToDo);
  });

  it("под снимком стоит происхождение документом, а не сотрудником", () => {
    const slide = lexisSlide(extrasWithVisual());
    expect(slide.content.sourceNote).toContain("Отчёт LexisNexis от 14.08.2026");
    expect(String(slide.content.sourceNote ?? "")).not.toMatch(/аналитик/iu);
  });

  it("сам снимок привязан к странице", () => {
    const slide = lexisSlide(extrasWithVisual());
    expect(slide.visualAssetRefs).toContain("lexisnexis_report_1");
  });

  it("снимка нет — страница печатается как прежде", () => {
    const slide = lexisSlide({ visualAssets: {} } as unknown as FragmentExtras);
    expect(slide.visualAssetRefs ?? []).toHaveLength(0);
    expect(String(slide.content.narrative ?? "")).toContain("LexisNexis");
    expect(slide.content.whatWasFound).not.toBe(DESCRIPTION.whatItShows);
  });
});
