/**
 * Интро страницы тем говорит, что прочитано, — и говорит это в тех двух
 * предложениях, которые печатает шаблон.
 *
 * На живом прогоне 76 отчёт запросил 120 страниц, прочитал 74 и напечатал
 * «Публикации из ТОП-20 прочитаны, и каждая отнесена к теме по своему
 * содержанию» — абсолют, который неверен. Оговорка о неполноте — часть
 * утверждения, а не украшение: она обязана стоять рядом с ним и называть базу.
 *
 * Двумя предложениями интро укладывается потому, что так читается, а не
 * потому, что третье исчезнет: счётчика предложений в шаблоне больше нет, и
 * «доехало до листа» проверяет `renderer/smoke_reading_lines_reach_the_page.py`
 * (Т8а) — по тексту фигур готового слайда.
 */

import { describe, expect, it } from "vitest";
import {
  linkReadingThemesIntro,
  type LinkReadingReport,
} from "@/modules/digital-profile/orion-golden/analytics/link-reading-agent";
import { buildSerpFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

/** Предложения текста — тем же разбиением, что и у рендерера. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Числа живого прогона 76: запрошено 120, прочитано 74, отказов 46. */
const LIVE_READING: LinkReadingReport = {
  status: "PARTIAL",
  requested: 120,
  read: 74,
  failed: 46,
  retried: 3,
  byReason: { blocked: 23, empty_text: 17, not_fetched: 6 },
};

/** Темы российского контура: сумма нежелательных — 15. */
const RU_THEMES = [
  { theme: "Криминальные / судебные материалы", count: 20, adverseCount: 10 },
  { theme: "Деловая репутация", count: 12, adverseCount: 5 },
];

function scopedForThemes(snapshot: Record<string, unknown>): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  for (let n = 1; n <= 3; n += 1) {
    const ref = `inventory:ru-${n}`;
    evidenceIndex[ref] = {
      title: `Материал ${n}`,
      url: `https://example.org/material-${n}`,
      domain: "example.org",
      engine: "YANDEX",
      region: "RU",
      rank: n,
      query: "тестов иван",
      queryPurpose: "subject_lookup",
    };
    refs.push(ref);
  }
  return {
    findings: [],
    surfaceUnits: [
      { surface: "organic", region: "RU", engine: "YANDEX", claims: [], metrics: [], evidenceRefs: refs },
    ],
    evidenceIndex,
    scope: {},
    metricSnapshot: { linkThemesByRegion: { RU: RU_THEMES }, ...snapshot },
  } as unknown as ScopedFragmentInput;
}

function themesSlide(snapshot: Record<string, unknown>) {
  const { slides } = buildSerpFragment("RU_SERP" as never, "RU_PROFILE" as never, "Россия", scopedForThemes(snapshot));
  return slides.find((s) => s.slideId.endsWith("__themes"))!;
}

describe("помощник интро страницы тем", () => {
  it("на неполном чтении называет базу, прочитанное и причины отказов — двумя предложениями", () => {
    const intro = linkReadingThemesIntro({
      report: LIVE_READING,
      adverseTotal: 15,
      topN: 20,
      unread: 46,
    });
    expect(intro).toBe(
      "Из 120 отобранных по отчёту страниц прочитано 74; каждая прочитанная отнесена к теме " +
        "по её содержанию, нежелательных публикаций: 15. " +
        "Из непрочитанных: 23 закрыли доступ, 17 без читаемого текста, 6 не ответили."
    );
  });

  it("каждая причина отказа названа своими словами", () => {
    const intro = linkReadingThemesIntro({
      report: {
        status: "PARTIAL",
        requested: 20,
        read: 15,
        failed: 5,
        retried: 2,
        byReason: { blocked: 3, not_found: 1, timeout: 1 },
      },
      adverseTotal: 2,
      topN: 20,
      unread: 5,
    });
    expect(intro).toContain("3 закрыли доступ");
    expect(intro).toContain("1 не существует");
    expect(intro).toContain("1 не ответили");
  });

  it("при полном чтении абсолют разрешён — и подкреплён числами", () => {
    const intro = linkReadingThemesIntro({
      report: { status: "OK", requested: 120, read: 120, failed: 0, retried: 0, byReason: {} },
      adverseTotal: 15,
      topN: 20,
      unread: 0,
    });
    expect(intro).toBe(
      "Публикации из ТОП-20 прочитаны (120 из 120), каждая отнесена к теме по её содержанию. " +
        "Нежелательных публикаций: 15."
    );
  });

  it("без отчёта о чтении абсолюта нет вовсе", () => {
    const intro = linkReadingThemesIntro({ adverseTotal: 15, topN: 20, unread: 4 });
    expect(intro).toBe(
      "Каждая прочитанная публикация отнесена к теме по её содержанию, нежелательных публикаций: 15. " +
        "4 страницы не открылись — они в подсчёт тем не вошли."
    );
    expect(intro).not.toContain("прочитаны");
  });

  it("во всех трёх состояниях укладывается в два предложения", () => {
    const variants = [
      linkReadingThemesIntro({ report: LIVE_READING, adverseTotal: 15, topN: 20, unread: 46 }),
      linkReadingThemesIntro({
        report: { status: "OK", requested: 120, read: 120, failed: 0, retried: 0, byReason: {} },
        adverseTotal: 15,
        topN: 20,
        unread: 0,
      }),
      linkReadingThemesIntro({ adverseTotal: 15, topN: 20, unread: 4 }),
    ];
    for (const intro of variants) {
      expect(sentences(intro), intro).toHaveLength(2);
    }
  });
});

describe("страница тем на числах живого прогона", () => {
  it("называет покрытие рядом с утверждением, а причины отказов — вторым предложением", () => {
    const narrative = String(themesSlide({ linkReading: LIVE_READING, linkUnreadCount: 46 }).content.narrative);
    const printed = sentences(narrative);
    expect(printed).toHaveLength(2);
    expect(printed[0]).toContain("74");
    expect(printed[0]).toContain("120");
    expect(printed[1]).toContain("23");
    expect(printed[1]).toContain("17");
    expect(printed[1]).toContain("6");
  });

  it("не печатает «прочитаны» без базы", () => {
    const narrative = String(themesSlide({ linkReading: LIVE_READING, linkUnreadCount: 46 }).content.narrative);
    for (const sentence of narrative.split(/(?<=[.!?…])\s+/u)) {
      if (!/прочитаны/u.test(sentence)) continue;
      expect(sentence, `абсолют без базы: ${sentence}`).toMatch(/\(\d+ из \d+\)/u);
    }
  });

  it("машинные поля повторяют базу и прочитанное", () => {
    const slide = themesSlide({ linkReading: LIVE_READING, linkUnreadCount: 46 });
    expect(slide.metrics.requested).toBe(120);
    expect(slide.metrics.read).toBe(74);
    expect(slide.metrics.adverseTotal).toBe(15);
  });

  it("легаси-прогон без отчёта о чтении ничего не роняет и абсолюта не печатает", () => {
    const slide = themesSlide({ linkUnreadCount: 4 });
    const narrative = String(slide.content.narrative);
    expect(narrative).toBe(
      "Каждая прочитанная публикация отнесена к теме по её содержанию, нежелательных публикаций: 15. " +
        "4 страницы не открылись — они в подсчёт тем не вошли."
    );
    expect(slide.metrics.requested).toBeUndefined();
    expect(slide.metrics.read).toBeUndefined();
  });
});
