/**
 * Клиентский текст не отправляет читателя в раздел, которого в деке нет.
 *
 * Прибор на класс, а не на одну фразу. В прогоне 92 приложение объявлено
 * необязательным и отброшено ассемблером (`EMPTY_VALID_OMITTED`), а десять
 * страниц продолжали звать читателя туда: девять — строкой происхождения,
 * десятая — рекомендацией матрицы рисков. Ни одна проверка сборки этого не
 * видела, потому что все они смотрят на страницу, а не на деку целиком.
 *
 * Читается **собранная дека**: построитель фрагмента согласен сам с собой по
 * определению и о составе деки не знает.
 *
 * Игла выводится из `SECTION_TITLES` одним правилом — имя без последней буквы,
 * регистр не важен, — чтобы в проекте не появился второй словарь названий
 * разделов.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  promisesOfMissingSections,
  validateAssembly,
} from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import { SECTION_TITLES } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

const ETALON = "baselines/report-72/artifacts/deck-sections/assembled-deck.json";

function slide(over: Partial<RendererSlide> & { slideKey: string }): RendererSlide {
  return {
    sectionKey: "RU_PROFILE",
    template: "orion_golden_prose",
    templateId: "prose",
    title: `Страница ${over.slideKey}`,
    pageNumber: 1,
    totalPageCount: 1,
    baseSlotId: over.slideKey,
    isContinuation: false,
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
    ...over,
  } as unknown as RendererSlide;
}

/**
 * Страница, зовущая читателя в приложение.
 *
 * Формулировка своя, а не снятая с построителя: прибор ловит **класс** «текст
 * отправляет в отсутствующий раздел», и привязка к одной фразе сделала бы его
 * сторожем этой фразы.
 */
const CALLS_APPENDIX = slide({
  slideKey: "p11_ru_suggestions_yandex",
  sourceNote: "Полный перечень материалов приведён в приложении.",
});

/** Сам раздел приложения: одного слайда достаточно, чтобы ссылка стала законной. */
const APPENDIX_SLIDE = slide({
  slideKey: "appendix_main_base",
  sectionKey: "APPENDIX",
  title: "Приложение: материалы, требующие идентификации",
});

describe("прибор на собранной деке эталона-72", () => {
  it("не находит ни одной ссылки на отсутствующий раздел", () => {
    const deck = JSON.parse(readFileSync(ETALON, "utf8")) as {
      slides: Array<RendererSlide & { slideKey: string }>;
    };
    expect(deck.slides.length).toBeGreaterThan(0);
    expect(promisesOfMissingSections(deck.slides)).toEqual([]);
  });
});

