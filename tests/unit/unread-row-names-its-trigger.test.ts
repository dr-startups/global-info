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
  it("заголовок-адрес заголовком не печатается", () => {
    const phrase = highlightPhrase({
      row: { ...row, title: "https://rupep.org/ru/person/8095", url: "https://rupep.org/ru/person/8095", domain: "rupep.org", themeTitle: "PEP / RCA / watchlist-сигналы" },
      evidence: evidence({ title: "https://rupep.org/ru/person/8095", url: "https://rupep.org/ru/person/8095", domain: "rupep.org", snippet: "", readFailure: undefined }),
      budget: 600,
    });
    expect(phrase.full).toMatch(/^PEP \/ RCA \/ watchlist-сигналы — rupep\.org: по заголовку и описанию в выдаче;/);
    expect(phrase.full).not.toMatch(/«https?:/);
  });

  it("цитирует слова выдачи, по которым назначена тема", () => {
    const phrase = highlightPhrase({ row, evidence: evidence(), budget: 600 });
    // Фраза читается как заметка аналитика: сначала заголовок, затем тема и
    // основание, затем честная оговорка о непроверенном тексте.
    expect(phrase.full).toMatch(/^«"Хромой" бизнес боксера Кремлева/);
    expect(phrase.full).toMatch(/отнесено к теме «Криминальные \/ судебные материалы» по заголовку и описанию в выдаче \(«[^»]*уголовные дела[^»]*»\)/);
    expect(phrase.full).toMatch(/текст страницы проверить не удалось: на странице нет читаемого текста/);
    expect(phrase.full).not.toMatch(/страница не читалась|страница не прочитана|оценка по заголовку/);
  });

  it("без слова словаря в выдаче фраза остаётся прежней — цитаты не выдумываются", () => {
    const phrase = highlightPhrase({
      row: { ...row, themeTitle: "Корпоративное владение" },
      evidence: evidence({ snippet: "Умар Кремлев стал владельцем автодилера Рольф.", title: "Умар Кремлев стал владельцем «Рольфа»" }),
      budget: 600,
    });
    // Без попадания словаря — без цитаты: она не выдумывается (кавычки
    // остаются только у самого заголовка).
    expect(phrase.full).toMatch(/по заголовку и описанию в выдаче; текст страницы/);
    expect(phrase.full).not.toMatch(/\(«/);
  });
});
