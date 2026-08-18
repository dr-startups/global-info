/**
 * Телеметрия рендерера доезжает до диска на живом (HTTP) пути.
 *
 * Живой рендер всегда идёт по HTTP, а этот путь писал на диск pptx, pdf,
 * страницы и мету — телеметрии в нём не было вовсе. Отсюда и «потери
 * непроверяемы»: судить нечего, в диагностический бандл файл попасть не может.
 *
 * Транспорт при этом ничего не выдумывает: нет поля в ответе — нет файла на
 * диске, потому что пустой файл ворота прочли бы как «проверено, потерь нет».
 * Офлайн: сеть подменена `fetchImpl`.
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDeckViaHttp } from "@/modules/digital-profile/services/render-deck-artifacts";
import type { ReportDeckManifest } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

const ENTRIES = [
  {
    page: 1,
    name: "orion_text_body_p1",
    role: "text",
    fontFamily: "Inter",
    fontSizePt: 11,
    availableHeight: 1_100_000,
    requiredHeight: 197_815,
    measuredLines: 1,
    textLength: 34,
    clipped: false,
    measurementUncertain: false,
  },
];

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

function fetchReturning(body: Record<string, unknown>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    if (String(url).includes("/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        slideCount: 1,
        pptxBase64: Buffer.from("pptx").toString("base64"),
        pdfBase64: Buffer.from("pdf").toString("base64"),
        pages: [],
        pdfExportMode: "libreoffice",
        warnings: [],
        ...body,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
}

async function render(dir: string, body: Record<string, unknown>): Promise<void> {
  await renderDeckViaHttp(minimalInput(dir), {
    fetchImpl: fetchReturning(body),
    rendererBaseUrl: "http://renderer.test:8080",
    sleepMs: async () => {},
  });
}

describe("телеметрия рендерера на HTTP-пути", () => {
  it("ответ с телеметрией ложится файлом рядом с pptx", async () => {
    const dir = mkdtempSync(join(tmpdir(), "render-telemetry-http-"));
    await render(dir, {
      layoutTelemetry: { version: "orion-layout-telemetry-v1", entries: ENTRIES },
    });
    const path = join(dir, "layout-telemetry.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version: string;
      entries: unknown[];
    };
    expect(parsed.version).toBe("orion-layout-telemetry-v1");
    expect(parsed.entries).toEqual(ENTRIES);
  });

  it("нет поля в ответе — нет файла на диске", async () => {
    // Пустая телеметрия — это утверждение «проверено, потерь нет», которого
    // рендерер не делал. Врать за него транспорт не имеет права.
    const dir = mkdtempSync(join(tmpdir(), "render-telemetry-absent-"));
    await render(dir, {});
    expect(existsSync(join(dir, "layout-telemetry.json"))).toBe(false);
  });

  it("телеметрия прошлого рендера не переживает новый", async () => {
    const dir = mkdtempSync(join(tmpdir(), "render-telemetry-stale-"));
    writeFileSync(
      join(dir, "layout-telemetry.json"),
      JSON.stringify({ version: "orion-layout-telemetry-v1", entries: ENTRIES }),
      "utf8"
    );
    await render(dir, {});
    expect(existsSync(join(dir, "layout-telemetry.json"))).toBe(false);
  });
});
