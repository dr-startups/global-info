/**
 * Одна ссылка не роняет прогон.
 *
 * Кейс DPA-2026-0031 встал на `CANONICAL_PREPARE_FAILED`, не собрав ничего.
 * Причина — проверка схемы: тема решения обязана быть длиннее трёх знаков, а
 * тема непрочитанной страницы берётся из заголовка выдачи. Заголовок «РБК» —
 * три знака, и `LinkVerdictSchema.parse` бросал прямо в разборе ссылок.
 * `Promise.all` доносил отказ до самого верха, и стадия падала целиком: сто
 * девятнадцать разобранных решений выбрасывались из-за сто двадцатого.
 *
 * Короткий заголовок — обычная выдача, а не порча данных. Чинится место, где
 * заголовок превращается в тему, и изоляция отказа по одной ссылке.
 */

import { describe, expect, it, vi } from "vitest";
import {
  UNREAD_THEME_FALLBACK,
  analyzeLinkPages,
  safeVerdictTheme,
  unreadVerdict,
  type LinkVerdictInput,
} from "@/modules/digital-profile/orion-golden/analytics/link-verdict-analyst";

function input(serpTitle: string | undefined, ref = "inventory:a"): LinkVerdictInput {
  return {
    evidenceRef: ref,
    url: "https://rbc.ru/news/1",
    domain: "rbc.ru",
    rank: 3,
    query: "лисин владимир сергеевич",
    region: "RU",
    serpTitle,
    subject: { fullName: "Лисин Владимир Сергеевич" },
    page: { ok: false, failure: "blocked", message: "HTTP 429", readAt: "2026-08-15T12:00:00Z" },
  } as unknown as LinkVerdictInput;
}

describe("тема решения всегда проходит схему", () => {
  it("короткий заголовок выдачи заменяется запасной темой", () => {
    for (const short of ["РБК", "МК", "ТВ", "a", "  "]) {
      expect(safeVerdictTheme(short), short).toBe(UNREAD_THEME_FALLBACK);
    }
  });

  it("нормальный заголовок остаётся темой", () => {
    expect(safeVerdictTheme("НЛМК: итоги полугодия")).toBe("НЛМК: итоги полугодия");
    // Ровно четыре знака — минимум схемы, тема годится.
    expect(safeVerdictTheme("НЛМК")).toBe("НЛМК");
  });

  it("длинная тема укорачивается до потолка схемы", () => {
    expect(safeVerdictTheme("я".repeat(400)).length).toBe(120);
  });

  it("решение по непрочитанной странице с коротким заголовком не бросает", () => {
    expect(() => unreadVerdict(input("РБК"))).not.toThrow();
    expect(unreadVerdict(input("РБК")).theme).toBe(UNREAD_THEME_FALLBACK);
    expect(unreadVerdict(input(undefined)).theme).toBe(UNREAD_THEME_FALLBACK);
  });
});

describe("отказ по одной ссылке не роняет остальные", () => {
  it("упавший разбор превращается в честное «не знаем»", async () => {
    const inputs = [input("Первая страница", "inventory:1"), input("Вторая страница", "inventory:2")];
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("не важно"))
      .mockResolvedValue({
        subjectMatch: "subject",
        tone: "neutral",
        theme: "Биография субъекта",
        sourceType: "Новостное СМИ",
        quotes: [],
      });

    const out = await analyzeLinkPages(inputs, { call: call as never, concurrency: 1 });
    expect(out).toHaveLength(2);
    // Ни одно решение не потеряно, и каждое знает свою ссылку.
    expect(out.map((v) => v.evidenceRef)).toEqual(["inventory:1", "inventory:2"]);
    expect(out[0]!.readFailure).toBeDefined();
  });

  it("страница с коротким заголовком проходит вместе со всеми", async () => {
    const inputs = [input("РБК", "inventory:1"), input("Вторая страница", "inventory:2")];
    const call = vi.fn().mockResolvedValue({
      subjectMatch: "unclear",
      tone: "neutral",
      // Модель тоже вернула слишком короткую тему.
      theme: "СМИ",
      quotes: [],
    });
    const out = await analyzeLinkPages(inputs, { call: call as never, concurrency: 2 });
    expect(out).toHaveLength(2);
    for (const v of out) expect(v.theme.length).toBeGreaterThanOrEqual(4);
  });
});
