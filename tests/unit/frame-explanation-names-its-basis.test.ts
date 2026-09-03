/**
 * Рамку объясняет то, чем она поставлена.
 *
 * Страница «почему выделено» — единственное место, где красная рамка называет
 * своё основание, и проверяющий в банке пойдёт ровно по нему. Пока основание
 * было одно на всех («оценка по заголовку и сниппету выдачи»), строка, выделенная
 * **решением аналитика**, предъявляла банку заголовок, в котором негатива нет
 * вовсе: «Anders Holmström, CEO of Nordkap Capital AB — fintech investor
 * profile». Проверяющий не находит там ничего и делает вывод хуже правды —
 * будто отчёт выделяет строки наугад.
 *
 * Тема материала при этом остаётся, но пояснением, а не заголовком: «Деловой
 * профиль» над красной рамкой спорит с самой рамкой.
 */

import { describe, expect, it } from "vitest";
import { highlightPhrase } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VisibleAssetItem } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

const TITLE = "Anders Holmström, CEO of Nordkap Capital AB — fintech investor profile";

const row: VisibleAssetItem = {
  ref: "inventory:obs-analyst",
  url: "https://finansbladet.se/anders-holmstrom",
  domain: "finansbladet.se",
  title: TITLE,
  adverse: true,
  themeTitle: "Потенциально негативные публикации",
};

const FINDING = {
  findingId: "finding-business_profile-subject_match-15a54088",
  theme: "Деловой профиль",
  claim: "Найдены материалы делового и биографического профиля:\nВсего по теме: 3 материала.",
  riskLevel: "low",
  regions: ["RU"],
  evidenceRefs: ["inventory:obs-analyst"],
} as unknown as Finding;

function index(over: Partial<ScopedEvidenceIndex[string]> = {}): ScopedEvidenceIndex {
  return {
    "inventory:obs-analyst": {
      url: "https://finansbladet.se/anders-holmstrom",
      domain: "finansbladet.se",
      title: TITLE,
      ...over,
    },
  };
}

describe("строку, выделенную аналитиком, объясняет решение аналитика", () => {
  it("непрочитанная страница: основание — человек, а не заголовок выдачи", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index({ analystDecision: "ADVERSE" }),
      finding: FINDING,
    });
    expect(phrase.sidebar).toBe(
      "Отмечено аналитиком — finansbladet.se; тема материала — «Деловой профиль»; " +
        "материал учтён в находках отчёта."
    );
    expect(phrase.sidebar).not.toContain("оценка по заголовку и сниппету выдачи");
  });

  it("тема стоит пояснением, а не заголовком красной рамки", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index({ analystDecision: "ADVERSE" }),
      finding: FINDING,
    });
    expect(phrase.sidebar.startsWith("Деловой профиль")).toBe(false);
    expect(phrase.sidebar).toContain("«Деловой профиль»");
  });

  it("прочитанная страница с нейтральным вердиктом объясняется тем же основанием", () => {
    // Иначе рамка объяснялась бы сюжетом и цитатой страницы, которую человек
    // как раз и переоценил, — то есть снова не тем, чем она поставлена.
    const phrase = highlightPhrase({
      row,
      evidence: index({
        analystDecision: "ADVERSE",
        verdictTheme: "Профиль основателя финтех-компании",
        pageQuote: "Компания открыла офис в Стокгольме.",
        readVerdictTone: "neutral",
      }),
      finding: FINDING,
    });
    expect(phrase.sidebar).toContain("Отмечено аналитиком");
    expect(phrase.sidebar).not.toContain("Компания открыла офис");
    expect(phrase.sidebar).not.toContain("На странице finansbladet.se");
  });

  it("строке, которую аналитик уже посмотрел, ручная проверка не назначается", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index({ analystDecision: "ADVERSE" }),
    });
    expect(phrase.sidebar).toBe(
      "Отмечено аналитиком — finansbladet.se; тема материала — «Потенциально негативные публикации»."
    );
    expect(phrase.sidebar).not.toContain("требует ручной проверки");
  });
});

describe("без решения аналитика фраза прежняя", () => {
  it("непрочитанная строка по-прежнему называет заголовок выдачи основанием", () => {
    const phrase = highlightPhrase({ row, evidence: index(), finding: FINDING });
    expect(phrase.sidebar).toBe(
      "Деловой профиль — finansbladet.se; страница не читалась в этом прогоне, " +
        "оценка по заголовку и сниппету выдачи; материал учтён в находках отчёта. " +
        // Адрес называет материал: без него два материала одного издания под
        // одной рубрикой давали дословно одинаковую строку.
        "(finansbladet.se/anders-holmstrom)."
    );
  });

  it("прочитанная строка по-прежнему говорит словами страницы", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index({
        verdictTheme: "Санкции ЕС и заморозка активов",
        pageQuote: "Активы компании заморожены решением Совета ЕС.",
        readVerdictTone: "adverse",
      }),
    });
    expect(phrase.sidebar).toContain("На странице finansbladet.se — Санкции ЕС и заморозка активов");
    expect(phrase.sidebar).toContain("«Активы компании заморожены решением Совета ЕС.»");
  });
});
