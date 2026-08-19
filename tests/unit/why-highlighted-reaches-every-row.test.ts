/**
 * «Под каждым выделенным результатом» выполняется буквально.
 *
 * Сайдбар рисует две фразы по 240 знаков — это лимит рендерера, а не решение
 * построителя. Значит, третья фраза и адреса, не поместившиеся в узкую
 * колонку, обязаны уйти на слайд-продолжение: иначе выделенная строка
 * останется без объяснения, а объяснение — без ссылки, по которой его можно
 * проверить.
 *
 * Полный список фраз при этом остаётся на базовом слайде: проверка «объяснение
 * на каждую негативную находку» считает по нему.
 */

import { describe, expect, it } from "vitest";
import {
  loadReport72DeckInputs,
  loadReportAssets,
} from "../../scripts/run-orion-deck-sections-report72";
import { buildSectionPackForFragment } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import type { SectionBuildContext } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import { validateSectionPack } from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import type { ExecutiveSummaryExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type {
  VisibleAssetItem,
  VisualAssetsBySlot,
} from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const inputs = loadReport72DeckInputs();
const fixture = loadReportAssets(inputs.evidenceIndex).visualAssets;
const ruRows: VisibleAssetItem[] = (fixture.p10_ru_serp_visual ?? []).flatMap(
  (a) => a.visibleItems ?? []
);

const xRow = ruRows.find((r) => r.domain === "x.com")!;
const rupepRow = ruRows.find((r) => r.domain === "rupep.org")!;
const utroRow = ruRows.find((r) => r.domain === "utro.ru")!;

/** Строка снимка с рамкой: рамку ставит визуальный слой, страница ей верит. */
function framed(row: VisibleAssetItem): VisibleAssetItem {
  return { ...row, adverse: true };
}

function snapshotMeta(rows: VisibleAssetItem[]): VisualAssetsBySlot {
  return {
    p10_ru_serp_visual: [
      {
        assetRef: "ru_serp_snapshot",
        kind: "serp_screenshot",
        title: "Россия — результаты поисковой выдачи",
        hasImage: true,
        evidenceRefs: rows.map((r) => r.ref),
        evidenceDomains: [...new Set(rows.map((r) => r.domain).filter(Boolean))] as string[],
        visibleItems: rows,
      },
    ],
  };
}

function pack(rows: VisibleAssetItem[], evidenceIndex: ScopedEvidenceIndex = inputs.evidenceIndex) {
  const ctx: SectionBuildContext = {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    contentVersion: "test-content-version",
    subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
    bundle: inputs.mergedBundle,
    surfaceUnits: inputs.surfaceUnits,
    metricSnapshot: inputs.metricSnapshot,
    evidenceIndex,
    extras: {
      executiveSummary: inputs.executiveSummary as unknown as ExecutiveSummaryExtras,
      surfaceCollectionHints: inputs.surfaceCollectionHints,
      visualAssets: snapshotMeta(rows),
    },
    buildLog: [],
  };
  return buildSectionPackForFragment("RU_SERP_SCREENSHOT", ctx);
}

/** Индекс доказательств с решением по прочитанной странице для одной строки. */
function read(ref: string, over: Record<string, unknown>): ScopedEvidenceIndex {
  return {
    ...inputs.evidenceIndex,
    [ref]: { ...inputs.evidenceIndex[ref], ...over },
  } as ScopedEvidenceIndex;
}

function validate(built: ReturnType<typeof pack>) {
  return validateSectionPack({
    pack: built,
    expectedCaseId: inputs.caseId,
    expectedReportRunId: inputs.reportRunId,
    expectedDatasetId: inputs.sourceDatasetId,
    bundle: inputs.mergedBundle,
    knownEvidenceRefs: new Set(Object.keys(inputs.evidenceIndex)),
    evidenceIndex: inputs.evidenceIndex,
  });
}

describe("слайд-продолжение «Почему выделено»", () => {
  it("три рамки: полный список фраз на базовом слайде и три буллета с адресами на продолжении", () => {
    const built = pack([framed(xRow), framed(rupepRow), framed(utroRow), ...ruRows.slice(4, 7)]);
    const base = built.slides.find((s) => !s.isContinuation)!;
    expect(base.content.highlightExplanations?.length).toBe(3);

    const cont = built.slides.filter((s) => s.isContinuation);
    expect(cont.length).toBe(1);
    const bullets = cont[0]!.content.bullets ?? [];
    expect(bullets.length).toBe(3);
    for (const domain of ["x.com", "rupep.org", "utro.ru"]) {
      expect(bullets.some((b) => b.includes(domain))).toBe(true);
    }
    expect(cont[0]!.continuationOf).toBe("p10_ru_serp_visual");
    expect(validate(built).passed).toBe(true);
  });

  it("две рамки и короткие адреса: продолжения нет", () => {
    const built = pack([framed(xRow), framed(rupepRow), ...ruRows.slice(4, 7)]);
    expect(built.slides.find((s) => !s.isContinuation)!.content.highlightExplanations?.length).toBe(2);
    expect(built.slides.filter((s) => s.isContinuation).length).toBe(0);
    expect(validate(built).passed).toBe(true);
  });

  it("прочитанная страница: адрес не влез в сайдбар — продолжение несёт его целиком", () => {
    const evidence = read(rupepRow.ref, {
      verdictTheme: "Санкции, санкционные суды и заморозка активов",
      readVerdictTone: "adverse",
      pageQuote:
        "Одно очень длинное предложение цитаты со страницы, которое невозможно укоротить " +
        "по границе предложения, потому что граница у него ровно одна и стоит она в самом " +
        "конце предложения, занимая весь бюджет узкой колонки сайдбара целиком",
    });
    const built = pack([framed(xRow), framed(rupepRow), ...ruRows.slice(4, 7)], evidence);
    const cont = built.slides.filter((s) => s.isContinuation);
    expect(cont.length).toBe(1);
    expect((cont[0]!.content.bullets ?? []).some((b) => b.includes("rupep.org/ru/person/8095"))).toBe(
      true
    );
  });
});

describe("напечатанная ссылка проверяется по своему хосту", () => {
  it("ссылка на страницу из доказательств слайда не читается как чужой домен", () => {
    const evidence = read(xRow.ref, {
      url: "https://x.com/rucriminalinfo/status/2008361452998914141/report.html",
      verdictTheme: "Криминальные сюжеты вокруг субъекта",
      readVerdictTone: "adverse",
      pageQuote: "В публикации перечислены эпизоды уголовного дела.",
    });
    const built = pack([framed(xRow), framed(rupepRow), ...ruRows.slice(4, 7)], evidence);
    const report = validateSectionPack({
      pack: built,
      expectedCaseId: inputs.caseId,
      expectedReportRunId: inputs.reportRunId,
      expectedDatasetId: inputs.sourceDatasetId,
      bundle: inputs.mergedBundle,
      knownEvidenceRefs: new Set(Object.keys(inputs.evidenceIndex)),
      evidenceIndex: evidence,
    });
    expect(report.issues.filter((i) => i.includes("not derived from page evidence"))).toEqual([]);
  });
});

describe("рамка без называемого источника всё равно объяснена", () => {
  /*
   * Строку, чей источник назвать клиенту нельзя, объяснение обходить не вправе:
   * рамку на снимке рисует классификатор, который про отбор имён не знает, и
   * страница получала три красных рамки при подписи «выделено: 2». Число, не
   * сходящееся с картинкой, читатель замечает раньше любой формулировки.
   */
  const mockRef = "inventory:mock-row";
  const mockRow: VisibleAssetItem = {
    ref: mockRef,
    url: "https://en.wikipedia-mock.example/wiki/Sergey_Glinka",
    domain: "en.wikipedia-mock.example",
    title: "Сергей Глинка — досье",
    adverse: true,
    themeTitle: "Криминальные / судебные материалы",
  };
  const evidence = {
    ...inputs.evidenceIndex,
    [mockRef]: {
      url: "https://en.wikipedia-mock.example/wiki/Sergey_Glinka",
      domain: "en.wikipedia-mock.example",
      title: "Сергей Глинка — досье",
      kind: "serp_result",
    },
  } as ScopedEvidenceIndex;

  const built = pack([framed(xRow), framed(rupepRow), mockRow, ...ruRows.slice(4, 7)], evidence);
  const base = built.slides.find((s) => !s.isContinuation)!;

  it("объяснений столько же, сколько рамок", () => {
    expect(base.content.highlightExplanations?.length).toBe(3);
  });

  it("подпись страницы считает то же число", () => {
    expect(base.content.whatWasFound).toContain("повышенного внимания: 3");
  });

  it("имя демо-данных при этом в отчёт не попадает и прочерка вместо домена нет", () => {
    const text = JSON.stringify(base.content);
    expect(text).not.toContain("wikipedia-mock");
    expect(text).not.toContain(".example");
    expect(text).not.toContain("— —");
  });
});
