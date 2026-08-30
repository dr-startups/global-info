import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CARD_NARRATIVE_CHAR_BUDGET,
  DECK_TEMPLATE_REGISTRY,
} from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";

/**
 * Бюджет абзаца карточной страницы не выше того, что в неё влезает.
 *
 * Карточка `content_card` выбрасывает невлезшее **до** отрисовки и не пишет об
 * этом ни `record_text_layout`, ни `droppedLines`: молчаливая потеря, которую
 * не видит ни телеметрия, ни ворота приёмки. Значит, единственная защита —
 * объявленный бюджет, и он обязан быть **не выше** замера.
 *
 * Замер (повторяется скриптом, который рисует карточку тем же вызовом, что и
 * рендерер, и сравнивает длину нарисованного с поданным):
 *
 *   ветка `slides.py` → `_render_status_cards` → `content_card`
 *   y после ctx.title(320 000) = 1 270 000; budget = min(1 700 000, CONTENT_BOTTOM − y) = 1 700 000
 *   padding 100 000; title_size 11 → title_h = 219 572; bodyBudget = 1 280 428 EMU
 *   `_scale_steps_below(11) = [9]` — карточка шагает с 11 pt сразу на 9 pt
 *   ёмкость по текстам: 1016 (абзац золотого кейса), 1022 (абзац эталона-72),
 *   1102 (проза с адресами и латиницей), 1146 (короткие слова)
 *
 * Пол диапазона — 1016 знаков, и правило проверяется относительно него.
 */

/** Пол замеренной ёмкости карточки: ниже него не опускается ни один текст. */
const MEASURED_CARD_CAPACITY_FLOOR = 1016;

const SLIDES_PY = join(process.cwd(), "renderer/orion_golden_render/slides.py");
const REGISTRY_TS = join(
  process.cwd(),
  "src/modules/digital-profile/orion-golden/deck-sections/template-registry.ts"
);

/**
 * Шаблоны рендерера, которые действительно рисуются карточной веткой.
 *
 * Разбор понимает **одну** форму — `if template == "…":` с ранним `return` в
 * конце ветки; так написаны все двадцать веток `slides.py`. Появится `elif`
 * или `if template in (…)`, и такая ветка сюда не попадёт — поэтому число
 * разобранных веток сверяется отдельным утверждением ниже.
 */
function cardTemplatesInRenderer(): string[] {
  const src = readFileSync(SLIDES_PY, "utf8");
  const out: string[] = [];
  for (const part of rendererTemplateBranches(src)) {
    if (part.body.includes("_render_status_cards(")) out.push(part.name);
  }
  return [...new Set(out)].sort();
}

