import { describe, it, expect } from "vitest";
import {
  classifyCanonicalThemes,
  CANONICAL_THEME_DEFS,
} from "../../src/modules/digital-profile/orion-golden/analytics/canonical-themes";

/**
 * Шаг 06.1 плана переработки.
 *
 * До исправления регексы работали по подстроке без границ слов (JS `\b` не
 * действует на кириллице), поэтому нейтральные тексты получали риск-темы:
 * «судьба» → криминал, «политехнический» → политическая экспозиция,
 * «my favorite messenger» → политическая экспозиция.
 */

/** Тексты, которые не должны порождать НИ ОДНОЙ темы риска. */
const NEUTRAL_TEXTS = [
  // Без деловых слов — иначе сработает business_ownership_associates, и это верно.
  "судьба героя романа сложилась непросто",
  "государственное судостроение и морские перевозки",
  "политехнический университет опубликовал исследование",
  "my favorite messenger app of 2026",
  "партия товара задержана на складе",
  "выборка данных для аналитического отчёта",
  "администрация сайта обновила правила",
  "вследствие технических работ сервис недоступен",
  "как следствие, компания сменила стратегию",
  "цена на подписку снижена вдвое",
  "courtesy of the design team",
  "the courtship of modern messengers",
  "bleak outlook for the sector",
  "governance of open-source projects",
  // Критерий приёмки шага 06 требует набора из двадцати фраз: граница слова
  // ломается на разных стыках, и одной формы на правило мало.
  "презентация нового мессенджера прошла в Дубае",
  "делопроизводство переведено в электронный вид",
  "исследование посвящено судоходству в Арктике",
  "the company announced a partnership with a design studio",
  "конференция по машинному обучению собрала тысячу участников",
  "обновление приложения улучшило время отклика",
];

/** Тексты, которые обязаны сохранить свою тему после ужесточения границ. */
const MUST_MATCH: Array<[string, string]> = [
  ["против него возбуждено уголовное дело", "criminal_judicial"],
  ["суд вынес приговор по делу о мошенничестве", "criminal_judicial"],
  ["судебное разбирательство завершилось в пользу истца", "criminal_judicial"],
  ["он был осуждён на три года", "criminal_judicial"],
  ["arrested at the airport, faces fraud charges", "criminal_judicial"],
  ["следственный комитет завершил проверку", "criminal_judicial"],
  ["дело о коррупции и взятках в министерстве", "corruption_integrity"],
  ["включён в санкционный список OFAC", "sanctions_pep_rca_compliance"],
  ["политическая карьера и связи с парламентом", "political_public_exposure"],
  ["выборы прошли с нарушениями", "political_public_exposure"],
  ["министр финансов прокомментировал ситуацию", "political_public_exposure"],
  ["предприниматель и инвестор, совладелец холдинга", "business_ownership_associates"],
  ["офшорная структура на Кипре и яхта", "offshore_financial_transparency"],
  ["регулятор отозвал лицензию", "regulatory"],
  ["громкий скандал и журналистское расследование", "reputational_scandal"],
  ["его жена и дети живут за границей", "family_personal_risk_relevant"],
];

describe("canonical themes — Unicode word boundaries", () => {
  it("не назначает риск-темы нейтральным текстам", () => {
    const offenders: Array<{ text: string; themes: string[] }> = [];
    for (const text of NEUTRAL_TEXTS) {
      const themes = classifyCanonicalThemes(text);
      if (themes.length > 0) offenders.push({ text, themes });
    }
    expect(offenders).toEqual([]);
  });

  it("сохраняет настоящие срабатывания по каждой теме", () => {
    const misses: Array<{ text: string; expected: string; got: string[] }> = [];
    for (const [text, expected] of MUST_MATCH) {
      const themes = classifyCanonicalThemes(text);
      if (!themes.includes(expected as never)) {
        misses.push({ text, expected, got: themes });
      }
    }
    expect(misses).toEqual([]);
  });

  it("не оставляет тем, привязанных к конкретному кейсу", () => {
    // Файл декларирует «No subject names / case plots in runtime keywords»,
    // но содержал «навальн», «рыбк», «композитор», «дворянск» — следы разбора
    // одного дела, которые ловили посторонние тексты.
    const caseSpecific = ["навальн", "navalny", "рыбк", "rybka", "композитор", "дворянск"];
    const offenders = CANONICAL_THEME_DEFS.filter((def) =>
      caseSpecific.some((needle) => def.keywords.source.toLowerCase().includes(needle))
    ).map((def) => def.themeId);
    expect(offenders).toEqual([]);
  });

  it("каждая тема компилируется в юникод-регекс", () => {
    for (const def of CANONICAL_THEME_DEFS) {
      expect(def.keywords.flags).toContain("u");
      expect(def.keywords.flags).toContain("i");
    }
  });
});
