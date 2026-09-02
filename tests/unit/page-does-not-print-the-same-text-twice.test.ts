/**
 * Страница не печатает один и тот же текст дважды.
 *
 * Замечание владельца с живого прогона: «дублируется текст на одном слайде».
 * Ловить это должен ворот, а не оператор глазами: вручную такое не правится.
 *
 * Сравниваются все блоки страницы, которые доходят до клиента, — абзац,
 * пункты списка и ссылка на источник, — а не одно поле `bullets`: форма
 * «абзац повторяет первый пункт» до клиента доезжала (см. `ENGINEERING.md`,
 * «Абзац страницы печатается один раз»), и оставить её вне досягаемости
 * значило бы закрыть замечание наполовину.
 *
 * Страницы поверхностей ворот не смотрит: подсказка Google, дословно совпавшая
 * с подсказкой Яндекса, — два факта, а не повтор. Ответ на это в дереве уже
 * записан (`isDataRowTemplate`), и ворот пользуется им же.
 *
 * Материала, на котором дефект виден, в эталонах нет: замерено на `05985e6` —
 * ни одного дубля ни в собранной деке `report-72`, ни в снимке клиентского
 * текста золотого кейса, при любом составе сравниваемых блоков. Поэтому
 * поведение ворот держится сконструированным входом, а эталоны доказывают
 * только отсутствие ложного срабатывания.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAssembly } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

type Page = {
  slideKey: string;
  /** Шаблон реестра: по нему ворот узнаёт страницу поверхности. */
  templateId?: string;
  narrative?: string;
  bullets?: string[];
  sourceNote?: string;
};

function rendererSlide(page: Page, i: number, total: number): RendererSlide {
  return {
    slideKey: page.slideKey,
    sectionKey: "RU_PROFILE",
    template: "orion_golden_text_bullets",
    templateId: page.templateId ?? "theme-page",
    title: `Страница ${i + 1}`,
    pageNumber: i + 1,
    totalPageCount: total,
    baseSlotId: page.slideKey,
    isContinuation: false,
    narrative: page.narrative,
    bullets: page.bullets ?? [],
    sourceNote: page.sourceNote,
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
  } as unknown as RendererSlide;
}

