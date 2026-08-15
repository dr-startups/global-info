/**
 * Вычистка повторов снимает только объявленную присказку.
 *
 * Прежняя вычистка сравнивала любые предложения по всей деке. На прогоне 14.08
 * (diagnostics-unified-…e3a6dc55) из 205 предложений пакетов до деки не дошло
 * 38, и 24 из них несли цитату, источник или число. Тексты ниже — дословно из
 * `deck/section-packs/**` того прогона.
 */

import { describe, expect, it } from "vitest";
import {
  BOILERPLATE_COMMENTARY,
  DEDUP_PAGE_SHARE_CEILING,
  dedupSlideBullets,
  isBoilerplateCommentary,
  withoutRepeatedBoilerplate,
} from "@/modules/digital-profile/orion-golden/deck-sections/boilerplate-commentary";

/** Блок резюме по ОАЭ, который прежняя вычистка стирала целиком. */
const UAE_BLOCK = [
  "«Криминальные / судебные материалы»",
  "Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами:",
  "«Timati has been suspected in Ukraine» — источник news.liga.net",
  "Где видно: news.liga.net, meduza.io.",
  "Для банка или партнёра такие сюжеты обычно становятся первым поводом для расширенной проверки.",
  "Всего по теме: 2 материала, с негативным контекстом — 2. [finding-criminal_legal-subject_match-ae9b4bfe]",
].join("\n");

/** Тот же материал в российском разделе — печатается раньше по порядку чтения. */
const RU_BLOCK = [
  "«Криминальные / судебные материалы»",
  "Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами:",
  "«Тимати подозревают на Украине» — источник meduza.io",
  "Где видно: meduza.io.",
  "Для банка или партнёра такие сюжеты обычно становятся первым поводом для расширенной проверки.",
  "Всего по теме: 6 материалов, с негативным контекстом — 6. [finding-criminal_legal-subject_match-606cfcc5]",
].join("\n");

