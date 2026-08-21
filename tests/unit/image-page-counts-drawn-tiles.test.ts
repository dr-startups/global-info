/**
 * Страница изображений считает нарисованное и называет не показанное.
 *
 * Оба счётчика страницы («Изображения на этой странице: N» и «Показано N
 * результатов» в запасной ветке) выводятся из `visibleItems`, то есть из строк,
 * попавших в PNG. Строки, чьё превью получить не удалось, на сетке не рисуются
 * — значит, страница обязана назвать их словами и с причиной: `offline` — это
 * «мы не спрашивали», а не «источник не отдал».
 *
 * И заголовок страницы обязан знать про негатив, оставшийся без превью:
 * компромат-площадки чаще прочих отвечают отказом на запрос картинки, и
 * «негативных источников нет» над строкой о негативе — худшая из возможных
 * ошибок отчёта.
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
  NotShownRow,
  VisibleAssetItem,
  VisualAssetsBySlot,
} from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { PreviewFailureReason } from "@/modules/digital-profile/orion-golden/assets/media-asset-svg";

const inputs = loadReport72DeckInputs();
const fixture = loadReportAssets(inputs.evidenceIndex).visualAssets;

const ruRows: VisibleAssetItem[] = [
  "p14_ru_images_1",
  "p15_ru_images_2",
  "p16_ru_images_3",
  "p17_ru_images_4",
].flatMap((slotId) => (fixture[slotId] ?? []).flatMap((a) => a.visibleItems ?? []));
const adverseRow = ruRows.find((r) => r.domain === "kompromat1.online")!;
const adverseRow2 = ruRows.find((r) => r.domain === "kartoteka.news")!;
const longDomainRow = ruRows.find((r) => r.domain === "vitkvv2017.livejournal.com")!;
/**
 * Строки, за которыми не стоит вывод фрагмента: страница с подтверждённой темой
 * печатает вывод темы, а не состав страницы, и запасную ветку композиции на ней
 * не увидеть.
 */
const findingDomains = new Set(inputs.mergedBundle.findings.flatMap((f) => f.sourceDomains ?? []));
const plainRows = ruRows.filter(
  (r) => !r.adverse && r.domain && r.domain !== "images.example" && !findingDomains.has(r.domain)
);

/** Строка, не попавшая на сетку, — той же формы, что пишет построитель. */
function missed(row: VisibleAssetItem, reason: PreviewFailureReason): NotShownRow {
  return { ref: row.ref, adverse: row.adverse === true, reason };
}

function gridMeta(
  slotId: string,
  drawn: VisibleAssetItem[],
  notShown?: NotShownRow[]
): VisualAssetsBySlot[string] {
  return [
    {
      assetRef: `${slotId}_grid`,
      kind: "image_grid",
      title: slotId,
      hasImage: drawn.length > 0,
      evidenceRefs: drawn.map((v) => v.ref),
      evidenceDomains: [...new Set(drawn.map((v) => v.domain).filter(Boolean))] as string[],
      visibleItems: drawn,
      ...(notShown?.length ? { notShown } : {}),
    },
  ];
}

function imagesPack(visualAssets: VisualAssetsBySlot) {
  const ctx: SectionBuildContext = {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    contentVersion: "test-content-version",
    subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
    bundle: inputs.mergedBundle,
    surfaceUnits: inputs.surfaceUnits,
    metricSnapshot: inputs.metricSnapshot,
    evidenceIndex: inputs.evidenceIndex,
    extras: {
      executiveSummary: inputs.executiveSummary as unknown as ExecutiveSummaryExtras,
      surfaceCollectionHints: inputs.surfaceCollectionHints,
      visualAssets,
    },
    buildLog: [],
  };
  return buildSectionPackForFragment("RU_IMAGES", ctx);
}

function imagesPages(visualAssets: VisualAssetsBySlot): Map<string, SlideContentContract> {
  return new Map(imagesPack(visualAssets).slides.map((s) => [String(s.baseSlotId), s]));
}

