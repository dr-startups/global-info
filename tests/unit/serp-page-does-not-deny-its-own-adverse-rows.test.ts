/**
 * Страница выдачи не отрицает негатив, который сама же напечатала строкой.
 *
 * Абзац над таблицей и колонка «Оценка» отвечали на один вопрос из двух мест:
 * абзац считал негатив по **темам** уровня «средний и выше», колонка — по
 * **строке** единым предикатом. Пока тема была средней, они совпадали; стоило
 * теме опуститься — и лист печатал «Показанные на странице материалы не
 * формируют негативного фона вокруг субъекта» прямо над строкой с оценкой
 * «Нежелательный».
 *
 * Отчёт читает сам субъект: такой лист говорит ему, что убирать нечего, и тут
 * же называет материал нежелательным.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_TABLE_HEADERS,
  buildSerpFragment,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const QUERY = "Anders Holmström";
const THEME = "Офшоры / корпоративное владение";
const ADVERSE_TITLE = "Уголовное дело против Anders Holmström";
// Номер колонки — из заголовков построителя. Числом он пережил бы сдвиг
// колонок и молча считал бы «Тип источника»: негативных значений там не бывает,
// и проверка осталась бы зелёной на чужой колонке.
const RATING_COLUMN = SERP_TABLE_HEADERS.indexOf("Оценка");

/**
 * Страница выдачи: строки `titles`, тема уровня `riskLevel` на второй строке.
 *
 * Заголовок, повторённый в `titles` дважды, — тот же материал, найденный вторым
 * запросом: таблица сводит такие наблюдения в одну строку.
 */
function serpPage(titles: string[], riskLevel: "low" | "medium") {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  titles.forEach((title, idx) => {
    const rank = idx + 1;
    const ref = `i${rank}`;
    const material = titles.indexOf(title) + 1;
    evidenceIndex[ref] = {
      title,
      url: `https://site${material}.example/${material}`,
      domain: `site${material}.example`,
      region: "RU",
      engine: "GOOGLE",
      rank,
      rankSource: "serper",
      query: QUERY,
      queryPurpose: "subject_lookup",
      subjectDecision: "SUBJECT_MATCH",
    };
    refs.push(ref);
  });
  const scoped = {
    findings: [
      {
        findingId: "f1",
        theme: THEME,
        subjectMatch: "SUBJECT_MATCH",
        claim: "«Тема»\nВсего по теме: 1 материал.",
        riskLevel,
        confidence: 0.9,
        promotionPriority: riskLevel === "low" ? "P3" : "P2",
        regions: ["RU"],
        evidenceRefs: ["i2"],
        recommendedAction: "Проверить корпоративные реестры.",
      },
    ],
    surfaceUnits: [
      { surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
  const page = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides.filter(
    (s) => s.templateId === "serp-table"
  )[0]!;
  return {
    ratings: (page.content.table?.rows ?? []).map((r) => r[RATING_COLUMN]),
    whyItMatters: String(page.content.whyItMatters ?? ""),
  };
}

/**
 * Страница без выделенной темы: она описывает свой состав числами.
 *
 * Строки задаются парами «заголовок + принадлежность наблюдения»; одинаковый
 * заголовок — тот же материал, найденный вторым запросом.
 */
function serpPageComposition(rows: Array<{ title: string; decision: string }>) {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  const titles = [...new Set(rows.map((r) => r.title))];
  rows.forEach((row, idx) => {
    const rank = idx + 1;
    const ref = `i${rank}`;
    const material = titles.indexOf(row.title) + 1;
    evidenceIndex[ref] = {
      title: row.title,
      url: `https://site${material}.example/${material}`,
      domain: `site${material}.example`,
      region: "RU",
      engine: "GOOGLE",
      rank,
      rankSource: "serper",
      query: QUERY,
      queryPurpose: "subject_lookup",
      subjectDecision: row.decision,
    };
    refs.push(ref);
  });
  const scoped = {
    findings: [],
    surfaceUnits: [
      { surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
  const page = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides.filter(
    (s) => s.templateId === "serp-table"
  )[0]!;
  return {
    ratings: (page.content.table?.rows ?? []).map((r) => r[RATING_COLUMN]),
    whatWasFound: String(page.content.whatWasFound ?? ""),
  };
}

describe("принадлежность нарисованной строки — одна на весь лист", () => {
  it("строка о субъекте, если хотя бы одно её наблюдение о субъекте", () => {
    // Один адрес, два наблюдения: первое отнесено к однофамильцу, второе — к
    // субъекту. Таблица печатает такую строку «Нежелательной», и счёт страницы
    // обязан считать её так же.
    const page = serpPageComposition([
      { title: ADVERSE_TITLE, decision: "OTHER_SUBJECT" },
      { title: ADVERSE_TITLE, decision: "SUBJECT_MATCH" },
    ]);
    expect(page.ratings).toEqual(["Нежелательный"]);
    expect(page.whatWasFound).toContain("из них о субъекте — 1");
    expect(page.whatWasFound).toContain("негативных заголовков — 1");
  });

  it("строка, все наблюдения которой о другом лице, в счёт негатива не входит", () => {
    const page = serpPageComposition([
      { title: ADVERSE_TITLE, decision: "OTHER_SUBJECT" },
      { title: ADVERSE_TITLE, decision: "OTHER_SUBJECT" },
    ]);
    expect(page.ratings).toEqual(["О другом лице"]);
    expect(page.whatWasFound).toContain("негативных заголовков — 0");
  });
});

describe("страница выдачи не спорит со своей колонкой «Оценка»", () => {
  it("низкий уровень темы не отменяет негативную строку этой же страницы", () => {
    const page = serpPage(
      ["Профиль предпринимателя", ADVERSE_TITLE, "Интервью о планах компании"],
      "low"
    );
    // Условие проверки: на листе действительно есть строка «Нежелательный».
    expect(page.ratings).toContain("Нежелательный");
    expect(page.whyItMatters).not.toContain("не формируют негативного фона");
    expect(page.whyItMatters).toContain("негативные заголовки (1)");
  });

  it("без негативных строк страница по-прежнему говорит, что фона нет", () => {
    const page = serpPage(
      ["Профиль предпринимателя", "Отчёт о выручке компании", "Интервью о планах"],
      "low"
    );
    expect(page.ratings).not.toContain("Нежелательный");
    expect(page.whyItMatters).toContain("не формируют негативного фона");
  });

  it("счёт негативных заголовков равен числу строк «Нежелательный»", () => {
    // Тот же материал, найденный вторым запросом: таблица печатает одну строку,
    // и абзац над ней обязан назвать одну, а не две ссылки.
    const page = serpPage(
      ["Профиль предпринимателя", ADVERSE_TITLE, ADVERSE_TITLE],
      "low"
    );
    expect(page.ratings.filter((r) => r === "Нежелательный")).toHaveLength(1);
    expect(page.whyItMatters).toContain("негативные заголовки (1)");
  });

  it("тема повышенного внимания названа темой, а не строками", () => {
    const page = serpPage(
      ["Профиль предпринимателя", ADVERSE_TITLE, "Интервью о планах компании"],
      "medium"
    );
    expect(page.whyItMatters).toContain("тема");
    expect(page.whyItMatters).toContain("повышенного внимания");
    expect(page.whyItMatters).not.toContain("не формируют негативного фона");
  });
});
