/**
 * Единица листа проверки — материал, а не наблюдение.
 *
 * Ключ наблюдения включает запрос, поэтому одна страница, найденная четырьмя
 * запросами, лежит в данных четырьмя ссылками, а клиент видит одну строку. На
 * бандле отчёта 86 напечатанных ссылок 399, а напечатанных строк 160: лист,
 * собранный по ссылкам, дал бы четыре пункта на одну строку отчёта, и решение
 * аналитика по одному из них не закрыло бы остальные три.
 *
 * Сводит лист тем же ключом, что таблица выдачи и снимок (`serpMaterialKey`),
 * — третьего ответа на «тот же ли это материал» в продукте быть не должно.
 */

import { describe, expect, it } from "vitest";
import { buildReviewSheet } from "@/modules/digital-profile/services/review-sheet";

const CASE_ID = "case-1";

/** Слайд таблицы выдачи: его `evidenceRefs` — ссылки напечатанных строк. */
function tableSlide(page: number, refs: string[]) {
  return {
    slideKey: `p09_ru_serp_table${page > 15 ? `__cont${page - 15}` : ""}`,
    baseSlotId: "p09_ru_serp_table",
    templateId: "serp-table",
    pageNumber: page,
    title: "Россия — результаты поисковой выдачи",
    evidenceRefs: refs,
  };
}

describe("лист проверки: единица — материал", () => {
  it("наблюдения одного адреса, найденные разными запросами, дают один пункт", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: [tableSlide(15, ["inventory:obs-a", "inventory:obs-b"])],
      observations: [
        {
          url: "https://pravo.ru/arbitr_practice/judge/1465",
          title: "Судья Егоров Алексей Евгеньевич на портале Право.ру",
          domain: "pravo.ru",
          evidenceRefs: ["inventory:obs-a"],
        },
        {
          // Тот же адрес: другой запрос, метка отслеживания и хвостовой слэш.
          url: "https://www.pravo.ru/arbitr_practice/judge/1465/?srsltid=AfmBOo123",
          title: "Судья Егоров Алексей Евгеньевич на портале Право.ру — отзывы",
          domain: "pravo.ru",
          evidenceRefs: ["inventory:obs-b"],
        },
      ],
      subjectResolution: [
        { evidenceRef: "inventory:obs-a", decision: "SUBJECT_MATCH", reasonCode: "full_name_with_anchor:employer" },
        { evidenceRef: "inventory:obs-b", decision: "AMBIGUOUS", reasonCode: "surname_only" },
      ],
    });

    const materials = sheet.items.filter((i) => i.kind === "evidence");
    expect(materials).toHaveLength(1);
    expect(materials[0]!.refs).toEqual(["inventory:obs-a", "inventory:obs-b"]);
    // Сильнейшее решение материала — то, которым он и отнесён к субъекту.
    expect(materials[0]!.state).toContain("отнесён");
    expect(sheet.summary.evidence.total).toBe(1);
  });

  it("строка без адреса, домена и заголовка ни с кем не сводится", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: [tableSlide(15, ["inventory:obs-x", "inventory:obs-y"])],
      observations: [
        { evidenceRefs: ["inventory:obs-x"] },
        { evidenceRefs: ["inventory:obs-y"] },
      ],
      subjectResolution: [
        { evidenceRef: "inventory:obs-x", decision: "AMBIGUOUS", reasonCode: "surname_only" },
        { evidenceRef: "inventory:obs-y", decision: "AMBIGUOUS", reasonCode: "surname_only" },
      ],
    });
    expect(sheet.items.filter((i) => i.kind === "evidence")).toHaveLength(2);
  });

  it("два построения одного входа дают один и тот же файл", () => {
    const input = {
      caseId: CASE_ID,
      slides: [tableSlide(15, ["inventory:obs-b", "inventory:obs-a"])],
      observations: [
        { url: "https://a.ru/1", title: "А", domain: "a.ru", evidenceRefs: ["inventory:obs-a"] },
        { url: "https://b.ru/2", title: "Б", domain: "b.ru", evidenceRefs: ["inventory:obs-b"] },
      ],
      subjectResolution: [
        { evidenceRef: "inventory:obs-a", decision: "AMBIGUOUS", reasonCode: "surname_only" },
        { evidenceRef: "inventory:obs-b", decision: "SUBJECT_MATCH", reasonCode: "full_name_match" },
      ],
    };
    const first = JSON.stringify(buildReviewSheet(input), null, 2);
    const second = JSON.stringify(buildReviewSheet(input), null, 2);
    expect(second).toBe(first);
    // Метки времени в артефакте нет намеренно: она сделала бы два одинаковых
    // прогона разными файлами.
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
  });
});