function sidebarText(slide: SlideContentContract | undefined): string {
  return [slide?.content.whatWasFound, slide?.content.statusNote].filter(Boolean).join(" ");
}

describe("строка без прослеживаемого источника", () => {
  it("считается, а не исчезает молча", () => {
    /*
     * Пункт BK. Строка, которой нет в индексе доказательств, отбрасывалась
     * фильтром `if (!e) return []`: она не попадала ни в счёт «Из N строк», ни
     * в причины, ни в негатив, ни в `evidenceRefs`, и предупреждения о ней не
     * писалось нигде. Правило проекта требует, чтобы потеря была слышна.
     *
     * Домен у неё по-прежнему не называется — сослаться не на что, а домен,
     * добытый другим способом, обрушил бы ворота области. Но число она меняет:
     * «Из 4 строк» вместо «Из 3».
     */
    const drawn = plainRows.slice(0, 2);
    const notShown = [
      missed(plainRows[3]!, "http_403"),
      { ref: "inventory:obs-нет-такого-в-индексе", adverse: false, reason: "http_403" as const },
    ];
    const slide = imagesPages({
      p14_ru_images_1: gridMeta("p14_ru_images_1", drawn, notShown),
    }).get("p14_ru_images_1");
    const text = sidebarText(slide);

    expect(text).toMatch(/Из 4 строк/u);
    expect(text).toMatch(/2 без превью/u);
    // Причину для неё назвать нечем: она сводится в общую формулировку.
    expect(text).toMatch(/причина не установлена — 1/u);
    // Ссылки на неё среди доказательств нет: её нет в индексе.
    expect(slide?.evidenceRefs).not.toContain("inventory:obs-нет-такого-в-индексе");
  });
});

describe("счётчик страницы считает нарисованное", () => {
  it("запасная ветка композиции: показано столько, сколько плиток", () => {
    const drawn = plainRows.slice(0, 3);
    const notShown = [
      missed(adverseRow, "http_403"),
      missed(plainRows[3]!, "http_403"),
      missed(plainRows[4]!, "not_an_image"),
    ];
    const slide = imagesPages({
      p14_ru_images_1: gridMeta("p14_ru_images_1", drawn, notShown),
    }).get("p14_ru_images_1");
    const text = sidebarText(slide);

    expect(text).toMatch(/Показано 3 результата/u);
    expect(text).toMatch(/3 без превью/u);
    expect(text).toMatch(/источник не отдал файл — 2/u);
    expect(text).toMatch(/по адресу не изображение — 1/u);
    expect(text).toMatch(/с негативным признаком/u);
    expect(text).toMatch(/kompromat1\.online/u);
    // Машинный код причины клиенту не показывают.
    expect(text).not.toMatch(/http_|not_an_image/u);
    // Домен назван — значит, ссылка на строку осталась среди доказательств.
    expect(slide?.evidenceRefs).toEqual(expect.arrayContaining(notShown.map((n) => n.ref)));
  });

  it("ветка с выделенными строками: счёт по плиткам, не по входу построителя", () => {
    const drawn = [adverseRow, plainRows[0]!];
    const text = sidebarText(
      imagesPages({
        p15_ru_images_2: gridMeta(
          "p15_ru_images_2",
          drawn,
          plainRows.slice(1, 5).map((r) => missed(r, "network"))
        ),
      }).get("p15_ru_images_2")
    );

    expect(text).toMatch(/Изображения на этой странице: 2/u);
    expect(text).toMatch(/4 без превью/u);
    expect(text).toMatch(/источник не отдал файл — 4/u);
  });
});

describe("не показанное названо причиной, а не общей формулой", () => {
  it("офлайн-прогон говорит «не запрашивались», а не «источник не отдал»", () => {
    const slide = imagesPages({
      p16_ru_images_3: gridMeta(
        "p16_ru_images_3",
        [],
        plainRows.slice(0, 4).map((r) => missed(r, "offline"))
      ),
    }).get("p16_ru_images_3");
    const text = sidebarText(slide);

    expect(text).toMatch(/4 без превью/u);
    expect(text).toMatch(/превью в этом прогоне не запрашивались/u);
    expect(text).not.toMatch(/источник не отдал/u);
    // Строка источников не спорит с абзацем над ней: если домены названы
    // словами, подпись под страницей называет их же, а не «поисковую выдачу».
    expect(slide?.content.sourceNote ?? "").toMatch(new RegExp(plainRows[0]!.domain!.replace(".", "\\.")));
  });
});

