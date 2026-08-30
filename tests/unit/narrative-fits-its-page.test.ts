import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { DeckTemplateId } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import {
  narrativeBudgetOf,
  validateSectionPack,
} from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import { SILENTLY_CLIPPED_NARRATIVE_TEMPLATES } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import {
  NarrativeOverBudgetError,
  REFLOW_LOSS_PREEXISTING_TEMPLATES,
  narrativeOverBudget,
  narrativeReflowLoss,
} from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { reflowNarrativeParagraphs } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { getClientTextFieldBudgets } from "@/modules/digital-profile/orion-golden/client/load-client-text-contract";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

/**
 * Сколько абзаца влезает на лист — вопрос с одним ответом, и ответ реестровый.
 *
 * Ответов было два, и применялся неверный: реестр объявляет
 * `narrativeCharBudget` своего шаблона, а сверка брала бюджет клиентского поля
 * (1100 знаков) — один на все шаблоны. Абзац страницы Википедии в закреплённом
 * золотом эталоне 952 знака при реестровых 900, и никто не возразил.
 *
 * Цена ошибки молчаливая: `content_card` и `ctx.body` рендерера **сначала
 * выбрасывают невлезшее, потом рисуют**, и `droppedLines` при этом не пишут —
 * блокирующее правило приёмки читает именно их, поэтому потери не видит ни
 * геометрия, ни телеметрия потерь.
 */

const PACKS_DIR = join(
  process.cwd(),
  "baselines/report-72/artifacts/deck-sections/section-packs"
);

function packFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? packFiles(join(dir, e.name)) : e.name.endsWith(".json") ? [join(dir, e.name)] : []
  );
}

function budgetOf(templateId: string): number {
  return DECK_TEMPLATE_REGISTRY[templateId as DeckTemplateId].layout.narrativeCharBudget;
}

describe("ни один абзац собранной деки не длиннее бюджета своего листа", () => {
  it("все слайды эталона 72 укладываются в реестровый бюджет своего шаблона", () => {
    const over: string[] = [];
    let checked = 0;
    for (const file of packFiles(PACKS_DIR)) {
      const pack = JSON.parse(readFileSync(file, "utf8")) as SectionPackV2;
      for (const slide of pack.slides ?? []) {
        const narrative = slide.content?.narrative ?? "";
        if (!narrative) continue;
        checked += 1;
        // Спрашивается тот же предикат, который применяет сверка пакета:
        // проверка, считающая бюджет по-своему, сторожила бы не то правило.
        const budget = narrativeBudgetOf(slide.templateId);
        if (narrative.length > budget) {
          over.push(`${slide.slideId} [${slide.templateId}] ${narrative.length} > ${budget}`);
        }
      }
    }
    // Проверка идёт по всем слайдам деки, а не по одному: дефект прятался
    // ровно в том, что смотрели не туда.
    expect(checked).toBeGreaterThan(20);
    expect(over, `абзацы сверх бюджета своего листа:\n${over.join("\n")}`).toEqual([]);
  });

  it("бюджет страницы Википедии приведён к измеренной ёмкости листа", () => {
    /*
     * Число померено рисованием карточки тем же вызовом, каким её рисует
     * рендерер (`_render_status_cards` → `content_card`): пол ёмкости — 1016
     * знаков, рецепт замера стоит при `CARD_NARRATIVE_CHAR_BUDGET`. Прежде
     * здесь стояла ссылка на телеметрию `orion_text_body_p31` — запись
     * **соседней** страницы, к карточке отношения не имеющая; из неё же
     * однажды и уехала не та цифра. Нижняя граница — абзац золотого эталона
     * (952), который объявленные когда-то 900 уже превышал.
     */
    const budget = budgetOf("wikipedia-check");
    expect(budget).toBeGreaterThanOrEqual(952);
    expect(budget).toBeLessThanOrEqual(998);
  });
});

/** Минимальный пакет, годный для `validateSectionPack`, с заданным абзацем. */
function packWithNarrative(templateId: DeckTemplateId, narrative: string): SectionPackV2 {
  return {
    schemaVersion: "section-pack-v3",
    caseId: "case-1",
    reportRunId: "run-1",
    sourceDatasetId: "ds-1",
    datasetId: "ds-1",
    fragmentKey: "RU_IDENTITY_WIKIPEDIA",
    sectionType: "RU_PROFILE",
    contentVersion: "deck-sections-vX",
    promptVersion: "p1",
    inputHash: "h",
    contentHash: "c",
    generatedAt: "2026-08-20T00:00:00.000Z",
    status: "READY",
    inputs: { sourceFindingIds: [], evidenceRefs: [] },
    sourceFindingIds: [],
    evidenceRefs: [],
    metrics: { adverseDisplayedCount: 0, adverseDatasetCount: 0 },
    slides: [
      {
        slideId: "p13_ru_wikipedia",
        baseSlotId: "p13_ru_wikipedia",
        sectionId: "RU_PROFILE",
        templateId,
        title: "Россия — Википедия",
        isContinuation: false,
        content: { narrative },
        evidenceRefs: [],
        findingIds: [],
        metrics: {},
        visualAssetRefs: [],
      },
    ],
  } as unknown as SectionPackV2;
}

