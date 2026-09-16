/**
 * Цитата источника — одна функция, и она сбалансирована.
 *
 * Прогон «Чайка» 15.09.2026: `цитаты разорваны на 4 страницах` — тот же код
 * отказа, что на «Галицком» днём раньше, но другой класс: чужие ёлочки внутри
 * цитаты из вердикта модели (`««Назначить…»`, `«Мы поможем…» … Чайки.»`),
 * обрезка по бюджету, унёсшая «— источник», и цитата без домена. Восемь мест
 * собирали строку «источник → цитата», ни одно не смотрело на кавычки, а
 * ворота были единственной линией.
 *
 * Теперь ответ один — `client-quote.ts`: `sourceQuote` при сборке и
 * `normalizeQuoteMarks` на границе паков; непарная кавычка невозможна по
 * построению, а не ловится воротами.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeQuoteMarks,
  normalizeSlideQuoteMarks,
  sourceQuote,
} from "@/modules/digital-profile/orion-golden/client/client-quote";
import { quoteIntegrityProblems } from "@/modules/digital-profile/orion-golden/deck-sections/quote-integrity";
import { clampClientText } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const SRC = join(process.cwd(), "src/modules/digital-profile/orion-golden");

/** Четыре живые строки прогона «Чайка» — как их отдала сборка до правки. */
const KP =
  "Назначение и работа в Россотрудничестве (продолжение). «Владимир Путин назначил Игоря Чайку руководителем агентства» — источник (tvzvezda.ru/news/1). ««Назначить Чайку Игоря Юрьевича руководителем Федерального агентства» — источник (kp.ru/daily/27777/5241815). «Игорь Юрьевич Чайка Руководитель агентства» — источник (government.ru/persons/775). Процитировано 6 публикаций сюжета из 7.";
const VEDOMOSTI =
  "«Криминальные / судебные материалы»\nПринадлежность: не разобрана.\nНайдены публикации:\n«2 мая 2026 г. — В Сети обсуждают внешность Игоря Чайки. По имеющейся» — источник (znat-kak.livejournal.com)\n«Мы поможем это устроить» – примерно так начинали разговор с корреспондентом «Ведомостей» сразу несколько знакомых сына генерального прокурора России Юрия Чайки.» — источник (vedomosti.ru/business/articles/2015/10/05/611415)\nГде видно: znat-kak.livejournal.com, vedomosti.ru.\nВсего по теме: 17 материалов, с негативным контекстом — 13. [finding-criminal_legal-ambiguous-6327ce60]";

describe("цитата источника сбалансирована", () => {
  it("чужая открывающая ёлочка в начале цитаты снимается, вложенные становятся лапками", () => {
    expect(sourceQuote("«Назначить Чайку руководителем агентства", " — источник (kp.ru/1)")).toBe(
      "«Назначить Чайку руководителем агентства» — источник (kp.ru/1)"
    );
    expect(
      sourceQuote("Мы поможем это устроить» – так начинали разговор с корреспондентом «Ведомостей».", " — источник (vedomosti.ru/1)")
    ).toBe("«Мы поможем это устроить – так начинали разговор с корреспондентом „Ведомостей“.» — источник (vedomosti.ru/1)");
    expect(sourceQuote("«Усманов подал иск в связи с «политически мотивированными» расследованиями»", " — источник iz.ru")).toBe(
      "«Усманов подал иск в связи с „политически мотивированными“ расследованиями» — источник iz.ru"
    );
    expect(sourceQuote('Владелец "Краснодара"', "")).toBe("«Владелец „Краснодара“»");
  });

  it("живые строки «Чайки» после нормализации проходят ворота целости", () => {
    for (const raw of [KP, VEDOMOSTI]) {
      const fixed = normalizeQuoteMarks(raw);
      expect(quoteIntegrityProblems(fixed), fixed).toEqual([]);
    }
    expect(normalizeQuoteMarks(KP)).toContain("«Назначить Чайку Игоря Юрьевича руководителем Федерального агентства» — источник (kp.ru/daily/27777/5241815)");
    expect(normalizeQuoteMarks(VEDOMOSTI)).toContain("«Мы поможем это устроить – примерно так начинали разговор с корреспондентом „Ведомостей“ сразу несколько знакомых сына генерального прокурора России Юрия Чайки.» — источник (vedomosti.ru/business/articles/2015/10/05/611415)");
    // Название темы и строки без кавычек не трогаются.
    expect(normalizeQuoteMarks(VEDOMOSTI)).toContain("«Криминальные / судебные материалы»\nПринадлежность: не разобрана.");
    expect(normalizeQuoteMarks("Запрос: «Чайка Игорь». Без кавычек.")).toBe("Запрос: «Чайка Игорь». Без кавычек.");
  });

  it("обрезка многострочного блока не снимает источник у цитаты", () => {
    const block =
      "«Корпоративное владение»\nНайдены материалы о владении:\n«Он возглавил Россотрудничество весной 2026 года, а до этого был владельцем крупного российского регионального оператора по обращению с отходами.» — источник (spletnik.ru/piter-griffin-343979)";
    const cut = clampClientText(block, 200);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(quoteIntegrityProblems(cut), cut).toEqual([]);
    expect(cut).toMatch(/— источник \(spletnik\.ru\/piter-griffin-343979\)$/u);
  });

  it("сеть на границе паков правит все текстовые поля слайда", () => {
    const slide = {
      slideId: "p03_executive__cont2",
      content: {
        narrative: "Сюжет. ««Назначить Чайку» — источник (kp.ru/1).",
        bullets: [KP, "Обычный буллет."],
        whatWasFound: "«Мы поможем» – так говорили» — источник (v.ru/1)",
        whyItMatters: "Почему важно.",
      },
    } as unknown as SlideContentContract;
    const fixed = normalizeSlideQuoteMarks(slide);
    expect(fixed).not.toBe(slide);
    expect(fixed.content.narrative).toBe("Сюжет. «Назначить Чайку» — источник (kp.ru/1).");
    expect(quoteIntegrityProblems(fixed.content.bullets![0]!)).toEqual([]);
    expect(fixed.content.bullets![1]).toBe("Обычный буллет.");
    expect(fixed.content.whatWasFound).toBe("«Мы поможем – так говорили» — источник (v.ru/1)");
    expect(fixed.content.whyItMatters).toBe("Почему важно.");
  });

  it("собственных шаблонов «источник → цитата» больше нет — ответ один", () => {
    const files = [
      "analytics/canonical-claim-builder.ts",
      "analytics/client-summary-composer.ts",
      "analytics/client-summary-pack-builder.ts",
      "analytics/representative-evidence-selector.ts",
      "analytics/finding-synthesizer.ts",
      "deck-sections/fragment-builders/shared.ts",
    ];
    const own = files.filter((rel) => /«\$\{[^}]+\}»\s*(?:\$\{sourceAttribution\(|\s*—\s*источник)/u.test(readFileSync(join(SRC, rel), "utf8")));
    expect(own).toEqual([]);
  });
});