describe("негатив без превью не исчезает из заголовка", () => {
  it("заголовок и статус считают негатив, оставшийся без плитки", () => {
    const slide = imagesPages({
      p14_ru_images_1: gridMeta("p14_ru_images_1", plainRows.slice(0, 2), [
        missed(adverseRow, "http_403"),
        missed(plainRows[2]!, "http_403"),
        missed(plainRows[3]!, "network"),
      ]),
    }).get("p14_ru_images_1");

    expect(slide?.title ?? "").not.toMatch(/негативных источников нет/u);
    expect(slide?.title ?? "").toMatch(/1 изображение ведёт на негативный источник/u);
    expect(sidebarText(slide)).not.toMatch(/Негативных заголовков на этой странице нет/u);
    expect(sidebarText(slide)).toMatch(/ведущих на негативные источники, — 1/u);
    // Находка по негативной строке доносится до страницы, а не теряется с плиткой.
    expect(slide?.findingIds.length ?? 0).toBeGreaterThan(0);
  });
});

describe("домены не показанных строк выводятся из доказательств страницы", () => {
  it("ссылка вне индекса не даёт странице ни домена, ни ссылки — но считается", () => {
    const alien: NotShownRow = { ref: "inventory:ss-not-in-this-index", adverse: false, reason: "http_403" };
    const pack = imagesPack({
      p14_ru_images_1: gridMeta("p14_ru_images_1", plainRows.slice(0, 2), [
        missed(adverseRow, "http_403"),
        alien,
      ]),
    });
    const slide = pack.slides.find((s) => s.baseSlotId === "p14_ru_images_1");
    const text = sidebarText(slide);

    // Называется только то, что страница может проследить: домена и ссылки у
    // чужой строки нет. Но в числе она есть — молча терять её нельзя (BK).
    expect(text).toMatch(/2 без превью/u);
    expect(text).toMatch(/причина не установлена — 1/u);
    expect(slide?.evidenceRefs ?? []).not.toContain(alien.ref);
    const report = validateSectionPack({
      pack,
      expectedCaseId: inputs.caseId,
      expectedReportRunId: inputs.reportRunId,
      expectedDatasetId: inputs.sourceDatasetId,
      bundle: inputs.mergedBundle,
      knownEvidenceRefs: new Set(Object.keys(inputs.evidenceIndex)),
      evidenceIndex: inputs.evidenceIndex,
    });
    expect(report.issues.filter((i) => i.includes("sidebar domain"))).toEqual([]);
  });
});

describe("обрезка съедает перечисление источников, а не сигнал", () => {
  it("длинная строка сохраняет фразу о негативе", () => {
    const reasons: PreviewFailureReason[] = [
      "http_403",
      "not_an_image",
      "too_large",
      "decode_failed",
      "offline",
      "budget_exhausted",
      "no_url",
    ];
    const notShown = [
      missed(adverseRow, "http_403"),
      missed(adverseRow2, "http_500"),
      missed(longDomainRow, "not_an_image"),
      ...plainRows.slice(2, 9).map((r, i) => missed(r, reasons[i % reasons.length]!)),
    ];
    const text = sidebarText(
      imagesPages({
        p14_ru_images_1: gridMeta("p14_ru_images_1", plainRows.slice(0, 2), notShown),
      }).get("p14_ru_images_1")
    );

    expect(text.length).toBeLessThanOrEqual(400 + 200);
    expect(text).toMatch(/с негативным признаком/u);
    expect(text).toMatch(/kompromat1\.online/u);
    // Перечисление источников — то, чем платят за длину.
    expect(text).not.toMatch(/Их источники/u);
  });
});
