import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  packBulletPages,
  withContinuations,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { balanceTailPage } from "../../src/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";
import { DECK_TEMPLATE_REGISTRY } from "../../src/modules/digital-profile/orion-golden/deck-sections/template-registry";

/**
 * Шаг 16, 07.6 (docs/rework/07-slide-density-pagination-empty-states.md).
 *
 * Замер отрендеренных страниц финального прогона: 17 листов из 52 с пустым
 * хвостом больше трети, худший — один блок в 115 знаков на весь лист.
 *
 * При разборе нашлось худшее, чем пустота. Страница «Обзор цифрового профиля»
 * отдавала рендереру четыре темы повышенного внимания и никогда не делилась;
 * рендерер рисовал то, что помещалось под KPI-плитками, а остальное **молча
 * выбрасывал**. До клиента дошла одна тема из четырёх, и следа об этом не было
 * нигде.
 */

describe("разбиение по страницам ничего не теряет", () => {
  it("все блоки доходят до страниц в исходном порядке", () => {
    const blocks = [528, 466, 385, 386, 519, 471, 442, 135, 115].map(
      (n, i) => `«Тема ${i}»\n${"я".repeat(Math.max(1, n - 10))}`
    );
    const pages = packBulletPages(blocks, 2, 3, 860);
    expect(pages.flat()).toEqual(blocks);
  });

  it("страница-продолжение вмещает больше первой", () => {
    const blocks = Array.from({ length: 9 }, (_, i) => `«Тема ${i}»\n${"я".repeat(300)}`);
    const pages = packBulletPages(blocks, 2, 3, 860);
    expect(pages[0]).toHaveLength(2);
    expect(pages.slice(1).every((p) => p.length <= 3)).toBe(true);
  });

  it("последний лист не остаётся с одиноким блоком", () => {
    // Девять блоков при ёмкости 2 + 3 давали 2 | 3, 3, 1 — и лист с одним
    // блоком. Теперь хвост добирается за счёт соседа.
    const blocks = [528, 466, 385, 386, 519, 471, 442, 135, 115].map(
      (n, i) => `«Тема ${i}»\n${"я".repeat(Math.max(1, n - 10))}`
    );
    const pages = packBulletPages(blocks, 2, 3, 860);
    expect(pages[pages.length - 1]!.length).toBeGreaterThan(1);
    expect(pages.map((p) => p.length)).toEqual([2, 3, 2, 2]);
  });

  it("выравнивание не делает соседа реже хвоста", () => {
    const pages = [["a", "b"], ["c"]];
    balanceTailPage(pages, (s) => s.length, 1000);
    // Перенос сделал бы 1 и 2 — обмен одной редкой страницы на другую.
    expect(pages).toEqual([["a", "b"], ["c"]]);
  });

  it("объём страницы соблюдается даже когда счётчик разрешает", () => {
    const big = Array.from({ length: 4 }, (_, i) => `«Тема ${i}»\n${"я".repeat(840)}`);
    const pages = packBulletPages(big, 2, 3, 860);
    for (const p of pages) {
      expect(p.reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(3 * 860);
    }
    expect(pages.flat()).toEqual(big);
  });

  it("один блок страницу не теряет", () => {
    expect(packBulletPages(["один"], 2, 3, 860)).toEqual([["один"]]);
    expect(packBulletPages([], 2, 3, 860)).toEqual([[]]);
  });
});

describe("обзор цифрового профиля делится, а не обрезается", () => {
  it("страница с полной обвязкой отдаёт остальное на продолжение", () => {
    // По замеру страницы: шесть KPI-плиток, нарратив и карточка «Действие»
    // оставляют под блоки около 29 % листа — это один тематический блок.
    const bullets = Array.from({ length: 4 }, (_, i) => `«Тема ${i}»\n${"я".repeat(400)}`);
    const slides = withContinuations(
      {
        slideId: "p05_profile_dashboard",
        templateId: "regional-summary",
        title: "Обзор цифрового профиля",
        content: { bullets },
      } as never,
      "regional-summary",
      { firstPageBullets: 1 }
    );
    expect(slides.length).toBeGreaterThan(1);
    expect(slides[0]!.content.bullets).toHaveLength(1);
    expect(slides.flatMap((s) => s.content.bullets ?? [])).toEqual(bullets);
  });

  it("построитель обзора проводит слайд через разбиение", () => {
    // Раньше он возвращал один слайд с четырьмя блоками и разбиения не знал.
    const src = readFileSync(
      join(
        process.cwd(),
        "src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/executive.ts"
      ),
      "utf8"
    );
    const fn = src.slice(src.indexOf("export function buildDigitalProfileOverviewFragment"));
    expect(fn.slice(0, 3000)).toMatch(/withContinuations\(/u);
    expect(fn.slice(0, 3000)).toMatch(/firstPageBullets:\s*1/u);
  });
});

describe("рендерер о выброшенном содержимом сообщает", () => {
  it("потеря блоков попадает в телеметрию отдельным признаком", () => {
    const src = readFileSync(join(process.cwd(), "renderer/orion_golden_render/common.py"), "utf8");
    expect(src).toMatch(/dropped_bullets/u);
    expect(src).toMatch(/droppedBullets/u);
    // Признак ставится там же, где блоки выбрасываются.
    expect(src).toMatch(/kept\.pop\(\)\s*\n\s*dropped_bullets \+= 1/u);
  });

  it("сверка геометрии называет потерю своим кодом", async () => {
    const { inspectLayoutTelemetry } = await import(
      "../../src/modules/digital-profile/orion-golden/classic/generate-first36-geometry-artifacts"
    );
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "geom-"));
    const path = join(dir, "layout-telemetry.json");

    writeFileSync(
      path,
      JSON.stringify({
        entries: [
          {
            page: 11,
            name: "orion_bullets_dropped_p11",
            role: "bullets",
            clipped: true,
            droppedBullets: 3,
            droppedLines: 0,
            requiredHeight: 5_600_000,
            availableHeight: 2_000_000,
          },
        ],
      })
    );
    const issues = inspectLayoutTelemetry(path);
    expect(issues).toHaveLength(1);
    // Потеря содержимого — не то же, что вылезший за рамку текст: до читателя
    // не дошло вовсе, и код это называет.
    expect(issues[0]!.code).toBe("CONTENT_DROPPED_BY_RENDERER");
    expect(issues[0]!.severity).toBe("CRITICAL");
    expect(issues[0]!.detail).toMatch(/блоков=3/u);

    writeFileSync(
      path,
      JSON.stringify({
        entries: [
          {
            page: 4,
            name: "orion_text_body_p4",
            role: "text",
            clipped: true,
            requiredHeight: 900_000,
            availableHeight: 800_000,
          },
        ],
      })
    );
    expect(inspectLayoutTelemetry(path)[0]!.code).toBe("text-clipping");
  });

  it("мерка высоты приведена к тому, что рисуется", () => {
    const src = readFileSync(join(process.cwd(), "renderer/orion_golden_render/common.py"), "utf8");
    // Каждая строка меряется своим кеглем: подписи «Где видно…» рисуются
    // мельче тела, и общая мерка на FS_BODY завышала высоту в 1.7–1.8 раза.
    expect(src).toMatch(/_bullet_line_style\(line, is_first=\(li == 0\)\)/u);
    expect(src).toMatch(/measure_slack = 1\.08/u);
  });
});

describe("ёмкость продолжения задана там же, где ёмкость страницы", () => {
  it("у регионального резюме ёмкость продолжения измерена и записана", () => {
    const tpl = DECK_TEMPLATE_REGISTRY["regional-summary"];
    expect(tpl.maxBulletsPerSlide).toBe(2);
    expect(tpl.maxBulletsPerContinuation).toBe(3);
  });

  it("шаблон без замера ведёт себя как прежде", () => {
    const tpl = DECK_TEMPLATE_REGISTRY["finding-cards"];
    expect(tpl.maxBulletsPerContinuation).toBeUndefined();
    const bullets = Array.from({ length: 13 }, (_, i) => `пункт ${i}`);
    const pages = packBulletPages(
      bullets,
      tpl.maxBulletsPerSlide,
      tpl.maxBulletsPerContinuation ?? tpl.maxBulletsPerSlide,
      tpl.layout.itemCharBudget
    );
    expect(pages.every((p) => p.length <= tpl.maxBulletsPerSlide)).toBe(true);
    expect(pages.flat()).toEqual(bullets);
  });
});
