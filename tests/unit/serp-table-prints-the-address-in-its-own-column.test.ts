/**
 * Ссылка в таблице выдачи стоит своей колонкой и печатается целиком.
 *
 * Владелец потребовал вернуть структуру старой вёрстки: пять колонок, ссылка
 * отдельной колонкой и без обрезаний. Прежние пять колонок держались на
 * обрубленной по 62 знакам ссылке — 17 строк из 50 на эталоне-72 и 60 из 60 в
 * золотом кейсе не открывались, — поэтому адрес и уехал в полосу под строкой.
 * Полоса печатала тот же факт вторым способом, и вместе с колонкой это был бы
 * адрес дважды на одном листе.
 *
 * Числа здесь не назначены, а померены мерами самого рендерера
 * (`_wrapped_line_count`): полезная ширина колонки адреса 328 px, предел 165
 * знаков берётся от **узкой** из двух колонок адреса, а самый длинный адрес
 * корпуса — 163 знака, то есть не режется ни один.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_TABLE_HEADERS,
  buildSerpFragment,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  DECK_TEMPLATE_REGISTRY,
  SERP_TABLE_ROW_BUDGET_EMU,
  SERP_TABLE_WORST_ROW_EMU,
} from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

/**
 * Самый длинный адрес корпуса эталона-72: 125 знаков после разбора.
 *
 * Прежде им был адрес картинок Яндекса с процентной последовательностью в
 * параметрах (163 знака); печать стала её раскодировать, и тот же адрес занял
 * 53 знака. Максимум органики корпуса пересчитан печатной формой заново.
 */
const LONGEST_CORPUS_URL =
  "https://runews24.ru/interview/01/08/2025/intervyu-s-biznesmenom-sergeem-glinkoj-biografiya-foto-lichnaya-zhizn-i-budushhee-transporta";
const LONGEST_CORPUS_ADDRESS =
  "runews24.ru/interview/01/08/2025/intervyu-s-biznesmenom-sergeem-glinkoj-biografiya-foto-lichnaya-zhizn-i-budushhee-transporta";

/** Адрес, который в предел не влезает: 150 знаков пути плюс строка параметров. */
const OVERLONG_PATH = `example.ru/${"a".repeat(139)}`;
const OVERLONG_URL = `https://${OVERLONG_PATH}?utm_source=${"b".repeat(60)}`;

const QUERY = "Глинка Сергей Михайлович";

function scopedWithRows(rows: Array<{ rank: number; url: string; title: string }>): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  for (const row of rows) {
    evidenceIndex[`i${row.rank}`] = {
      title: row.title,
      url: row.url,
      domain: new URL(row.url).hostname,
      region: "RU",
      engine: "YANDEX",
      rank: row.rank,
      rankSource: "yandex",
      query: QUERY,
      queryPurpose: "subject_lookup",
      subjectNameQuery: true,
      subjectDecision: "SUBJECT_MATCH",
    };
  }
  return {
    findings: [],
    surfaceUnits: [
      {
        surface: "organic",
        region: "RU",
        claims: [],
        metrics: [],
        evidenceRefs: rows.map((r) => `i${r.rank}`),
      },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function firstTable(rows: Array<{ rank: number; url: string; title: string }>) {
  const slide = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scopedWithRows(rows)).slides[0]!;
  return { slide, table: slide.content.table! };
}

describe("таблица выдачи: пять колонок, адрес — ячейка", () => {
  it("колонки идут в заказанном владельцем порядке", () => {
    expect(SERP_TABLE_HEADERS).toEqual(["№", "Ссылка", "Заголовок", "Тип источника", "Оценка"]);
  });

  it("staticBlocks реестра перечисляют те же пять колонок", () => {
    // Реестр против построителя: рендерер режет по `headers[:5]` и о
    // расхождении промолчит.
    expect(DECK_TEMPLATE_REGISTRY["serp-table"].staticBlocks).toEqual([
      "Результаты поиска",
      ...SERP_TABLE_HEADERS,
    ]);
  });

  it("методическая сноска больше не обещает адрес под строкой", () => {
    const note = DECK_TEMPLATE_REGISTRY["serp-table"].methodologyNote ?? "";
    expect(note).not.toMatch(/под свое[йи] строк/iu);
    expect(note).toMatch(/адрес/iu);
  });

  it("адрес стоит ячейкой второй колонки, а полосы у слайда нет", () => {
    const { slide, table } = firstTable([
      { rank: 1, url: "https://example.ru/one", title: "Первый материал" },
    ]);
    expect(table.headers).toEqual([...SERP_TABLE_HEADERS]);
    expect(table.rows[0]![1]).toBe("example.ru/one");
    expect(table.rows[0]).toHaveLength(5);
    // Отсутствие поля проверяется через JSON: литерал построителя держит ключ
    // и со значением `undefined`, а до рендерера доезжает сериализованный вид.
    expect(JSON.parse(JSON.stringify(table))).not.toHaveProperty("rowAddresses");
    expect(JSON.stringify(slide)).not.toContain("rowAddresses");
  });

  it("самый длинный адрес корпуса печатается целиком", () => {
    const { table } = firstTable([
      { rank: 1, url: LONGEST_CORPUS_URL, title: "Картинки Яндекса" },
    ]);
    expect(LONGEST_CORPUS_ADDRESS).toHaveLength(125);
    expect(table.rows[0]![1]).toBe(LONGEST_CORPUS_ADDRESS);
    expect(table.rows[0]![1]).not.toMatch(/…/u);
  });

  it("адрес длиннее предела теряет строку параметров, а не хвост пути", () => {
    const { table } = firstTable([{ rank: 1, url: OVERLONG_URL, title: "Длинный" }]);
    expect(table.rows[0]![1]).toBe(OVERLONG_PATH);
  });
});

describe("ёмкость листа выведена делением, а не назначена", () => {
  it("равна частному бюджета строк и худшей законной строки", () => {
    expect(DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide).toBe(
      Math.floor(SERP_TABLE_ROW_BUDGET_EMU / SERP_TABLE_WORST_ROW_EMU)
    );
  });

  it("три строки на лист — столько влезает при худшем законном письме", () => {
    expect(DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide).toBe(3);
    const rows = [1, 2, 3, 4].map((rank) => ({
      rank,
      url: `https://example.ru/${rank}`,
      title: `Материал ${rank}`,
    }));
    const slides = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scopedWithRows(rows))
      .slides
      // Только листы первой таблицы: вторая живёт на тех же продолжениях.
      .filter((s) => s.metrics?.serpExtraQueries !== 1);
    expect(slides.map((s) => s.content.table?.rows.length)).toEqual([3, 1]);
  });
});