/** Отчёт ворот по страницам, заданным ключом, шаблоном и клиентским текстом. */
function reportFor(pages: Page[]): ReturnType<typeof validateAssembly> {
  const rendererSlides = pages.map((p, i) => rendererSlide(p, i, pages.length));
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
        templateId: s.templateId,
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

/** Нарушения именно этого ворота — остальные проверки на синтетике шумят. */
function repeatIssues(report: ReturnType<typeof validateAssembly>): string[] {
  return report.issues.filter((i) => /repeated text/iu.test(i));
}

/** Строки отказа именно этого ворота. */
function repeatBlocking(report: ReturnType<typeof validateAssembly>): string[] {
  return report.blocking.filter((b) => /дважды/iu.test(b));
}

describe("ворот «страница не печатает один и тот же текст дважды»", () => {
  it("краснеет на побайтово одинаковых пунктах, называет страницу и останавливает сборку с первой же страницы", () => {
    const repeated =
      "Материалы о проверке компании опубликованы в мае 2025 года — источник: rbc.ru.";
    const report = reportFor([
      { slideKey: "p07_ru_summary", bullets: [repeated, "Другой пункт страницы.", repeated] },
    ]);
    expect(report.checks.noRepeatedTextOnPage).toBe(false);
    const issue = repeatIssues(report)[0];
    expect(issue, report.issues.join(" | ")).toBeDefined();
    expect(issue!).toContain("p07_ru_summary");
    expect(issue!).toContain("Материалы о проверке компании");
    // Одной страницы достаточно: на живом пути читается только `blocking`, и с
    // порогом в три страницы дубль, на который жаловался владелец, уехал бы
    // клиенту. Утверждение о `passed` тут ничего бы не значило — на
    // синтетическом манифесте он `false` и без дубля.
    const blocked = repeatBlocking(report)[0];
    expect(blocked, report.blocking.join(" | ")).toBeDefined();
    expect(blocked!).toContain("p07_ru_summary");
  });

  it("видит дубль, различающийся регистром, кавычками, хвостовой точкой или пробелами", () => {
    const base = "Публикация «Ведомостей» о сделке 2024 года.";
    const variants: Array<[string, string]> = [
      ["регистр", "публикация «Ведомостей» о сделке 2024 года."],
      ["кавычки", 'Публикация "Ведомостей" о сделке 2024 года.'],
      ["хвостовая точка", "Публикация «Ведомостей» о сделке 2024 года"],
      ["лишние пробелы", "Публикация  «Ведомостей»   о сделке 2024 года."],
    ];
    for (const [what, other] of variants) {
      const report = reportFor([{ slideKey: "p12_ru_ai", bullets: [base, other] }]);
      expect(report.checks.noRepeatedTextOnPage, what).toBe(false);
      expect(repeatIssues(report).length, what).toBeGreaterThan(0);
    }
  });

  it("молчит на двух разных пунктах с одинаковым началом", () => {
    const report = reportFor([
      {
        slideKey: "p20_ru_sources",
        bullets: [
          "Источник: rbc.ru — публикация о смене владельца от 12.03.2024.",
          "Источник: rbc.ru — публикация о годовой отчётности от 30.06.2024.",
        ],
      },
    ]);
    expect(report.checks.noRepeatedTextOnPage).toBe(true);
    expect(repeatIssues(report)).toHaveLength(0);
  });

  it("не считает дублем пустые, пробельные и лишённые слов пункты", () => {
    const report = reportFor([
      // Пустых блоков на странице может оказаться сколько угодно: они не текст,
      // и дублем клиенту не видны. То же у пункта из одной пунктуации.
      { slideKey: "p21_ru_related", bullets: ["", "   ", "\n", "—", "—", "Единственный пункт."] },
    ]);
    expect(report.checks.noRepeatedTextOnPage).toBe(true);
    expect(repeatIssues(report)).toHaveLength(0);
  });

  it("не считает дублем одинаковую строку на разных страницах", () => {
    const line = "Источники в регионе: rbc.ru, vedomosti.ru.";
    const report = reportFor([
      { slideKey: "p07_ru_summary", bullets: [line, "Первый пункт."] },
      { slideKey: "p08_ru_metrics", bullets: [line, "Второй пункт."] },
    ]);
    expect(report.checks.noRepeatedTextOnPage).toBe(true);
    expect(repeatIssues(report)).toHaveLength(0);
  });

  it("останавливает сборку уже на одной задетой странице", () => {
    // На живом пути читается только `blocking` (`canonical-report-prepare.ts`),
    // поэтому при пороге в три страницы дубль на одной уезжал бы клиенту — то
    // есть ровно тот случай, на который жаловался владелец. Порог у этого
    // ворота свой, и это осознанно.
    const dup = "Один и тот же пункт, напечатанный дважды.";
    const report = reportFor([{ slideKey: "p31_ru_theme", bullets: [dup, dup] }]);
    const blocked = repeatBlocking(report)[0];
    expect(blocked, report.blocking.join(" | ")).toBeDefined();
    expect(blocked!).toContain("p31_ru_theme");
  });

  it("видит абзац страницы, повторённый пунктом списка", () => {
    // Ровно та форма, про которую в ENGINEERING.md записано, что она доезжала
    // до клиента: построитель кладёт в абзац то, что уже стоит первым пунктом.
    const said = "Субъект упоминается в материалах о проверке поставок за 2023 год.";
    const report = reportFor([
      { slideKey: "p22_ru_theme", narrative: said, bullets: [said, "Второй пункт."] },
    ]);
    expect(report.checks.noRepeatedTextOnPage).toBe(false);
    expect(repeatIssues(report)[0], report.issues.join(" | ")).toContain("p22_ru_theme");
  });

  it("видит ссылку на источник, повторяющую пункт списка", () => {
    const note = "Источники: rbc.ru, vedomosti.ru.";
    const report = reportFor([
      { slideKey: "p23_ru_theme", bullets: ["Первый пункт страницы.", note], sourceNote: note },
    ]);
    expect(report.checks.noRepeatedTextOnPage).toBe(false);
    expect(repeatIssues(report)[0], report.issues.join(" | ")).toContain("p23_ru_theme");
  });

  it("видит два пункта, различающиеся только маркером находки", () => {
    // Маркер `[finding-…]` снимается по дороге к клиенту, поэтому для читателя
    // это одна строка дважды.
    const report = reportFor([
      {
        slideKey: "p24_ru_theme",
        bullets: [
          "Компания упомянута в материале о проверке. [finding-a1]",
          "Компания упомянута в материале о проверке. [finding-b2]",
        ],
      },
    ]);
    expect(report.checks.noRepeatedTextOnPage).toBe(false);
    expect(repeatIssues(report)[0], report.issues.join(" | ")).toContain("p24_ru_theme");
  });

  it("не трогает страницы поверхностей, где строки — данные провайдера", () => {
    // Подсказка Google, дословно совпавшая с подсказкой Яндекса, — два факта, а
    // не повтор; вычистка таких строк однажды оставила на странице три запроса
    // из десяти, нарисованных на панели.
    const row = "глинка сергей биография";
    // Рядом стоит обычная страница с двумя разными блоками: иначе сравнивать в
    // деке нечего, ворот объявит пропуск, и зелёный ключ ничего не докажет.
    const surface = reportFor([
      { slideKey: "p14_ru_suggestions", templateId: "suggestions", bullets: [row, row] },
      { slideKey: "p15_ru_theme", bullets: ["Первый пункт.", "Второй пункт."] },
    ]);
    expect(surface.checks.noRepeatedTextOnPage).toBe(true);
    expect(repeatIssues(surface)).toHaveLength(0);

    // Тот же текст на прозаической странице — дубль: молчит именно исключение,
    // а не содержимое.
    const prose = reportFor([
      { slideKey: "p14_ru_theme", templateId: "theme-page", bullets: [row, row] },
    ]);
    expect(prose.checks.noRepeatedTextOnPage).toBe(false);
  });

  it("объявляет пропуск, когда сравнивать на страницах нечего", () => {
    // Ворот без входа выглядит точно так же, как пройденный: ключа в `checks`
    // быть не должно, а пропуск — назван строкой.
    const report = reportFor([
      { slideKey: "p01_cover" },
      { slideKey: "p06_ru_toc", narrative: "Единственный блок страницы." },
    ]);
    expect(Object.keys(report.checks)).not.toContain("noRepeatedTextOnPage");
    const skip = report.skipped.find((s) => /дважды/iu.test(s));
    expect(skip, report.skipped.join(" | ")).toBeDefined();
  });
});

describe("ворот на эталонах: ложных срабатываний нет", () => {
  /**
   * Нижняя граница, а не замеренное число: состав страниц законно меняется.
   * Считаются страницы с двумя и более пунктами — только на такой странице
   * ворот вообще способен сработать; страница с одним пунктом проходит его
   * тривиально, и сторож по ней ничего бы не значил. Замер на `05985e6`: 21 в
   * деке эталона, 36 в золотом кейсе.
   */
  const MIN_PAGES_WITH_TWO_BULLETS = 15;

  function pagesWithTwoBullets(pages: Page[]): number {
    return pages.filter((p) => (p.bullets ?? []).filter((b) => b.trim()).length >= 2).length;
  }

  it("ни одна страница собранной деки report-72 ворот не роняет", () => {
    const deck = JSON.parse(
      readFileSync(
        join(process.cwd(), "baselines/report-72/artifacts/deck-sections/assembled-deck.json"),
        "utf8"
      )
    ) as { slides: Array<Record<string, unknown>> };
    // Шаблон каждой страницы — настоящий: иначе проверка пересобрала бы все
    // поверхности прозаическими и об исключении не сказала бы ничего.
    const pages: Page[] = deck.slides.map((s) => ({
      slideKey: String(s.slideKey ?? ""),
      templateId: String(s.templateId ?? ""),
      narrative: s.narrative ? String(s.narrative) : undefined,
      bullets: Array.isArray(s.bullets) ? (s.bullets as unknown[]).map(String) : [],
      sourceNote: s.sourceNote ? String(s.sourceNote) : undefined,
    }));
    expect(pagesWithTwoBullets(pages)).toBeGreaterThanOrEqual(MIN_PAGES_WITH_TWO_BULLETS);
    const report = reportFor(pages);
    expect(repeatIssues(report), repeatIssues(report).join(" | ")).toHaveLength(0);
    expect(report.checks.noRepeatedTextOnPage).toBe(true);
  });

  it("ни одна страница снимка клиентского текста золотого кейса ворот не роняет", () => {
    const snapshot = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures/golden-case/client-text.baseline.json"), "utf8")
    ) as { slides: Array<{ slideKey?: string; bullets?: unknown; text?: Record<string, string> }> };
    // Шаблона реестра в снимке нет, поэтому исключение поверхностей здесь не
    // работает и проверка строже настоящей: зелёный тут означает зелёный и с
    // исключением.
    const pages: Page[] = snapshot.slides.map((s) => ({
      slideKey: String(s.slideKey ?? ""),
      narrative: s.text?.narrative,
      bullets: Array.isArray(s.bullets) ? (s.bullets as unknown[]).map(String) : [],
      sourceNote: s.text?.sourceNote,
    }));
    expect(pagesWithTwoBullets(pages)).toBeGreaterThanOrEqual(MIN_PAGES_WITH_TWO_BULLETS);
    const report = reportFor(pages);
    expect(repeatIssues(report), repeatIssues(report).join(" | ")).toHaveLength(0);
    expect(report.checks.noRepeatedTextOnPage).toBe(true);
  });
});