function narrativeIssues(templateId: DeckTemplateId, length: number): string[] {
  const pack = packWithNarrative(templateId, "а".repeat(length));
  return validateSectionPack({
    pack,
    expectedCaseId: "case-1",
    expectedReportRunId: "run-1",
    expectedDatasetId: "ds-1",
    bundle: { findings: [] } as never,
    knownEvidenceRefs: new Set<string>(),
  }).issues.filter((i) => i.startsWith("narrative over budget"));
}

describe("сверка пакета спрашивает бюджет у реестра, а не у контракта полей", () => {
  it("абзац сверх реестрового бюджета отвергается, хотя контракт полей его пропускал", () => {
    const budget = budgetOf("wikipedia-check");
    const clientBudget = getClientTextFieldBudgets().narrative;
    // Разрыв, в котором и жил дефект: контракт полей шире реестра, и именно
    // он применялся.
    expect(clientBudget).toBeGreaterThan(budget);
    const issues = narrativeIssues("wikipedia-check", budget + 1);
    expect(issues.length, `ожидали отказ на ${budget + 1} знаках`).toBe(1);
    expect(issues[0]).toContain(String(budget));
  });

  it("абзац ровно по бюджету принимается", () => {
    expect(narrativeIssues("wikipedia-check", budgetOf("wikipedia-check"))).toEqual([]);
  });

  it("у листа с большим бюджетом тот же абзац проходит", () => {
    // Один и тот же абзац законен на просторном листе и незаконен на тесном:
    // бюджет принадлежит шаблону, а не полю.
    const tight = budgetOf("coverage-empty-state");
    expect(narrativeIssues("coverage-empty-state", tight + 1).length).toBe(1);
    expect(narrativeIssues("wikipedia-check", tight + 1)).toEqual([]);
  });
});

describe("бюджет листа сторожит там, где потеря молчит", () => {
  it("страницы карточной обрезки меряются реестром, а не контрактом полей", () => {
    for (const templateId of ["wikipedia-check", "coverage-empty-state", "persona-check"] as const) {
      expect(SILENTLY_CLIPPED_NARRATIVE_TEMPLATES.has(templateId)).toBe(true);
      expect(narrativeBudgetOf(templateId)).toBe(budgetOf(templateId));
    }
  });

  it("приборная страница резюме под карточный бюджет не подводится", () => {
    /*
     * Там абзац режется на свои коробки, а рендерер пишет `dropped_bullets`
     * (`executive.py:125-132`) → `CONTENT_DROPPED_BY_RENDERER`, то есть потеря
     * уже громкая. Реестровые 620 — сид раскладки, а не замер: абзац резюме
     * золотого кейса законно длиннее, и второй сторож с числом «на глаз»
     * ронял бы приёмку на здоровой деке.
     */
    expect(SILENTLY_CLIPPED_NARRATIVE_TEMPLATES.has("executive-summary")).toBe(false);
    expect(narrativeBudgetOf("executive-summary")).toBe(getClientTextFieldBudgets().narrative);
  });
});

describe("последний рубеж стоит после склейки, а не только у построителя", () => {
  /*
   * Сверка пакета меряет то, что отдал построитель, а рендереру уезжает абзац
   * после склейки: подпись слайда и текст находки прибавляют к нему сотни
   * знаков. На золотом эталоне это 620 у построителя против 952 на проводе —
   * то есть проверка одного пакета такую потерю пропускает по построению.
   */
  // Бюджет берётся у реестра, а не переписывается числом: он там померен, и
  // вторая копия числа разъехалась бы с первой на следующей правке ёмкости.
  const PERSONA_BUDGET = narrativeBudgetOf("persona-check");

  it("абзац, переросший бюджет уже после склейки, назван поимённо", () => {
    const over = narrativeOverBudget([
      {
        slideKey: "p03_persona",
        templateId: "persona-check",
        narrative: "я".repeat(PERSONA_BUDGET + 1),
      },
    ]);
    expect(over).toEqual([
      {
        slideKey: "p03_persona",
        templateId: "persona-check",
        length: PERSONA_BUDGET + 1,
        budget: PERSONA_BUDGET,
      },
    ]);
  });

  it("абзац по бюджету пропускается", () => {
    expect(
      narrativeOverBudget([
        {
          slideKey: "p03_persona",
          templateId: "persona-check",
          narrative: "я".repeat(PERSONA_BUDGET),
        },
      ])
    ).toEqual([]);
  });

  it("шаблоны, где рендерер сам объявляет потерю, этим рубежом не меряются", () => {
    expect(
      narrativeOverBudget([
        { slideKey: "p03_executive", templateId: "executive-summary", narrative: "я".repeat(5000) },
      ])
    ).toEqual([]);
  });
});

