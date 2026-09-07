/**
 * Что это за снимок комплаенса — один ответ на оба контура.
 *
 * Разбор метаданных `complianceVisual` жил в классическом контуре и знал два
 * источника: Dow Jones и World-Check. Канонический отчёт снимков не видел
 * вовсе, и страница LexisNexis печатала «визуальный экспорт недоступен» при
 * загруженном снимке. Второй разбор рядом с первым разошёлся бы с ним на первой
 * же правке, поэтому ответ переезжает в общий модуль.
 *
 * Описание аналитика — те же три поля, которые сайдбар печатает и без снимка:
 * новых мест для текста не заводится.
 */

import { describe, expect, it } from "vitest";
import {
  complianceVisualSlotOf,
  parseComplianceVisualMeta,
} from "@/modules/digital-profile/services/compliance-visual-pages";

describe("разбор метаданных снимка комплаенса", () => {
  it("понимает три вида снимка", () => {
    for (const [kind, expected] of [
      ["dow_jones_report", "dow_jones_report"],
      ["world_check_report", "world_check_report"],
      ["lexisnexis_report", "lexisnexis_report"],
    ] as const) {
      const meta = parseComplianceVisualMeta({
        complianceVisual: { kind, approved: true, renderedPages: [{ pageNumber: 1 }] },
      });
      expect(meta?.kind).toBe(expected);
    }
  });

  it("незнакомый вид не выдумывается", () => {
    const meta = parseComplianceVisualMeta({
      complianceVisual: { kind: "какой-то новый", approved: true, renderedPages: [] },
    });
    expect(meta?.kind).toBeNull();
  });

  it("описание аналитика и дата отчёта читаются как есть", () => {
    const meta = parseComplianceVisualMeta({
      complianceVisual: {
        kind: "lexisnexis_report",
        approved: true,
        reportDate: "2026-08-14",
        description: {
          whatItShows: "Карточка профиля в LexisNexis с двумя публикациями.",
          whyItMatters: "Публикации связывают субъекта с судебным сюжетом.",
          whatToDo: "Запросить первоисточники и полную карточку записи.",
        },
        renderedPages: [{ pageNumber: 1, storageKey: "k1" }],
      },
    });
    expect(meta?.reportDate).toBe("2026-08-14");
    expect(meta?.description?.whatItShows).toContain("Карточка профиля");
    expect(meta?.renderedPages).toHaveLength(1);
  });

  it("метаданных нет вовсе — и это не пустой снимок", () => {
    expect(parseComplianceVisualMeta(null)).toBeNull();
    expect(parseComplianceVisualMeta({})).toBeNull();
  });

  it("вид снимка знает свой слот, а вторая страница — свой", () => {
    expect(complianceVisualSlotOf("dow_jones_report", 1)).toBe("p34_dow_jones");
    expect(complianceVisualSlotOf("lexisnexis_report", 1)).toBe("p35_lexis_visual");
    expect(complianceVisualSlotOf("lexisnexis_report", 2)).toBe("p36_lexis_visual_2");
    // Третьей страницы у LexisNexis слота нет: печатать её некуда, и
    // притворяться, что есть, нельзя.
    expect(complianceVisualSlotOf("lexisnexis_report", 3)).toBeNull();
    expect(complianceVisualSlotOf("dow_jones_report", 2)).toBeNull();
  });
});
