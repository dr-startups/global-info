import { describe, expect, it } from "vitest";
import { buildRelatedQueriesFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/related";
import { buildSuggestionsFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/suggestions";
import {
  panelComposition,
  panelCompositionLine,
  panelRows,
  type FragmentExtras,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

/**
 * Приёмка: на панели десять подсказок, в описании рядом «показано 7»; на
 * панели две строки связанных запросов, в описании «показаны 3». Клиент
 * сверяет текст с картинкой, поэтому числа обязаны браться с картинки.
 */
function scopedSurface(
  surface: string,
  rows: Array<{ text: string; decision?: string }>
): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  rows.forEach((r, i) => {
    evidenceIndex[`inventory:s${i}`] = {
      title: r.text,
      domain: "yandex.ru",
      url: `https://yandex.ru/?q=${i}`,
      region: "RU",
      subjectDecision: r.decision,
    };
  });
  return {
    findings: [],
    surfaceUnits: [
      {
        surface,
        region: "RU",
        engine: "YANDEX",
        claims: [],
        metrics: [],
        evidenceRefs: rows.map((_, i) => `inventory:s${i}`),
      },
    ],
    evidenceIndex,
    scope: {},
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function extrasWithPanel(slotId: string, visible: Array<{ i: number; adverse?: boolean }>, titles: string[]): FragmentExtras {
  return {
    visualAssets: {
      [slotId]: [
        {
          assetRef: `${slotId}-panel`,
          kind: "surface_panel",
          visibleItems: visible.map((v) => ({
            ref: `inventory:s${v.i}`,
            title: titles[v.i],
            adverse: v.adverse === true,
          })),
        },
      ],
    },
  } as unknown as FragmentExtras;
}

describe("описание считает строки панели", () => {
  it("на панели три связанных запроса — в описании три, а не свой набор", () => {
    const titles = ["Где сейчас Фридман?", "Чем владеет Фридман?", "Кто такой Фридман?", "Дети Фридмана"];
    const scoped = scopedSurface(
      "paa_related",
      titles.map((t) => ({ text: t, decision: "SUBJECT_MATCH" }))
    );
    const extras = extrasWithPanel("p22_ru_related_3", [{ i: 0 }, { i: 1 }], titles);
    const { slides } = buildRelatedQueriesFragment("RU_RELATED", "RU_PROFILE", "Россия", scoped, extras);
    const page = slides.find((s) => s.slideId === "p22_ru_related_3")!;
    expect(page.content.bullets).toEqual(["Где сейчас Фридман?", "Чем владеет Фридман?"]);
    expect(page.content.whatWasFound).toContain("на панели — 2 связанных запроса");
    expect(page.content.whatWasFound).toContain("Собрано 4");
  });

  it("подсказки: показано столько, сколько нарисовано, с разбором по принадлежности", () => {
    const titles = [
      "фридман михаил маратович",
      "фридман михаил маратович биография",
      "фридман пётр иванович",
      "михаил фридман санкции",
    ];
    const scoped = scopedSurface("suggestions", [
      { text: titles[0]!, decision: "SUBJECT_MATCH" },
      { text: titles[1]!, decision: "SUBJECT_MATCH" },
      { text: titles[2]!, decision: "OTHER_SUBJECT" },
      { text: titles[3]!, decision: "SUBJECT_MATCH" },
    ]);
    const extras = extrasWithPanel(
      "p11_ru_suggestions_yandex",
      [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3, adverse: true }],
      titles
    );
    const { slides } = buildSuggestionsFragment("RU_SUGGESTIONS", "RU_PROFILE", "Россия", scoped, extras);
    const page = slides.find((s) => s.slideId === "p11_ru_suggestions_yandex")!;
    expect(page.content.bullets).toHaveLength(4);
    const said = page.content.whatWasFound ?? "";
    expect(said).toContain("На панели — 4 подсказки");
    expect(said).toContain("3 относятся к субъекту");
    expect(said).toContain("1 — о других лицах");
    expect(said).toContain("С негативной формулировкой — 1");
  });
});

describe("строки панели", () => {
  const scoped = scopedSurface("suggestions", [
    { text: "первая", decision: "SUBJECT_MATCH" },
    { text: "вторая", decision: "OTHER_SUBJECT" },
  ]);

  it("повтор строки на панели не удваивает счёт", () => {
    const extras = extrasWithPanel("slot", [{ i: 0 }, { i: 0 }, { i: 1 }], ["первая", "вторая"]);
    expect(panelRows("slot", extras, scoped)).toHaveLength(2);
  });

  it("без панели строк нет — и числа берутся из другого источника", () => {
    expect(panelRows("slot", {} as FragmentExtras, scoped)).toEqual([]);
  });
});

describe("формулировка состава", () => {
  it("без разбора по принадлежности не выдумывает «требуют уточнения»", () => {
    const line = panelCompositionLine({
      composition: panelComposition([
        { ref: "a", text: "a", adverse: false },
        { ref: "b", text: "b", adverse: false },
      ]),
      collected: 2,
      nounOne: "подсказка",
      nounFew: "подсказки",
      nounMany: "подсказок",
    });
    expect(line).toBe("На панели — 2 подсказки. Негативных формулировок нет.");
  });

  it("называет собранное отдельно, когда показано не всё", () => {
    const line = panelCompositionLine({
      composition: panelComposition([
        { ref: "a", text: "a", adverse: true, decision: "SUBJECT_MATCH" },
      ]),
      collected: 45,
      nounOne: "подсказка",
      nounFew: "подсказки",
      nounMany: "подсказок",
    });
    expect(line).toBe(
      "Собрано 45, на панели — 1 подсказка: 1 относится к субъекту. С негативной формулировкой — 1."
    );
  });
});

describe("негативные строки", () => {
  it("считаются по красной рамке панели, чтобы заголовок и текст не спорили", () => {
    const titles = ["иванов суд", "иванов интервью"];
    const scoped = scopedSurface("suggestions", [
      { text: titles[0]!, decision: "SUBJECT_MATCH" },
      { text: titles[1]!, decision: "SUBJECT_MATCH" },
    ]);
    // Панель ничего красным не выделила, хотя в тексте строки есть слово «суд».
    const extras = extrasWithPanel("p11_ru_suggestions_yandex", [{ i: 0 }, { i: 1 }], titles);
    const rows = panelRows("p11_ru_suggestions_yandex", extras, scoped);
    expect(rows.filter((r) => r.adverse)).toHaveLength(0);
  });
});
