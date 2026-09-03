/**
 * Непрочитанная страница с темой называет, откуда тема.
 *
 * Отчёт 83, стр. 36: «Криминальные / судебные материалы — dzen.ru; страница не
 * прочитана: на странице нет читаемого текста, оценка по заголовку выдачи».
 * Владелец спросил: не прочитано — почему тогда «криминал»? Тема пришла из
 * сниппета выдачи («…возбуждены уголовные дела…» — про другое лицо), и без
 * самой фразы это не проверить. Правило продукта: утверждение прослеживается
 * до наблюдения, а наблюдение здесь — заголовок и сниппет выдачи, значит их
 * слова и печатаются (решение владельца 03.09.2026, В3).
 */

import { describe, expect, it } from "vitest";
import { highlightPhrase } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const REF = "inventory:dzen";
const SNIPPET =
  "Человек с \"пятнистой\" биографией стал владельцем компании \"Рольф\". Напомним, что еще в 2019 г. " +
  "против основателя компании \"Рольф\" Сергея Петрова были возбуждены уголовные дела по подозрению " +
  "в незаконных валютных операциях.";

function evidence(over: Record<string, unknown> = {}): ScopedEvidenceIndex {
  return {
    [REF]: {
      url: "https://dzen.ru/a/ZtYRD_a9DR1skreI",
      domain: "dzen.ru",
      title: "\"Хромой\" бизнес боксера Кремлева | The Moscow Post | Дзен",
      snippet: SNIPPET,
      readFailure: "empty_text",
      ...over,
    },
  } as unknown as ScopedEvidenceIndex;
}

const row = { ref: REF, url: "https://dzen.ru/a/ZtYRD_a9DR1skreI", domain: "dzen.ru", title: "\"Хромой\" бизнес боксера Кремлева", adverse: true, themeTitle: "Криминальные / судебные материалы" };

describe("фраза о непрочитанной странице", () => {
  it("цитирует слова выдачи, по которым назначена тема", () => {
    const phrase = highlightPhrase({ row, evidence: evidence(), budget: 600 });
    expect(phrase.full).toMatch(/страница не прочитана: на странице нет читаемого текста/);
    expect(phrase.full).toMatch(/оценка по заголовку и сниппету выдачи/);
    expect(phrase.full).toMatch(/«[^»]*уголовные дела[^»]*»/);
    expect(phrase.full).not.toMatch(/оценка по заголовку выдачи[;.]/);
  });

  it("без слова словаря в выдаче фраза остаётся прежней — цитаты не выдумываются", () => {
    const phrase = highlightPhrase({
      row: { ...row, themeTitle: "Корпоративное владение" },
      evidence: evidence({ snippet: "Умар Кремлев стал владельцем автодилера Рольф.", title: "Умар Кремлев стал владельцем «Рольфа»" }),
      budget: 600,
    });
    // Без попадания словаря — без кавычек вовсе: цитата не выдумывается.
    expect(phrase.full).toMatch(/оценка по заголовку и сниппету выдачи; материал учтён|оценка по заголовку и сниппету выдачи — требует/);
    expect(phrase.full).not.toMatch(/«/);
  });
});