describe("прибор на синтетическом кадре", () => {
  it("даёт ровно одну жалобу и называет в ней страницу и раздел", () => {
    const found = promisesOfMissingSections([CALLS_APPENDIX, slide({ slideKey: "p12" })]);
    expect(found).toHaveLength(1);
    expect(found[0]!.slide).toBe("p11_ru_suggestions_yandex");
    expect(found[0]!.section).toBe("APPENDIX");
  });

  it("молчит, когда раздел в деке есть", () => {
    expect(promisesOfMissingSections([CALLS_APPENDIX, APPENDIX_SLIDE])).toEqual([]);
  });

  it("узнаёт название раздела в любой падежной форме", () => {
    // Игла — имя без последней буквы: «Приложение», «приложении», «приложения».
    for (const form of ["Приложение", "в приложении", "материалы приложения"]) {
      expect(
        promisesOfMissingSections([slide({ slideKey: "p12", narrative: `См. ${form}.` })])
      ).toHaveLength(1);
    }
  });

  it("смотрит наш текст на всей странице, а не половину", () => {
    const inBullet = promisesOfMissingSections([
      slide({ slideKey: "p12", bullets: ["Полный перечень — в приложении."] }),
    ]);
    expect(inBullet).toHaveLength(1);
    const inSidebar = promisesOfMissingSections([
      slide({ slideKey: "p13", whatToCheck: "Сверить с приложением." }),
    ]);
    expect(inSidebar).toHaveLength(1);
  });

  it("слово в строке таблицы выдачи прибор не читает", () => {
    /*
     * Заголовок чужой страницы — не наше обещание. «Приложение» это обычное
     * русское слово, и на листе выдачи оно приезжает ячейкой из данных
     * провайдера: «Умар Кремлёв — мобильное приложение федерации бокса». Пока
     * игла смотрела в `table.rows`, такая строка объявляла страницу зовущей
     * читателя в отсутствующий раздел.
     */
    const found = promisesOfMissingSections([
      slide({
        slideKey: "p09_ru_serp_table",
        table: {
          headers: ["№", "Ссылка", "Заголовок", "Найдено по запросу", "Оценка"],
          rows: [
            [
              "1",
              "boxing-federation.ru/app",
              "Умар Кремлёв — мобильное приложение федерации бокса",
              "—",
              "Нейтрально",
            ],
          ],
        },
      } as unknown as Partial<RendererSlide> & { slideKey: string }),
    ]);
    expect(found).toEqual([]);
  });

  it("не заглядывает в разделы, которые в деке есть", () => {
    // Обязательные разделы присутствуют всегда, и упоминание комплаенса на
    // странице резюме — законная навигация, а не обещание пустого места.
    const found = promisesOfMissingSections([
      slide({
        slideKey: "p05",
        sectionKey: "COMPLIANCE",
        narrative: `См. раздел «${SECTION_TITLES.COMPLIANCE}».`,
      }),
    ]);
    expect(found).toEqual([]);
  });
});

describe("жалоба доезжает до отчёта сборки", () => {
  function reportFor(rendererSlides: RendererSlide[]): ReturnType<typeof validateAssembly> {
    return validateAssembly({
      manifest: { sectionOrder: [], entries: [] },
      deckManifest: {
        caseId: "case-1",
        sourceDatasetId: "dataset-1",
        pageCount: rendererSlides.length,
        baseSlotCoverage: 36,
        sectionPageRanges: [],
        toc: [],
        nonCanonicalPages: [],
        slides: rendererSlides.map((s) => ({
          slideId: s.slideKey,
          baseSlotId: s.baseSlotId,
          templateId: s.template,
          pageNumber: s.pageNumber,
          isContinuation: false,
          pageKind: "canonical_base",
        })),
      },
      rendererSlides,
      packs: [],
      bundle: { findings: [] },
      baseObservationCountBefore: 0,
      baseObservationCountAfter: 0,
    } as unknown as Parameters<typeof validateAssembly>[0]);
  }

  it("записывается в notes и называет страницу, но passed не роняет", () => {
    /*
     * Текстовая эвристика идёт туда же, куда «код-подобные токены»: от `issues`
     * зависит `passed`, а от него — ворота приёмки эталона и ассерция
     * офлайн-смока. Игла «приложени» выводится из клиентского имени раздела и
     * совпадает с обычным русским словом, поэтому цена ложного срабатывания —
     * остановленная приёмка, а не замечание в разборе.
     */
    const report = reportFor([CALLS_APPENDIX]);
    expect(report.checks.noPromisesOfMissingSections).toBe(false);
    const note = report.notes.find((n) => /отсутствующий раздел/u.test(n));
    expect(note, report.notes.join(" | ")).toBeDefined();
    expect(note!).toContain("p11_ru_suggestions_yandex");
    expect(note!).toMatch(/Приложени/u);
    expect(report.issues.some((i) => /отсутствующий раздел/u.test(i))).toBe(false);
    // Жёсткий отказ даёт офлайн-смок: новая текстовая эвристика не должна
    // ронять оплаченный прогон на последнем шаге.
    expect(report.blocking.some((b) => b.includes("p11_ru_suggestions_yandex"))).toBe(false);
  });

  it("на деке без таких ссылок ключ проверки зелёный", () => {
    const report = reportFor([slide({ slideKey: "p12", narrative: "Обычная страница." })]);
    expect(report.checks.noPromisesOfMissingSections).toBe(true);
  });
});