/** Ветки `if template == "…"` и их тела — до начала следующей ветки. */
function rendererTemplateBranches(src: string): Array<{ name: string; body: string }> {
  const parts = src.split(/if template == "/u).slice(1);
  return parts.map((part) => ({
    name: part.slice(0, part.indexOf('"')),
    body: part,
  }));
}

const cardEntries = () =>
  Object.values(DECK_TEMPLATE_REGISTRY).filter((t) => cardTemplatesInRenderer().includes(t.rendererTemplate));

describe("ёмкость карточной страницы", () => {
  it("ни один карточный шаблон не объявляет бюджет выше замера", () => {
    // Правило, а не три проверенных числа: следующий шаблон на той же ветке
    // попадёт под него сам.
    const offenders = cardEntries()
      .map((t) => ({
        id: t.templateId,
        budget: t.layout.narrativeCharBudget ?? 0,
      }))
      .filter((t) => t.budget > MEASURED_CARD_CAPACITY_FLOOR);

    expect(offenders).toEqual([]);
  });

  it("страница проверки и лист «Кого проверяли» объявляют одно и то же число", () => {
    // Раскладка у них одна: тот же `content_card` с теми же min_h/max_h/padding
    // и тем же кеглем. Два числа на одну ёмкость разъедутся при первой правке.
    expect(DECK_TEMPLATE_REGISTRY["persona-check"].layout.narrativeCharBudget).toBe(
      DECK_TEMPLATE_REGISTRY["wikipedia-check"].layout.narrativeCharBudget
    );
  });

  it("ёмкость объявлена одной именованной константой", async () => {
    const registry = (await import(
      "@/modules/digital-profile/orion-golden/deck-sections/template-registry"
    )) as Record<string, unknown>;
    const declared = registry.CARD_NARRATIVE_CHAR_BUDGET;

    expect(typeof declared).toBe("number");
    expect(declared).toBe(DECK_TEMPLATE_REGISTRY["wikipedia-check"].layout.narrativeCharBudget);
    expect(declared).toBe(DECK_TEMPLATE_REGISTRY["persona-check"].layout.narrativeCharBudget);
  });

  it("константа не выше замеренного пола", () => {
    // Тест обязан краснеть на попытке поднять число «чтобы прошло»: за ним
    // стоит замер, а не соглашение.
    const budget = DECK_TEMPLATE_REGISTRY["wikipedia-check"].layout.narrativeCharBudget ?? 0;

    expect(budget).toBeLessThanOrEqual(MEASURED_CARD_CAPACITY_FLOOR);
    expect(budget).toBeGreaterThan(0);
  });

  it("карточные шаблоны берут бюджет из константы, а не пишут число", () => {
    /*
     * Сравнение значений этого не держит: дефект, который чинит эта работа,
     * начался ровно с двух копий одного числа (998 и 1113), и совпади они
     * тогда — сторож молчал бы. Поэтому смотрим на **источник**.
     *
     * Число **ниже** константы литералом законно: это сид содержимого
     * (`coverage-empty-state` объявляет 360 — сколько текста кладёт
     * построитель, а не сколько влезает в карточку). Заявкой о ёмкости
     * является только число, равное ёмкости или выше, — оно и обязано
     * приходить из одного места.
     */
    const src = readFileSync(REGISTRY_TS, "utf8");
    const cardIds = new Set(cardEntries().map((t) => t.templateId));
    // Литерал приписывается **ближайшему предшествующему** объявлению
    // шаблона: окно в N знаков промахивалось мимо длинных комментариев между
    // ними, и мутация «objявить 998 числом» проходила молча.
    const declaredBy = (index: number): string => {
      const before = [...src.slice(0, index).matchAll(/templateId: "([a-z0-9-]+)"/gu)];
      return before.length ? String(before[before.length - 1]![1]) : "";
    };
    const offenders = [...src.matchAll(/narrativeCharBudget:\s*(\d+)/gu)]
      .map((m) => ({ value: Number(m[1]), owner: declaredBy(m.index) }))
      .filter((l) => cardIds.has(l.owner as never) && l.value >= CARD_NARRATIVE_CHAR_BUDGET);

    expect(offenders).toEqual([]);
  });

  it("разбор рендерера видит все ветки шаблонов, а не часть", () => {
    // Число веток — сторож самого разбора: изменится форма `if template == …`,
    // и список карточных шаблонов молча опустеет.
    const src = readFileSync(SLIDES_PY, "utf8");

    expect(rendererTemplateBranches(src).length).toBeGreaterThanOrEqual(20);
    expect(rendererTemplateBranches(src).every((b) => b.name.startsWith("orion_golden_"))).toBe(true);
  });

  it("список карточных шаблонов сверяется с самим рендерером", () => {
    // Появится третий шаблон на этой ветке — правило накроет и его, а не
    // промолчит: список берётся из `slides.py`, а не переписан руками.
    const inRenderer = cardTemplatesInRenderer();

    expect(inRenderer).toEqual([
      "orion_golden_no_data_compact",
      "orion_golden_wikipedia_check",
    ]);
    expect(cardEntries().map((t) => t.templateId).sort()).toContain("persona-check");
  });
});
