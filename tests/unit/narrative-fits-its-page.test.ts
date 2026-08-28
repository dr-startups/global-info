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
    // Телеметрия эталона, запись `orion_text_body_p31`: 196 знаков в 2 строках,
    // 10,19 строки помещается → ≈998 знаков. Объявленные 900 были меньше
    // замера, и абзац золотого эталона в 952 знака их уже превышал.
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
  it("абзац, переросший бюджет уже после склейки, назван поимённо", () => {
    const over = narrativeOverBudget([
      { slideKey: "p03_persona", templateId: "persona-check", narrative: "я".repeat(1114) },
    ]);
    expect(over).toEqual([
      { slideKey: "p03_persona", templateId: "persona-check", length: 1114, budget: 1113 },
    ]);
  });

  it("абзац по бюджету пропускается", () => {
    expect(
      narrativeOverBudget([
        { slideKey: "p03_persona", templateId: "persona-check", narrative: "я".repeat(1113) },
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

  it("шаблон из списка известных потерь не проверяется", () => {
    expect(
      narrativeReflowLoss([
        { slideKey: "p03_executive", templateId: "executive-summary", before: "а".repeat(892), after: "а".repeat(770) },
      ])
    ).toEqual([]);
  });

  it("состав известных потерь закреплён поимённо", () => {
    /*
     * Это единственное, что держит `npm run ci` зелёным на золотом кейсе:
     * абзац `p03_executive` уходит резаку на 892 знака и возвращается 770 —
     * молча теряется 122. Без этой строки самый дешёвый путь к зелёному у
     * следующего, кто получит красноту, — дописать свой шаблон сюда, и не
     * заметит этого ни одна проверка. Расширять список нельзя: краснота
     * означает, что абзац надо чинить.
     */
    expect(
      [...REFLOW_LOSS_PREEXISTING_TEMPLATES],
      "список известных потерь расширять нельзя: p03_executive теряет 122 знака из 892 (золотой кейс), и это единственное записанное исключение"
    ).toEqual(["executive-summary"]);
  });
});
