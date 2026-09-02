/**
 * Число нарисованных страниц меряется декой, а не каталогом.
 *
 * Оба прибора — ворот `pageParity` приёмки эталона и подтест офлайн-смока —
 * считали **файлы**: `readdirSync(...).filter(f => f.endsWith(".png")).length`
 * и `glob(dir + "/page-*.png")`. Счёт совпадал с `pageCount` — значит, зелено.
 *
 * Каталог при этом дописывается: `scripts/render-orion-golden-artifacts.py`
 * только пишет страницы, сносит каталог перед отрисовкой лишь сам скрипт ворот,
 * а восстановление эталона копией лишнего не убирает. Замер 30.08 на дереве:
 * лишний `page-99.png` смок ловил (57 ≠ 56), но `page-13.png`,
 * переименованный в `page-99.png`, проходил зелёным — счёт сохранялся.
 * То есть страница могла пропасть, а прибор — молчать.
 *
 * Свойство: набор номеров страниц в каталоге равен `{1 … pageCount}`, и
 * расхождение называется номером, а не разницей счётчиков.
 */

import { describe, expect, it } from "vitest";
import { pagesDirectoryMismatch } from "../../scripts/lib/deck-pages";

/** Каталог здоровой деки эталона: ровно 56 страниц с двузначными номерами. */
function healthyPages(pageCount = 56): string[] {
  return Array.from({ length: pageCount }, (_, i) => `page-${String(i + 1).padStart(2, "0")}.png`);
}

describe("каталог страниц сверяется с декой", () => {
  it("полный набор номеров претензий не вызывает", () => {
    expect(pagesDirectoryMismatch(healthyPages(), 56)).toBeNull();
  });

  it("лишняя страница называется своим номером", () => {
    const complaint = pagesDirectoryMismatch([...healthyPages(), "page-99.png"], 56);
    expect(complaint).toContain("99");
    expect(complaint).toMatch(/лишн/iu);
  });

  it("пропавшая страница называется своим номером, даже когда счёт сошёлся", () => {
    // Ровно тот случай, который сегодня зелен: файлов по-прежнему 56.
    const pages = healthyPages().filter((f) => f !== "page-13.png");
    const complaint = pagesDirectoryMismatch([...pages, "page-99.png"], 56);
    expect(pages.length + 1).toBe(56);
    expect(complaint).toContain("13");
    expect(complaint).toContain("99");
  });

  it("номер читается из имени независимо от числа знаков", () => {
    // Формат имени знает тот, кто его пишет; отсюда берётся только число.
    expect(pagesDirectoryMismatch(["page-1.png", "page-002.png"], 2)).toBeNull();
  });

  it("непонятое имя не выдаётся за страницу", () => {
    // Прежний ворот считал любой `.png`, и посторонний файл сходил за страницу.
    const complaint = pagesDirectoryMismatch([...healthyPages(55), "contact-sheet.png"], 56);
    expect(complaint).toContain("contact-sheet.png");
  });

  it("пустой каталог успехом не считается", () => {
    // Ноль страниц на деку из 56 — это «не рисовали», а не «всё сошлось».
    expect(pagesDirectoryMismatch([], 56)).not.toBeNull();
  });

  it("дека без страниц — тоже претензия", () => {
    // `pageCount = 0` означает, что сверять нечего; молча проходить нельзя.
    expect(pagesDirectoryMismatch([], 0)).not.toBeNull();
  });
});