describe("вычистка присказок", () => {
  it("объявленный список непуст и состоит из целых предложений", () => {
    expect(BOILERPLATE_COMMENTARY.length).toBeGreaterThanOrEqual(16);
    for (const s of BOILERPLATE_COMMENTARY) {
      expect(s.trim()).toMatch(/[.!?]$/u);
      expect(isBoilerplateCommentary(s)).toBe(true);
    }
  });

  it("страница резюме по ОАЭ переживает повтор: уходит только присказка", () => {
    const said = new Set<string>();
    withoutRepeatedBoilerplate(RU_BLOCK, said);
    const uae = withoutRepeatedBoilerplate(UAE_BLOCK, said);

    // Цитата, её источник, «Где видно» и счётчики темы остаются дословно.
    expect(uae.text).toContain("«Timati has been suspected in Ukraine» — источник news.liga.net");
    expect(uae.text).toContain("Где видно: news.liga.net, meduza.io.");
    expect(uae.text).toContain("Всего по теме: 2 материала, с негативным контекстом — 2.");
    expect(uae.text).toContain("[finding-criminal_legal-subject_match-ae9b4bfe]");
    // Ушла ровно присказка, и только она.
    expect(uae.removed).toEqual([
      "Для банка или партнёра такие сюжеты обычно становятся первым поводом для расширенной проверки.",
    ]);
    expect(uae.text).not.toContain("Для банка или партнёра");
  });

  it("счётчики темы не считаются повтором, даже совпав дословно", () => {
    // На прогоне «Всего по теме: 1 материал.» стояло под разными темами и
    // значило разное — вторую строку снимали как дубль.
    const said = new Set<string>();
    const a = withoutRepeatedBoilerplate("«Финансовые претензии»\nВсего по теме: 1 материал.", said);
    const b = withoutRepeatedBoilerplate("«Офшоры / корпоративное владение»\nВсего по теме: 1 материал.", said);
    expect(a.removed).toEqual([]);
    expect(b.removed).toEqual([]);
    expect(b.text).toContain("Всего по теме: 1 материал.");
  });

  it("цитата не обрывается: половина предложения не уходит как повтор", () => {
    const quote =
      "«ИП Юнусов Тимур Ильдарович зарегистрирован 25.12.2008. Основным видом деятельности является «Деятельность в области исполнительских искусств».» — источник xfirm.ru";
    const said = new Set<string>();
    withoutRepeatedBoilerplate(`Первое упоминание.\n${quote}\nГде видно: xfirm.ru.`, said);
    const second = withoutRepeatedBoilerplate(`${quote}\nГде видно: xfirm.ru.`, said);
    expect(second.text).toContain("— источник xfirm.ru");
    expect(second.text).toContain("Где видно: xfirm.ru.");
    expect(second.removed).toEqual([]);
  });

  it("присказка снимается и посреди строки, соседи по строке остаются", () => {
    // На прогоне присказка приклеивалась к «Где видно: …» через пробел.
    const line =
      "Где видно: руни.рф, prima-inform.ru. Для KYC это типичный запрос на раскрытие бенефициаров и источников контроля.";
    const said = new Set<string>();
    withoutRepeatedBoilerplate(
      "Для KYC это типичный запрос на раскрытие бенефициаров и источников контроля.",
      said
    );
    const out = withoutRepeatedBoilerplate(line, said);
    expect(out.text).toBe("Где видно: руни.рф, prima-inform.ru.");
    expect(out.removed).toHaveLength(1);
  });

  it("блок из одной присказки не опустошается", () => {
    const only = "Для банка или партнёра такие сюжеты обычно становятся первым поводом для расширенной проверки.";
    const said = new Set<string>();
    withoutRepeatedBoilerplate(only, said);
    const again = withoutRepeatedBoilerplate(only, said);
    expect(again.text).toBe(only);
    expect(again.removed).toEqual([]);
  });

  it("присказка с идентификатором находки не снимается никогда", () => {
    const withId =
      "Для банка или партнёра такие сюжеты обычно становятся первым поводом для расширенной проверки. [finding-criminal_legal-subject_match-ae9b4bfe]";
    expect(isBoilerplateCommentary(withId)).toBe(false);
    const said = new Set<string>();
    withoutRepeatedBoilerplate(
      "Для банка или партнёра такие сюжеты обычно становятся первым поводом для расширенной проверки.",
      said
    );
    const out = withoutRepeatedBoilerplate(withId, said);
    expect(out.text).toBe(withId);
    expect(out.removed).toEqual([]);
  });

  it("потолок отменяет вычистку, если со страницы ушла бы больше трети текста", () => {
    const boiler = BOILERPLATE_COMMENTARY[0]!;
    const said = new Set<string>();
    said.add(boiler.toLowerCase().replace(/[.,;:!?…«»"'()‐-―-]/gu, " ").replace(/\s+/gu, " ").trim());

    // Короткая страница, где присказка — больше половины текста. У блока есть
    // и своя строка, иначе сработает более ранняя защита «блок из одной
    // присказки» и снимать будет попросту нечего.
    const bullets = ["«Тема»", `${boiler}\nВсего по теме: 1 материал.`];
    const out = dedupSlideBullets(bullets, said);
    expect(out.skippedByCeiling).toBe(true);
    expect(out.bullets).toEqual(bullets);
    expect(out.removed).toEqual([]);
    expect(out.wouldRemoveChars / bullets.join("\n").length).toBeGreaterThan(
      DEDUP_PAGE_SHARE_CEILING
    );
  });

  it("на обычной странице потолок не мешает: присказка уходит, учёт ведётся", () => {
    const said = new Set<string>();
    dedupSlideBullets([RU_BLOCK], said);
    const out = dedupSlideBullets([UAE_BLOCK, RU_BLOCK], said);
    expect(out.skippedByCeiling).toBe(false);
    expect(out.removed.length).toBeGreaterThan(0);
    expect(out.bullets.join("\n")).toContain("«Timati has been suspected in Ukraine»");
  });
});
