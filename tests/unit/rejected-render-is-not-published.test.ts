/**
 * Забракованный воротами рендер не становится выдаваемым документом.
 *
 * Дефект, который здесь закрывается: адаптер писал `render/rendered-client.pdf`
 * и `.pptx` по конечным путям **до** суда телеметрии. Ворота бракуют и бросают;
 * на пересборке исключение ловит `restoreAfterFailedRebuild`, который возвращает
 * джобу в `REPORT_READY` с прежними `reportLinks` — а по этим путям уже лежат
 * байты забракованного рендера. Проверка скачивания знает только стадию, запись
 * в `reportLinks` и существование файла; происхождения байтов она не знает.
 * Оператор жмёт «Пересобрать», ворота говорят `CONTENT_DROPPED_BY_RENDERER`, а
 * по кнопке скачивания уезжает дека с потерянными карточками.
 *
 * Свойство: конечные имена появляются только после суда. До него рендер живёт
 * под черновым именем, и принятый прежде документ переживает брак.
 *
 * Офлайн: сеть подменена `fetchImpl`, рендерит настоящий HTTP-адаптер.
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CanonicalPrepareBlockedError,
  runCanonicalReportPrepare,
} from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  renderDeckViaHttp,
  type DeckRenderAdapter,
} from "@/modules/digital-profile/services/render-deck-artifacts";
import type { ReportDeckManifest } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import { tinyPrepareInput } from "../fixtures/tiny-canonical-prepare";

const CLEAN_ENTRY = {
  page: 1,
  name: "orion_text_body_p1",
  role: "text",
  requiredHeight: 197_815,
  availableHeight: 1_100_000,
  clipped: false,
  measurementUncertain: false,
};

const DROPPED_ENTRY = {
  page: 6,
  name: "orion_risk_matrix_cards_p6",
  role: "cards",
  requiredHeight: 5_500_000,
  availableHeight: 5_025_200,
  clipped: false,
  droppedBullets: 2,
  droppedLines: 0,
};

const ACCEPTED_PDF = "ПРИНЯТАЯ ДЕКА PDF";
const ACCEPTED_PPTX = "ПРИНЯТАЯ ДЕКА PPTX";

/** Ответ рендерера: свои байты и своя телеметрия. */
function fetchReturning(
  marker: string,
  entries: Array<Record<string, unknown>>
): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    if (String(url).includes("/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        slideCount: 1,
        pptxBase64: Buffer.from(`${marker} PPTX`, "utf8").toString("base64"),
        pdfBase64: Buffer.from(`${marker} PDF`, "utf8").toString("base64"),
        pages: [],
        pdfExportMode: "libreoffice",
        warnings: [],
        layoutTelemetry: { version: "orion-layout-telemetry-v1", entries },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
}

/** Настоящий живой адаптер — HTTP, только сеть подменена. */
function httpAdapter(marker: string, entries: Array<Record<string, unknown>>): DeckRenderAdapter {
  return async (input) =>
    await renderDeckViaHttp(input, {
      fetchImpl: fetchReturning(marker, entries),
      rendererBaseUrl: "http://renderer.test:8080",
      sleepMs: async () => {},
    });
}

function minimalInput(outputRoot: string) {
  const deckManifest = {
    version: "report-deck-manifest-v1",
    caseId: "c",
    reportRunId: "r",
    sourceDatasetId: "d",
    pageCount: 1,
    baseSlotCoverage: 0,
    slides: [],
    toc: [],
    sectionPageRanges: [],
    nonCanonicalPages: [],
  } as unknown as ReportDeckManifest;
  const slide: RendererSlide = {
    slideKey: "s1",
    sectionKey: "EXECUTIVE",
    template: "orion_golden_text",
    title: "Тест",
    pageNumber: 1,
    totalPageCount: 1,
    baseSlotId: "p01",
    isContinuation: false,
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
  };
  return { deckManifest, rendererSlides: [slide], subjectName: "Тест", outputRoot };
}

/** Каталог рендера с уже принятым прежде документом. */
function rootWithAcceptedReport(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const renderDir = join(root, "render");
  mkdirSync(renderDir, { recursive: true });
  writeFileSync(join(renderDir, "rendered-client.pdf"), ACCEPTED_PDF, "utf8");
  writeFileSync(join(renderDir, "rendered-client.pptx"), ACCEPTED_PPTX, "utf8");
  return root;
}

describe("публикация клиентских документов после суда телеметрии", () => {
  it("HTTP-адаптер не занимает конечные имена до суда", async () => {
    const dir = mkdtempSync(join(tmpdir(), "render-pending-names-"));
    const res = await renderDeckViaHttp(minimalInput(dir), {
      fetchImpl: fetchReturning("СВЕЖАЯ", [CLEAN_ENTRY]),
      rendererBaseUrl: "http://renderer.test:8080",
      sleepMs: async () => {},
    });

    expect(existsSync(join(dir, "rendered-client.pdf"))).toBe(false);
    expect(existsSync(join(dir, "rendered-client.pptx"))).toBe(false);
    expect(res.pdf).toBeDefined();
    expect(res.pptx).toBeDefined();
    expect(existsSync(res.pdf!)).toBe(true);
    expect(existsSync(res.pptx!)).toBe(true);
  });

  it("принятый прежде документ переживает забракованный ре-рендер", async () => {
    const root = rootWithAcceptedReport("prepare-rejected-render-");

    const err = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, {
        render: httpAdapter("ЗАБРАКОВАННАЯ", [CLEAN_ENTRY, DROPPED_ENTRY]),
      })
    ).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(CanonicalPrepareBlockedError);
    expect((err as CanonicalPrepareBlockedError).code).toBe("CONTENT_DROPPED_BY_RENDERER");
    // Ровно то, что уезжает по кнопке скачивания после восстановления джобы.
    expect(readFileSync(join(root, "render", "rendered-client.pdf"), "utf8")).toBe(ACCEPTED_PDF);
    expect(readFileSync(join(root, "render", "rendered-client.pptx"), "utf8")).toBe(ACCEPTED_PPTX);
  });

  it("принятый воротами рендер публикуется под конечными именами", async () => {
    const root = rootWithAcceptedReport("prepare-accepted-render-");

    const res = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, { render: httpAdapter("СВЕЖАЯ", [CLEAN_ENTRY]) })
    );

    expect(res.ok).toBe(true);
    expect(res.pdf).toBe(join(root, "render", "rendered-client.pdf"));
    expect(res.pptx).toBe(join(root, "render", "rendered-client.pptx"));
    expect(readFileSync(res.pdf!, "utf8")).toBe("СВЕЖАЯ PDF");
    expect(readFileSync(res.pptx!, "utf8")).toBe("СВЕЖАЯ PPTX");
  });
});
