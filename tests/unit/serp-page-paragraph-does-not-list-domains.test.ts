/**
 * Абзац страницы выдачи не перечисляет домены, а остальные поверхности — да.
 *
 * Полосы адресов под строками печатают домены этой страницы целиком и все, а
 * перечень в абзаце режется тремя элементами: на стр. 15 эталона он называл
 * три домена из четырёх, лежащих на листе, — страница противоречила
 * собственной таблице. Убирается перечень **только** со страницы выдачи:
 * у изображений, подсказок и панели знаний полос адресов нет, и без перечня
 * такая страница не скажет, откуда материал.
 */

import { describe, expect, it } from "vitest";
import {
  buildSerpFragment,
  serpTablePageProse,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  buildPageEvidenceView,
  composePageRowComposition,
  pageFindingBlocks,
  pageRowCompositionBlocks,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const QUERY = "Глинка Сергей Михайлович";
const THEME = "Криминальные / судебные материалы";
const DOMAIN = "kommersant.ru";

/** Три строки одной страницы выдачи; все с одного домена. */
function scopedRows(withFinding: boolean): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  for (const rank of [1, 2, 3]) {
    const ref = `i${rank}`;
    evidenceIndex[ref] = {
      title: `Материал ${rank}`,
      url: `https://${DOMAIN}/${rank}`,
      domain: DOMAIN,
      region: "RU",
      engine: "GOOGLE",
      rank,
      rankSource: "serper",
      query: QUERY,
      queryPurpose: "subject_lookup",
      subjectDecision: "SUBJECT_MATCH",
      adverse: true,
    };
    refs.push(ref);
  }
  return {
    findings: withFinding
      ? [
          {
            findingId: "f1",
            theme: THEME,
            subjectMatch: "SUBJECT_MATCH",
            claim: "«Тема»\n3 свидетельства.",
            riskLevel: "high",
            confidence: 0.9,
            promotionPriority: "P1",
            evidenceRefs: refs,
            recommendedAction: "Проверить актуальные статусы дел.",
          },
        ]
      : [],
    surfaceUnits: [
      { surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function serpPage(withFinding: boolean) {
  return buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scopedRows(withFinding)).slides[0]!;
}

describe("страница выдачи не называет домены абзацем", () => {
  it("в ветке с находкой печатает тему, ступень и свои строки, но не перечень", () => {
    const page = serpPage(true);
    // Опора темы — номера строк этого листа: домены с полосой адресов спорят,
    // номер строки — нет.
    expect(page.content.whatWasFound).toBe(
      `«${THEME}» — высокий уровень внимания (строки 1–3).`
    );
    expect(String(page.content.narrative ?? "")).not.toContain(
      "Материалы по теме на этой странице"
    );
  });

  it("в ветке описания состава строк не печатает преобладающих источников", () => {
    const page = serpPage(false);
    expect(String(page.content.whatWasFound ?? "")).not.toContain("преобладающие источники");
    expect(String(page.content.whatWasFound ?? "")).toContain("Показано 3 результата");
    expect(String(page.content.narrative ?? "")).not.toContain("преобладающие источники");
  });
});

describe("остальные поверхности домены называют по-прежнему", () => {
  // Изображения, подсказки, панель знаний и идентичность зовут те же
  // построители **двумя аргументами** — то есть получают состав по умолчанию.
  it("вывод по теме по умолчанию перечисляет домены страницы", () => {
    const scoped = scopedRows(true);
    const view = buildPageEvidenceView(scoped, ["i1", "i2", "i3"]);
    expect(pageFindingBlocks(scoped, view).whatWasFound).toBe(
      `«${THEME}» — высокий уровень внимания. Материалы по теме на этой странице — ${DOMAIN}.`
    );
  });

  it("описание состава строк по умолчанию перечисляет источники", () => {
    const scoped = scopedRows(false);
    const refs = ["i1", "i2", "i3"];
    const view = buildPageEvidenceView(scoped, refs);
    const blocks = pageRowCompositionBlocks(composePageRowComposition(scoped, refs), view);
    expect(String(blocks.whatWasFound ?? "")).toContain(`преобладающие источники: ${DOMAIN}`);
  });
});

describe("справка о наборе запросов", () => {
  it("не печатается, когда прогон шёл одним запросом и он же подписывает таблицу", () => {
    const prose = serpTablePageProse({
      engineLabel: "Google",
      query: QUERY,
      missing: "",
      positional: true,
      queriesLine: `Выдача проверена по 1 запросу: «${QUERY}».`,
      subjectQueries: [QUERY],
    });
    expect(prose.tail).toBeUndefined();
    // Оговорка про нумерацию печатается всегда — она и есть второе предложение.
    expect(prose.head).toBe(
      `Показана выдача Google по запросу «${QUERY}». ` +
        "Позиции — как их вернул поисковик; спецблоки (картинки, видео, новости) в нумерацию не входят."
    );
  });
});
