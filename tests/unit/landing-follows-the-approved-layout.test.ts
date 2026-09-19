import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HERO } from "@/modules/site/content/landing";

/**
 * Главная собрана по утверждённому макету (раунды 1–6, шаг 0077).
 *
 * Проверки здесь — договорённости о форме подачи, а не о вёрстке: вёрстку и
 * поведение видно только в браузере, и они снимаются Playwright отдельно. Тест
 * держит то, что легко сломать правкой мимо макета: список источников уехал из
 * формы, схема встала на место сетки карточек, закрывающий блок один на весь
 * сайт, у вопросов нет старой анимации по прокрутке.
 *
 * Классы читаются из исходников как текст — так же, как это делает
 * `site-css-declares-only-classes-the-site-uses`: разметку сайта тесты не
 * отрисовывают (окружение vitest — node, без DOM).
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
/** Комментарий может назвать класс, которого в разметке нет. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");

const PAGE = "src/app/(site)/page.tsx";
const CHECK_FORM = "src/modules/site/components/CheckForm.tsx";
const HERO_SEEK = "src/modules/site/components/landing/HeroSeek.tsx";
const CTA_BAND = "src/modules/site/components/content/CtaBand.tsx";
const SOURCES_FLOW = "src/modules/site/components/landing/SourcesFlow.tsx";
const KEEP_SCENE = "src/modules/site/components/landing/KeepScene.tsx";
const RESULT_DEMO = "src/modules/site/components/landing/ResultDemo.tsx";
const CSS = "src/app/(site)/site.css";

describe("«Будет проверено» — под строкой поиска, а не в форме", () => {
  it("форма проверки не рисует корешок со списком источников", () => {
    const form = code(CHECK_FORM);
    expect(form).not.toMatch(/site-panel__foot/u);
    expect(form).not.toMatch(/site-scan/u);
  });

  it("список рисует строка поиска — тем же таймером, что печатает запрос", () => {
    const seek = code(HERO_SEEK);
    expect(seek).toMatch(/site-checks/u);
    expect(seek).toMatch(/site-checks__list/u);
    // Отметки ставит скрипт; в разметке они уже стоят — без скрипта список
    // говорит то же самое, а не выглядит невыполненным списком дел. Смотреть
    // надо именно в разметку: `is-on` есть и в скрипте, который отметки снимает.
    const markup = seek.slice(seek.indexOf("return ("));
    expect(markup).toMatch(/is-on/u);
  });

  it("сами источники живут в контенте, а не в разметке", () => {
    expect(HERO.checksTitle).toBe("Будет проверено");
    expect(HERO.checks.length).toBe(5);
    expect(code(HERO_SEEK)).not.toMatch(/поисковая выдача/u);
  });
});

describe("«Где мы ищем» — схема, а не сетка карточек", () => {
  it("главная больше не рисует сетку карточек источников", () => {
    expect(code(PAGE)).not.toMatch(/site-sources-grid/u);
  });

  it("схему рисует свой клиентский компонент", () => {
    expect(existsSync(join(root, SOURCES_FLOW)), SOURCES_FLOW).toBe(true);
    const flow = code(SOURCES_FLOW);
    expect(flow).toMatch(/^"use client";/u);
    expect(flow).toMatch(/site-flow__wires/u);
    expect(flow).toMatch(/site-flow__root/u);
    expect(flow).toMatch(/site-flow__result/u);
  });
});

describe("«Проверка остаётся вашим делом» — одна широкая сцена", () => {
  it("три узкие колонки сроков убраны", () => {
    const page = code(PAGE);
    expect(page).not.toMatch(/site-term__stage/u);
    expect(page).not.toMatch(/site-term__record/u);
  });

  it("сцену проигрывает свой клиентский компонент, и её можно показать ещё раз", () => {
    expect(existsSync(join(root, KEEP_SCENE)), KEEP_SCENE).toBe(true);
    const keep = code(KEEP_SCENE);
    expect(keep).toMatch(/^"use client";/u);
    expect(keep).toMatch(/site-keep__scene/u);
    expect(keep).toMatch(/site-keep__replay/u);
  });
});

describe("Пример результата: строка стадии не меняет высоту панели", () => {
  it("подпись и кнопка — две колонки сетки, подписи отведено две строки", () => {
    const css = read(CSS);
    expect(css).toMatch(/\.site-demo__row\s*\{[^}]*display:\s*grid/u);
    expect(css).toMatch(/\.site-demo__stage\s*\{[^}]*min-height:/u);
  });

  it("длинная стадия есть в контенте — иначе проверять нечего", () => {
    expect(code(RESULT_DEMO)).toMatch(/site-demo__stage/u);
  });
});

describe("Вопросы: появление один раз, через observer", () => {
  it("у вопросов нет анимации по scroll-таймлайну списка", () => {
    const css = read(CSS);
    // Список меняет высоту при раскрытии ответа, и последний вопрос попадал
    // обратно в диапазон своей анимации — ответ оставался размытым.
    expect(css).not.toMatch(/\.site-faq\s*\{[^}]*view-timeline-name/u);
    expect(css).not.toMatch(/\.site-faq details\s*\{[^}]*animation-timeline/u);
  });

  it("главная просит появление по одному у общего механизма", () => {
    expect(code(PAGE)).toMatch(/site-reveal--stagger/u);
  });
});

describe("Закрывающий блок — один на весь сайт", () => {
  it("его классы живут в CtaBand, а не в разметке главной", () => {
    expect(code(CTA_BAND)).toMatch(/site-final/u);
    expect(code(PAGE)).not.toMatch(/site-final__copy|site-final__title|site-final__art/u);
  });

  it("на главной он открывается из-под листа — это разметка страницы, а не блока", () => {
    const page = code(PAGE);
    expect(page).toMatch(/site-final-wrap/u);
    expect(code(CTA_BAND)).not.toMatch(/site-final-wrap/u);
  });

  it("две кнопки блока одной ширины: ряд — сетка с равными колонками", () => {
    // Высота и кегль у них и так общие; ширины 246 и 238 px читались ошибкой (владелец 19.09.2026).
    expect(read(CSS)).toMatch(/\.site-final__actions\s*\{[^}]*grid-auto-columns:\s*1fr/u);
  });

  it("на широком экране ряд кнопок не шире текста над ним: кегль и поля кнопок там меньше", () => {
    // С 1200 px подводка занимает около 464 px, а две кнопки по 246 — 508: ряд торчал правее текста
    // (владелец 19.09.2026). Сама ширина видна только в браузере и снимается замером Playwright;
    // тест держит правило, которое её даёт.
    const css = read(CSS);
    const wide = css.slice(css.lastIndexOf("@media (min-width: 1200px) {", css.indexOf(".site-price {")));
    expect(wide).toMatch(/\.site-final__actions \.site-btn\s*\{[^}]*font-size:\s*var\(--site-text-sm\)/u);
    expect(wide).toMatch(/\.site-final__actions \.site-btn\s*\{[^}]*padding-inline:\s*16px;/u);
    // Круг стрелки стоит на правом поле: у кнопки со стрелкой оно прежнее
    expect(wide).toMatch(/\.site-final__actions \.site-btn--accent\s*\{[^}]*padding-inline-end:\s*24px/u);
  });

  it("кадр — два файла: широкий и вертикальный для телефона", () => {
    const band = code(CTA_BAND);
    expect(band).toMatch(/final-mobile/u);
    for (const file of ["final-2560.webp", "final-1600.webp", "final-mobile-1400.webp", "final-mobile-800.webp"]) {
      expect(existsSync(join(root, "public/site", file)), file).toBe(true);
    }
  });
});

describe("Порядок глав: закрывающий блок — последним (владелец 19.09.2026)", () => {
  const at = (needle: string) => {
    const index = code(PAGE).indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it("«Вопросы» не стоят перед закрывающим блоком: между ними «Полезно знать»", () => {
    // Вопросы раскрываются и двигают кромку листа; последней главой они вставали
    // вплотную к чернилам, и блок открывался раньше, чем список дочитан.
    expect(at('id="safety"')).toBeLessThan(at('id="faq"'));
    expect(at('id="faq"')).toBeLessThan(at('id="blog"'));
    expect(at('id="blog"')).toBeLessThan(at("site-final-wrap"));
  });

  it("после закрывающего блока листа нет — дальше подвал", () => {
    const page = code(PAGE);
    expect(page.slice(at("site-final-wrap"))).not.toMatch(/site-sheet/u);
    expect(page).not.toMatch(/site-sheet--last/u);
    expect(read(CSS)).not.toMatch(/\.site-sheet--last/u);
  });

  it("у блока нет хвоста под въезжающий лист", () => {
    const css = read(CSS);
    expect(css).not.toMatch(/\.site-final-wrap \.site-final\s*\{[^}]*bottom:\s*-88px/u);
    expect(css).not.toMatch(/\.site-final-wrap \.site-final\s*\{[^}]*padding-bottom:\s*88px/u);
  });

  it("под последней главой листа перед блоком воздуха больше обычного", () => {
    expect(read(CSS)).toMatch(/\.site-sheet:has\(\+ \.site-final-wrap\)\s*\{[^}]*padding-bottom:\s*clamp\(/u);
  });
});

describe("Якорь #how приводит в заполненный ряд шагов", () => {
  it("якорь стоит на метке внутри дорожки, а не на секции", () => {
    const page = code(PAGE);
    expect(page).not.toMatch(/<section[^>]*id="how"/u);
    const track = page.slice(page.indexOf("site-how__track"), page.indexOf("site-how__pin"));
    expect(track).toMatch(/site-how__anchor/u);
    expect(track).toMatch(/id="how"/u);
    expect(track).toMatch(/data-anchor="how"/u);
  });

  it("в ветке с закреплением метка сдвинута к концу хода, вне её — в начале дорожки", () => {
    const css = read(CSS);
    expect(css).toMatch(/\.site-how__anchor\s*\{[^}]*top:\s*0;/u);
    // Смещение живёт рядом с диапазонами карточек: после `.site-how__pin` и до
    // правила первой карточки — то есть внутри той же ветки @supports / @media.
    const branch = css.slice(css.indexOf(".site-how__pin {"), css.indexOf("--rise: cover 50vh"));
    expect(branch).toMatch(/\.site-how__anchor\s*\{[^}]*top:\s*92vh/u);
  });
});

describe("«Полезно знать» — лента статей на главной", () => {
  it("главная рисует ленту статей", () => {
    const page = code(PAGE);
    expect(page).toMatch(/site-more__pane/u);
    expect(page).toMatch(/site-blog/u);
  });

  it("в блог ведёт заголовок-ссылка, отдельной кнопки «Все статьи» нет", () => {
    const page = code(PAGE);
    expect(page).toMatch(/site-more__link/u);
    expect(page).not.toMatch(/Все статьи/u);
  });
});

describe("Обложки серии 5", () => {
  it("все десять обложек на месте", () => {
    const names = [1, 2, 3, 4, 5, 6].map((i) => `cover-b${i}`).concat([1, 2, 3, 4].map((i) => `cover-s${i}`));
    for (const name of names) {
      expect(existsSync(join(root, `public/site/covers/${name}.webp`)), name).toBe(true);
    }
  });
});
