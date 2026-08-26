/**
 * Справка о наборе запросов называет общую часть один раз.
 *
 * Живой набор запросов о субъекте — это имя и подсказки поисковика, к которым
 * имя дописано в начало. Печатая каждый запрос целиком, справка повторяла имя
 * пять раз (199 знаков при абзаце, у которого запаса нет вовсе), и лист выдачи
 * уходил на девятый кегль при соседних листах деки в одиннадцатом.
 *
 * Сокращение не вправе выдумать запрос, которого не отправляли: приставка
 * ищется по словам и только с начала строки, а сама она обязана быть одним из
 * запросов набора. Не выполнилось — печатается прежний перечень целиком.
 */

import { describe, expect, it } from "vitest";
import {
  subjectQueriesLine,
  subjectQueries,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { serpTablePageProse } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const NAME = "глинка сергей михайлович";

/** Набор запросов так, как он лежит в индексе доказательств. */
function scopedWithQueries(queries: string[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  queries.forEach((query, i) => {
    evidenceIndex[`ev-${i}`] = {
      title: `Материал ${i}`,
      domain: `site${i}.example`,
      url: `https://site${i}.example/${i}`,
      region: "RU",
      query,
      queryPurpose: "subject_lookup",
    };
  });
  return {
    findings: [],
    surfaceUnits: [],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

describe("справка называет все запросы, а общую часть — один раз", () => {
  const LIVE = [NAME, `${NAME} отзывы`, `${NAME} компромат`, `${NAME} суд`, `${NAME} бизнес`];

  it("редакция справки — имя один раз, хвосты все", () => {
    expect(subjectQueriesLine(scopedWithQueries(LIVE))).toBe(
      // Порядок хвостов — тот же, каким `subjectQueries` отдаёт набор
      // (по частоте, затем по алфавиту): справка его не пересортировывает.
      `Выдача проверена по 5 запросам: «${NAME}» и он же с добавлением ` +
        "«бизнес», «компромат», «отзывы», «суд»."
    );
  });

  it("число запросов остаётся настоящим, а имя печатается один раз", () => {
    const line = subjectQueriesLine(scopedWithQueries(LIVE)) ?? "";
    expect(line.split(NAME).length - 1).toBe(1);
    expect(line).toContain("по 5 запросам");
    for (const tail of ["отзывы", "компромат", "суд", "бизнес"]) {
      expect(line.split(`«${tail}»`).length - 1).toBe(1);
    }
  });

  it("список запросов справка не меняет — он остаётся данными", () => {
    expect(subjectQueries(scopedWithQueries(LIVE))).toHaveLength(5);
  });

  it("хвост из двух слов печатается целиком", () => {
    const line = subjectQueriesLine(scopedWithQueries([NAME, `${NAME} бизнес партнёры`]));
    expect(line).toBe(
      `Выдача проверена по 2 запросам: «${NAME}» и он же с добавлением «бизнес партнёры».`
    );
  });
});

describe("общая часть не выдумывается", () => {
  it("у перестановок ФИО общей приставки нет — печатается перечень", () => {
    const line = subjectQueriesLine(
      scopedWithQueries(["глинка сергей михайлович", "сергей михайлович глинка"])
    );
    expect(line).toBe(
      "Выдача проверена по 2 запросам: «глинка сергей михайлович», «сергей михайлович глинка»."
    );
  });

  it("имя внутри запроса приставкой не считается", () => {
    // «биография глинка сергей михайлович» — имя стоит не в начале, и
    // «он же с добавлением «биография»» описало бы запрос, которого не было.
    const line = subjectQueriesLine(scopedWithQueries([NAME, `биография ${NAME}`])) ?? "";
    expect(line).toContain(`«биография ${NAME}»`);
    expect(line).not.toContain("с добавлением");
  });

  it("приставка, которой нет среди запросов, не печатается", () => {
    const line = subjectQueriesLine(
      scopedWithQueries([`${NAME} отзывы`, `${NAME} компромат`])
    ) ?? "";
    expect(line).toContain(`«${NAME} отзывы»`);
    expect(line).toContain(`«${NAME} компромат»`);
    expect(line).not.toContain("с добавлением");
  });

  it("частичное совпадение слова приставкой не считается", () => {
    // «глинка сергей михайлов» — не приставка «глинка сергей михайлович»:
    // сравнение идёт по словам целиком, а не по началу строки.
    const line = subjectQueriesLine(
      scopedWithQueries(["глинка сергей михайлов", "глинка сергей михайлович отзывы"])
    ) ?? "";
    expect(line).not.toContain("с добавлением");
  });
});

describe("единственный запрос справку по-прежнему не печатает", () => {
  it("повтор запроса таблицы справкой не дублируется", () => {
    const prose = serpTablePageProse({
      engineLabel: "Яндекса",
      query: "Anders Holmström",
      missing: "",
      queriesLine: subjectQueriesLine(scopedWithQueries(["Anders Holmström"])),
      subjectQueries: ["Anders Holmström"],
    });
    expect(prose.head).toContain("Показана выдача Яндекса по запросу «Anders Holmström»");
    expect(prose.tail).toBeUndefined();
  });
});
