/**
 * Тема на странице выдачи названа вместе со своей опорой — номерами строк.
 *
 * На стр. 22 отчёта Кремлёва абзац объявлял тему «Офшоры / корпоративное
 * владение», а какая из четырёх напечатанных строк её несёт, не сообщал: домены
 * из абзаца убраны намеренно (их печатают полосы адресов под строками), и после
 * этого от вывода остался ярлык без опоры. Номер строки с полосой адресов не
 * спорит: он указывает на строку этого же листа.
 *
 * Обратная сторона того же правила: тема, которой на листе не соответствует ни
 * одна напечатанная строка, не печатается вовсе — вместо неё страница описывает
 * свой состав.
 */

import { describe, expect, it } from "vitest";
import { buildSerpFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  buildPageEvidenceView,
  pageFindingBlocks,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const QUERY = "Глинка Сергей Михайлович";
const THEME = "Офшоры / корпоративное владение";

/** Страница выдачи из `ranks` строк; тему поддерживают строки `supporting`. */
function scopedRows(ranks: number[], supporting: number[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  for (const rank of ranks) {
    const ref = `i${rank}`;
    evidenceIndex[ref] = {
      title: `Материал ${rank}`,
      url: `https://site${rank}.example/${rank}`,
      domain: `site${rank}.example`,
      region: "RU",
      engine: "GOOGLE",
      rank,
      rankSource: "serper",
      query: QUERY,
      queryPurpose: "subject_lookup",
      subjectDecision: "SUBJECT_MATCH",
    };
    refs.push(ref);
  }
  return {
    findings: [
      {
        findingId: "f1",
        theme: THEME,
        subjectMatch: "SUBJECT_MATCH",
        claim: "«Тема»\nВсего по теме: 2 материала.",
        riskLevel: "medium",
        confidence: 0.9,
        promotionPriority: "P2",
        regions: ["RU"],
        evidenceRefs: supporting.map((r) => `i${r}`),
        recommendedAction: "Проверить корпоративные реестры.",
      },
    ],
    surfaceUnits: [
      { surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function serpPages(ranks: number[], supporting: number[]) {
  return buildSerpFragment(
    "RU_SERP",
    "RU_PROFILE",
    "Россия",
    scopedRows(ranks, supporting)
  ).slides.filter((s) => s.templateId === "serp-table");
}

describe("тема страницы выдачи называет свои строки", () => {
  it("одна поддерживающая строка названа номером", () => {
    const page = serpPages([1, 2, 3, 4], [2])[0]!;
    expect(page.content.whatWasFound).toBe(
      `«${THEME}» — средний уровень внимания (строка 2).`
    );
    // Абзац несёт ту же опору: его и читает клиент над таблицей.
    expect(String(page.content.narrative ?? "")).toContain("(строка 2)");
  });

  it("несмежные строки названы через запятую", () => {
    const page = serpPages([1, 2, 3, 4], [2, 4])[0]!;
    expect(page.content.whatWasFound).toBe(
      `«${THEME}» — средний уровень внимания (строки 2, 4).`
    );
  });

  it("смежные строки называются диапазоном, а не перечислением", () => {
    // Опора — самая дорогая часть абзаца по ширине, а лист выдачи стоит у
    // кромки кегля: перечисление всех номеров съедало вдвое больше места, чем
    // диапазон, и роняло страницу на девятку при соседних листах 11 pt.
    const page = serpPages([1, 2, 3, 4], [2, 3])[0]!;
    expect(page.content.whatWasFound).toBe(
      `«${THEME}» — средний уровень внимания (строки 2–3).`
    );
  });

  it("страница целиком названа одним диапазоном", () => {
    const page = serpPages([1, 2, 3, 4], [1, 2, 3, 4])[0]!;
    expect(page.content.whatWasFound).toBe(
      `«${THEME}» — средний уровень внимания (строки 1–4).`
    );
  });

  it("перечень доменов в абзац по-прежнему не возвращается", () => {
    const page = serpPages([1, 2, 3, 4], [2, 4])[0]!;
    expect(String(page.content.whatWasFound ?? "")).not.toContain(
      "Материалы по теме на этой странице"
    );
    expect(String(page.content.whatWasFound ?? "")).not.toContain("site2.example");
  });

  it("находка, опирающаяся на тот же адрес другой ссылкой, находит свою строку", () => {
    // Наблюдение включает запрос, поэтому находка цитирует ту же страницу
    // другим ref-ом. Материал один — и строка, которую называет тема, одна.
    const scoped = scopedRows([1, 2, 3, 4], [2]);
    const index = scoped.evidenceIndex as Record<string, { url?: string }>;
    index["другой-запрос"] = { ...index["i2"]! };
    scoped.findings[0]!.evidenceRefs = ["другой-запрос"];
    const page = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides.filter(
      (s) => s.templateId === "serp-table"
    )[0]!;
    expect(page.content.whatWasFound).toContain("(строка 2)");
  });

  it("страница-продолжение называет свои номера, а не номера первого листа", () => {
    // Ёмкость листа выдачи — 4 строки, поэтому пятая уезжает на продолжение.
    const pages = serpPages([1, 2, 3, 4, 5], [2, 5]);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.content.whatWasFound).toContain("(строка 2)");
    expect(pages[1]!.content.whatWasFound).toContain("(строка 5)");
    expect(String(pages[1]!.content.whatWasFound ?? "")).not.toContain("(строка 2)");
  });
});

describe("тема без опоры среди напечатанных строк не печатается", () => {
  /**
   * Опора темы — напечатанная строка, а не наличие ссылки в наборе страницы.
   * Здесь набор страницы шире напечатанного: ссылка `i2` в него входит, а
   * строки с этим материалом на листе нет. Тема, которую поддерживает только
   * такая ссылка, не называется — иначе клиент ищет на листе то, чего там нет.
   */
  it("вместо ярлыка без опоры печатается описание состава строк", () => {
    const scoped = scopedRows([1, 2], [2]);
    const view = buildPageEvidenceView(scoped, ["i1", "i2"], [{ rank: 1, refs: ["i1"] }]);
    const blocks = pageFindingBlocks(scoped, view, { namePageDomains: false });
    expect(String(blocks.whatWasFound ?? "")).not.toContain(THEME);
    expect(String(blocks.whatWasFound ?? "")).toContain("Показано 2 результата");
  });

  it("та же страница с напечатанной строкой опоры тему называет", () => {
    const scoped = scopedRows([1, 2], [2]);
    const view = buildPageEvidenceView(scoped, ["i1", "i2"], [
      { rank: 1, refs: ["i1"] },
      { rank: 2, refs: ["i2"] },
    ]);
    const blocks = pageFindingBlocks(scoped, view, { namePageDomains: false });
    expect(blocks.whatWasFound).toBe(
      `«${THEME}» — средний уровень внимания (строка 2).`
    );
  });
});