describe("отказ по ёмкости листа назван, а не безымянен", () => {
  it("несёт имя и разбор по листам", () => {
    /*
     * Классификатор восстановления узнаёт отказ по коду или знакомой фразе.
     * Безымянная ошибка не подходила ни под один пункт: на последнем шаге
     * оплаченного прогона она выглядела бы аварией, хотя данные сбора целы и
     * повтор дефект не чинит.
     */
    const err = new NarrativeOverBudgetError([
      { slideKey: "p03_persona", templateId: "persona-check", length: 1200, budget: 1113 },
    ]);
    expect(err.name).toBe("NarrativeOverBudgetError");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("p03_persona");
    expect(err.slides[0]?.budget).toBe(1113);
  });
});

describe("резак абзацев не выбрасывает текст молча", () => {
  /*
   * `reflowNarrativeParagraphs` делит абзац по предложениям и отбрасывает всё
   * сверх трёх, а слишком длинное предложение обрезает — без записи, события и
   * `droppedLines`. Поймать это можно только сверкой по обе стороны вызова:
   * после него потерянного текста уже нет.
   */
  it("текст стал короче — потеря названа с обеими длинами", () => {
    expect(
      narrativeReflowLoss([
        { slideKey: "p03_persona", templateId: "persona-check", before: "а".repeat(403), after: "а".repeat(344) },
      ])
    ).toEqual([{ slideKey: "p03_persona", before: 403, after: 344 }]);
  });

  it("текст цел — потери нет, и перенос строк ею не считается", () => {
    expect(
      narrativeReflowLoss([
        { slideKey: "p03_persona", templateId: "persona-check", before: "раз два три", after: "раз\nдва\nтри" },
      ])
    ).toEqual([]);
  });

  it("поимённых допусков у сторожа больше нет", () => {
    /*
     * Допуск существовал ради одного шаблона: абзац `p03_executive` золотого
     * кейса уходил резаку на 892 знака и возвращался 770 — молча терялось 122
     * (перемерено 30.08 прогоном золотого кейса с опустошённым допуском:
     * `narrative reflow dropped text: p03_executive 892->770`). Резак больше
     * не теряет знаков, поэтому исключение снято: любая потеря — дефект.
     */
    expect(
      [...REFLOW_LOSS_PREEXISTING_TEMPLATES],
      "поимённый допуск снят вместе с потерей: резак укладывает абзац без потерь"
    ).toEqual([]);
  });

  it("исполнительная сводка проверяется наравне со всеми", () => {
    expect(
      narrativeReflowLoss([
        { slideKey: "p03_executive", templateId: "executive-summary", before: "а".repeat(892), after: "а".repeat(770) },
      ])
    ).toEqual([{ slideKey: "p03_executive", before: 892, after: 770 }]);
  });
});

describe("резак укладывает абзац, не теряя знаков", () => {
  const SENTENCES = [
    "Первое предложение о деловом профиле субъекта и его публичном контуре.",
    "Второе предложение про упоминания в отраслевых изданиях за последний год.",
    "Третье предложение о повторяющемся сюжете вокруг профильного актива компании.",
    "Четвёртое предложение о позиции сторон разбирательства в судах инстанций.",
    "Пятое предложение о сроках рассмотрения и составе участников этого спора.",
    "Шестое предложение про публикации в изданиях нескольких стран подряд снова.",
    "Седьмое предложение о том, что часть материалов повторяет один и тот же сюжет.",
    "Восьмое предложение о подробностях сделки, которые добавляют новые издания.",
    "Девятое предложение про оценку принадлежности материалов проверяемому лицу.",
    "Десятое предложение о том, что медийные утверждения не равны фактам.",
  ];
  const compact = (s: string): number => s.replace(/\s+/gu, "").length;

  it.each([8, 10])("сплошной ввод из %i предложений не теряет ни знака", (n) => {
    const text = SENTENCES.slice(0, n).join(" ");
    expect(compact(reflowNarrativeParagraphs(text))).toBe(compact(text));
  });

  it("абзацев не больше трёх", () => {
    const text = SENTENCES.join(" ");
    expect(reflowNarrativeParagraphs(text).split("\n")).toHaveLength(3);
  });

  it("текст без единой границы предложения возвращается как есть", () => {
    // Защита партии 0039: резать нечем, а обрубок по границе слова — потеря
    // там, где резать было незачем.
    const text = `${SENTENCES[0]!.replace(".", "")} ${"а".repeat(300)}`;
    expect(reflowNarrativeParagraphs(text)).toBe(text);
  });

  it("текст с переводами строк возвращается как есть", () => {
    const text = "Первая строка.\nВторая строка.";
    expect(reflowNarrativeParagraphs(text)).toBe(text);
  });

  it("три и более перевода схлопываются до двух", () => {
    expect(reflowNarrativeParagraphs("Первая.\n\n\n\nВторая.")).toBe("Первая.\n\nВторая.");
  });
});
