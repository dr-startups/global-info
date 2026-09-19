import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Сирень на сайте значит «найдено» и «выбрано» в продукте; «здесь мышь» и «вы тут» —
 * чернила и бумага (владелец 18.09.2026, доведено до конца 19.09.2026).
 *
 * Последние два места, где выделитель ложился под заголовок: наведение на статью в
 * списке блога и текущий раздел в меню телефона. Тест держит правило целиком, а не
 * эти два селектора: новый выделитель под словом в наведении он тоже поймает.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const CSS = "src/app/(site)/site.css";
const HEADER = "src/modules/site/components/SiteHeader.tsx";

describe("Наведение и текущий раздел отмечены чернилами, а не выделителем", () => {
  it("ни одно подчёркивание не красится выделителем", () => {
    expect(read(CSS)).not.toMatch(/text-decoration-color:\s*var\(--site-marker/u);
  });

  it("статья в списке блога откликается тонкой чернильной линией под заголовком", () => {
    const css = read(CSS);
    expect(css).toMatch(/\.site-post:hover \.site-post__link\s*\{[^}]*text-decoration-color:\s*currentColor/u);
    expect(css).not.toMatch(/\.site-post__link\s*\{[^}]*text-decoration-thickness:\s*0\.45em/u);
  });

  it("в меню телефона нет штриха выделителя под словом", () => {
    const css = read(CSS);
    expect(css).not.toMatch(/site-drawer__label/u);
    expect(css).not.toMatch(/site-drawer-stroke/u);
    expect(read(HEADER)).not.toMatch(/site-drawer__label|labelClass/u);
  });

  it("текущий раздел меню — чернильный предмет из того же материала, что решающая кнопка", () => {
    // Плашка бумаги на бумаге терялась, плоская чёрная заливка была заметной, но чужой сайту
    // (владелец 19.09.2026, оба раза). Материал берётся у кнопки: те же токены градиента.
    const css = read(CSS);
    const plate = /\.site-drawer__nav a\[aria-current\]::before\s*\{[^}]*\}/u.exec(css)?.[0] ?? "";
    expect(plate).toMatch(/linear-gradient\(180deg, var\(--site-cta-from\), var\(--site-cta-to\)\)/u);
    expect(plate).toMatch(/inset 0 1px 0 rgba\(255, 255, 255/u);
    expect(css).toMatch(/\.site-drawer__nav a\[aria-current\]\s*\{[^}]*color:\s*var\(--site-paper\)/u);
  });

  it("на месте шеврона у текущего раздела — точка маркера: строка никуда не ведёт, она говорит «вы здесь»", () => {
    const css = read(CSS);
    const dot = /\.site-drawer__nav a\[aria-current\]::after\s*\{[^}]*\}/u.exec(css)?.[0] ?? "";
    expect(dot).toMatch(/background-color:\s*var\(--site-marker\)/u);
    expect(dot).toMatch(/mask:\s*none/u);
    // Наведение красит шеврон чернилами и сдвигает его; точке на чернилах это нельзя
    expect(css).toMatch(/a\[aria-current\]:hover::after[^{]*\{[^}]*background-color:\s*var\(--site-marker\)/u);
  });
});
