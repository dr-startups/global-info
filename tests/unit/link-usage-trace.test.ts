/**
 * След «что сказала модель о ссылке → что дошло до отчёта».
 *
 * По готовому отчёту нельзя понять, почему конкретной ссылки в нём нет: её не
 * прочитали, вывод понизили или цитату забраковали. Между решением и страницей
 * лежит десяток отборов, и каждый осмыслен по отдельности, а вместе они
 * непрозрачны. След отвечает на это одной строкой на ссылку.
 */

import { describe, expect, it } from "vitest";
import {
  buildLinkUsageTrace,
  linkUsageLogLine,
} from "@/modules/digital-profile/orion-golden/deck-sections/link-usage-trace";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const QUOTE =
  "Официально Усманов был реабилитирован в 2000 году Верховным судом Узбекистана, признавшим дело сфабрикованным";

const evidenceIndex = {
  "inventory:quoted": {
    url: "https://ru.wikipedia.org/wiki/Усманов",
    domain: "ru.wikipedia.org",
    rank: 1,
    region: "RU",
    title: "Усманов, Алишер Бурханович — Википедия",
    readVerdictTone: "adverse",
    verdictTheme: "Биография с упоминанием судимости",
    pageQuote: QUOTE,
  },
  "inventory:by-title": {
    url: "https://tass.ru/persona",
    domain: "tass.ru",
    rank: 4,
    region: "RU",
    title: "Усманов, Алишер Бурханович - ПЕРСОНА ТАСС",
    readVerdictTone: "neutral",
    verdictTheme: "Справочная карточка",
  },
  "inventory:table-only": {
    url: "https://svpressa.ru/persons/alisher-usmanov",
    domain: "svpressa.ru",
    rank: 11,
    region: "RU",
    title: "Биография Алишера Бурхановича Усманова",
    readVerdictTone: "supportive",
  },
  "inventory:missing": {
    url: "https://example.org/nothing",
    domain: "example.org",
    rank: 19,
    region: "RU",
    title: "Материал, не дошедший до отчёта",
    readVerdictTone: "neutral",
  },
  "inventory:not-judged": {
    url: "https://other.example/page",
    domain: "other.example",
    title: "Страницу не читали, решения нет",
  },
} as unknown as ScopedEvidenceIndex;

const slides = [
  {
    slideKey: "p07_ru_summary",
    bullets: [`«Криминальные / судебные материалы»\n«${QUOTE}» — источник ru.wikipedia.org`],
  },
  {
    slideKey: "p09_ru_serp_table",
    table: {
      rows: [
        ["4", "tass.ru/persona", "Усманов, Алишер Бурханович - ПЕРСОНА ТАСС", "—", "Нейтральный"],
        ["11", "svpressa.ru/persons/alisher-usmanov", "Биография", "—", "Нейтральный"],
      ],
    },
  },
];

describe("след использования ссылок", () => {
  const trace = buildLinkUsageTrace({ evidenceIndex, slides });

  it("в след попадают только ссылки с решением модели", () => {
    expect(trace.rows.map((r) => r.evidenceRef)).not.toContain("inventory:not-judged");
    expect(trace.summary.total).toBe(4);
  });

  it("цитата со страницы узнаётся", () => {
    const row = trace.rows.find((r) => r.evidenceRef === "inventory:quoted")!;
    expect(row.usage).toBe("цитата со страницы");
    expect(row.slides).toContain("p07_ru_summary");
    expect(row.theme).toBe("Биография с упоминанием судимости");
  });

  it("материал, показанный заголовком, отличается от процитированного", () => {
    const row = trace.rows.find((r) => r.evidenceRef === "inventory:by-title")!;
    expect(row.usage).toBe("заголовок из выдачи");
    expect(row.slides).toContain("p09_ru_serp_table");
  });

  it("строка таблицы без заголовка учитывается как «без цитаты»", () => {
    const row = trace.rows.find((r) => r.evidenceRef === "inventory:table-only")!;
    expect(row.usage).toBe("без цитаты");
  });

  it("не дошедшая до отчёта ссылка названа прямо", () => {
    const row = trace.rows.find((r) => r.evidenceRef === "inventory:missing")!;
    expect(row.usage).toBe("не дошла");
    expect(row.slides).toEqual([]);
  });

  it("свод сходится с построчным разбором", () => {
    const s = trace.summary;
    expect(s.quotedFromPage + s.quotedFromTitle + s.withoutQuote + s.missing).toBe(s.total);
    expect(linkUsageLogLine(trace)).toContain("разобрано 4");
    expect(linkUsageLogLine(trace)).toContain("не дошло — 1");
  });

  it("порядок строк устойчив: артефакт сравним между прогонами", () => {
    const again = buildLinkUsageTrace({ evidenceIndex, slides });
    expect(again.rows.map((r) => r.evidenceRef)).toEqual(trace.rows.map((r) => r.evidenceRef));
  });
});
