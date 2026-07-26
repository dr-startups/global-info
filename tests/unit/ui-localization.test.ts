import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ru } from "../../src/modules/digital-profile/i18n/dictionaries/ru";
import { en } from "../../src/modules/digital-profile/i18n/dictionaries/en";
import {
  describeEmptyStateReason,
  describeGptStage1Status,
} from "../../src/modules/digital-profile/client/report-quality-labels";

/**
 * Шаг 11.4 плана (docs/rework/11-workflow-ux-and-false-failures.md).
 *
 * При выбранном английском половина панелей оставалась русской: «Профиль
 * субъекта», «Качество отчёта», «Скачать Unified PDF», «Пересобрать отчёт»,
 * «Повторить только задачу Suggestions». Переключатель языка создавал
 * впечатление, что локализация есть, — а её не было.
 *
 * Этот тест не даёт русской строке вернуться в разметку панелей рабочего
 * процесса и проверяет, что английский словарь действительно английский.
 */

const CLIENT_DIR = join(process.cwd(), "src/modules/digital-profile/client");

/** Панели, которые оператор видит на пути «создать кейс → получить отчёт». */
const WORKFLOW_FILES = [
  "CaseHeader.tsx",
  "CaseDetailView.tsx",
  "CaseTabs.tsx",
  "ReportPreviewPanel.tsx",
  "ReportQualityPanel.tsx",
  "SubjectProfilePanel.tsx",
  "AgentsTab.tsx",
  "components.tsx",
  "unified-suggestions-retry-ui.ts",
];

const CYRILLIC = /[А-Яа-яЁё]/u;

/** Комментарии — не интерфейс: их язык проверять незачем. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^[ \t]*\/\/.*$/gmu, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, "");
}

describe("локализация рабочего процесса", () => {
  it("в разметке панелей нет русских строк — только ключи словаря", () => {
    const offenders: string[] = [];
    for (const file of WORKFLOW_FILES) {
      const code = stripComments(readFileSync(join(CLIENT_DIR, file), "utf8"));
      for (const [i, line] of code.split("\n").entries()) {
        if (CYRILLIC.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Все листья словаря как пары «путь → строка». */
function flatten(node: unknown, prefix = ""): Array<[string, string]> {
  if (typeof node === "string") return [[prefix, node]];
  if (!node || typeof node !== "object") return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k)
  );
}

describe("словари", () => {
  const ruLeaves = flatten(ru);
  const enLeaves = flatten(en);

  it("совпадают по набору ключей", () => {
    expect(enLeaves.map(([k]) => k).sort()).toEqual(ruLeaves.map(([k]) => k).sort());
  });

  it("в английском словаре нет кириллицы", () => {
    // Исключение — раздел выбора языка: «Русский» там и должен быть по-русски.
    const allowed = new Set(["language.ru"]);
    const offenders = enLeaves.filter(([k, v]) => !allowed.has(k) && CYRILLIC.test(v));
    expect(offenders.map(([k]) => k)).toEqual([]);
  });

  it("ни один перевод не пуст", () => {
    expect(enLeaves.filter(([, v]) => v.trim() === "").map(([k]) => k)).toEqual([]);
    expect(ruLeaves.filter(([, v]) => v.trim() === "").map(([k]) => k)).toEqual([]);
  });
});

describe("подписи диагностических кодов", () => {
  it("по умолчанию остаются русскими — офлайн-смок на это опирается", () => {
    expect(describeEmptyStateReason("no-suggestions")).toMatch(/Подсказки/);
    expect(describeGptStage1Status("APPLIED")).toBe("Применён");
  });

  it("при английской локали становятся английскими", () => {
    expect(describeEmptyStateReason("no-suggestions", "en")).toMatch(/suggestions/i);
    expect(describeEmptyStateReason("no-suggestions", "en")).not.toMatch(CYRILLIC);
    expect(describeGptStage1Status("APPLIED", "en")).toBe("Applied");
  });

  it("неизвестный код называет себя, а не выдумывает причину", () => {
    expect(describeEmptyStateReason("mystery-code", "en")).toContain("mystery-code");
    expect(describeEmptyStateReason("mystery-code")).toContain("mystery-code");
  });

  it("префиксные коды разрешаются в ту же причину", () => {
    expect(describeEmptyStateReason("no-images:page-3", "en")).toBe(
      describeEmptyStateReason("no-images", "en")
    );
  });
});

describe("главная кнопка описывает результат, а не внутренности (шаг 11.6)", () => {
  it("не упоминает внутреннее имя контура", () => {
    expect(ru.agents.runUnifiedCollection).not.toMatch(/ORION Golden/i);
    expect(en.agents.runUnifiedCollection).not.toMatch(/ORION Golden/i);
  });
});
