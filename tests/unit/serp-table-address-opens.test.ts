/**
 * Ссылка в таблице выдачи открывается.
 *
 * Колонка «Ссылка» когда-то печатала адрес, обрезанный по ширине колонки (62
 * знака), и такой адрес не открывается: на эталоне 72 обрезаны 17 адресов из
 * 50, в золотом кейсе — 60 из 60. Адрес уходил из колонки в полосу под своей
 * строкой; теперь он вернулся в колонку — но с шириной, которую померили:
 * 0.34 листа, 328 px полезных, предел 165 знаков.
 *
 * Здесь закрепляется то, что видит клиент: адрес доезжает до пакета целиком,
 * заголовок строки режется видимо (в паке, а не молча в рендерере), а строки
 * листаются по объявленной ёмкости.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_TABLE_HEADERS,
  buildSerpFragment,
  clientLink,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import { withContinuations } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type {
  SlideContentContract,
  SlideBody,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const QUERY = "anders holmström nordkap";

/** Ёмкость листа выдачи объявлена реестром — второго ответа здесь нет. */
const CAP = DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide;

/** Номера колонок — из заголовков построителя, а не числами здесь. */
const ADDRESS = SERP_TABLE_HEADERS.indexOf("Ссылка");
const TITLE = SERP_TABLE_HEADERS.indexOf("Заголовок");

type Row = { rank: number; title: string; url: string };

function scopedSerp(rows: Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  rows.forEach((r, i) => {
    const ref = `inventory:s${i}`;
    refs.push(ref);
    evidenceIndex[ref] = {
      title: r.title,
      url: r.url,
      domain: new URL(r.url).hostname,
      region: "RU",
      engine: "YANDEX",
      rank: r.rank,
      query: QUERY,
      queryPurpose: "subject_lookup",
      subjectDecision: "SUBJECT_MATCH",
    };
  });
  return {
    findings: [],
    surfaceUnits: [
      {
        surface: "organic",
        region: "RU",
        engine: "YANDEX",
        claims: [],
        metrics: [],
        evidenceRefs: refs,
      },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: { perRegionCounts: { RU: refs.length } },
  } as unknown as ScopedFragmentInput;
}

type SerpTable = { headers: string[]; rows: string[][]; rowAddresses?: string[] };

function pages(rows: Row[]): SlideContentContract[] {
  return buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scopedSerp(rows)).slides.filter(
    (s) => (s.content.table?.headers ?? [])[0] === "№"
  );
}

function tableOf(slide: SlideContentContract): SerpTable {
  return slide.content.table as unknown as SerpTable;
}

/** Двадцать материалов подряд: ровно то, что обещает заголовок «ТОП-20». */
function twenty(): Row[] {
  return Array.from({ length: 20 }, (_, i) => ({
    rank: i + 1,
    title: `Материал номер ${i + 1} о предпринимателе`,
    url: `https://site${i + 1}.example.org/materials/${i + 1}`,
  }));
}

describe("адрес доезжает до пакета целиком", () => {
  /*
   * 163 знака — самый длинный полный адрес среди напечатанных строк эталона 72
   * (kompromat1.online). При пределе колонки в 62 знака он печатался обрезком.
   */
  const LONG_URL =
    "https://kompromat1.online/articles/364300-byvshij_partner_oligarhov_usmanova_i_ananeva_stal_figurantom_dela_o_moshennichestve_v_osobo_krupnom_razmere_podrobnosti";

  it("длинный адрес печатается без многоточия", () => {
    const table = tableOf(
      pages([{ rank: 1, title: "Материал о деле", url: LONG_URL }])[0]!
    );
    expect(table.rows.map((r) => r[ADDRESS])).toEqual([
      "kompromat1.online/articles/364300-byvshij_partner_oligarhov_usmanova_i_ananeva_stal_figurantom_dela_o_moshennichestve_v_osobo_krupnom_razmere_podrobnosti",
    ]);
    expect(table.rows[0]![ADDRESS]).not.toMatch(/…/u);
  });

  it("адрес без пути — это домен, а не пустая полоса", () => {
    expect(clientLink("https://forbes.ru", "forbes.ru")).toBe("forbes.ru");
  });

  it("строка параметров остаётся там, где без неё нет страницы", () => {
    expect(clientLink("https://youtube.com/watch?v=dQw4w9WgXcQ", "youtube.com")).toBe(
      "youtube.com/watch?v=dQw4w9WgXcQ"
    );
  });

  it("адрес не по схеме http(s) — печатается домен; нечего назвать — прочерк", () => {
    expect(clientLink("arsenkin://suggestion/17", "vk.com")).toBe("vk.com");
    expect(clientLink("", undefined)).toBe("—");
  });

  /*
   * Процентная последовательность в строке параметров раскодируется так же,
   * как в пути.
   *
   * Третья строка стр. 22 прогона 91 напечатана как
   * `yandex.ru/images/search?text=%D0%9A%D1%80%D0%B5%D0%BC%D0%BB%D0%B5%D0%B2+…`
   * — 154 знака и шесть нарисованных строк, самая высокая строка листа. Тот же
   * адрес кириллицей — около полусотни знаков и одна строка. Адрес при этом
   * остаётся тем же: раскодирование ничего не удлиняет, поэтому предел колонки
   * от него не страдает.
   */
  it("процентная последовательность в параметрах печатается буквами", () => {
    const url =
      "https://yandex.ru/images/search?text=%D0%9A%D1%80%D0%B5%D0%BC%D0%BB%D0%B5%D0%B2+%D0%A3%D0%BC%D0%B0%D1%80";
    expect(clientLink(url, "yandex.ru")).toBe("yandex.ru/images/search?text=Кремлев+Умар");
    expect(clientLink(url, "yandex.ru").length).toBeLessThanOrEqual(165);
  });

  it("битая последовательность в параметрах печатается как есть и ничего не роняет", () => {
    expect(clientLink("https://example.ru/a?q=%E0%A4%A", "example.ru")).toBe(
      "example.ru/a?q=%E0%A4%A"
    );
  });
});

describe("адрес режется по своей границе, а не по ширине колонки", () => {
  /*
   * Предел колонки — 165 знаков: столько любым письмом ложится в семь
   * нарисованных строк узкой из двух колонок адреса, и из этой же семёрки
   * выведена ёмкость листа. На органике корпуса прогона 72 (28 уникальных
   * печатных адресов) режущей ветки не касается ни один: самый длинный — 163
   * знака.
   */
  it("адрес в 300 знаков режется по 165 и говорит об этом многоточием", () => {
    const text = clientLink(`https://example.org/${"a".repeat(300)}`, "example.org");
    expect(text.length).toBe(165);
    expect(text.endsWith("…")).toBe(true);
  });

  it("адрес ровно в 165 знаков печатается целиком", () => {
    const path = "b".repeat(165 - "example.org/".length);
    const text = clientLink(`https://example.org/${path}`, "example.org");
    expect(text).toBe(`example.org/${path}`);
    expect(text.length).toBe(165);
  });

  it("163 знака — самый длинный печатаемый адрес корпуса — режущей ветки не касаются", () => {
    const url = `https://kompromat1.online/${"c".repeat(145)}`;
    expect(clientLink(url, "kompromat1.online")).toHaveLength(163);
    expect(clientLink(url, "kompromat1.online")).not.toMatch(/…$/u);
  });
});

describe("заголовок строки режется видимо, по границе слова", () => {
  const LONG_TITLE =
    "Расследование о деловых связях предпринимателя и его партнёров в европейских " +
    "юрисдикциях, опубликованное изданием в августе";

  it("заголовок длиннее 95 знаков подрезан в паке, а не молча в рендерере", () => {
    const title = tableOf(
      pages([{ rank: 1, title: LONG_TITLE, url: "https://a.example.org/1" }])[0]!
    ).rows[0]![TITLE]!;
    expect(LONG_TITLE.length).toBeGreaterThan(95);
    expect(title.length).toBeLessThanOrEqual(95);
    expect(title.endsWith("…")).toBe(true);
    // Рез по границе слова: оставленное — начало оригинала, и следующий знак
    // оригинала не буква, то есть слово не разрублено пополам.
    const kept = title.replace(/…$/u, "");
    expect(LONG_TITLE.startsWith(kept)).toBe(true);
    expect(LONG_TITLE.slice(kept.length, kept.length + 1)).not.toMatch(/\p{L}/u);
  });

  it("заголовок в 95 знаков не трогается", () => {
    const exact = `${"Материал о предпринимателе и его деловых связях в открытых источниках"} ${"страны"}`;
    const padded = exact.padEnd(95, "!").slice(0, 95);
    const title = tableOf(
      pages([{ rank: 1, title: padded, url: "https://a.example.org/1" }])[0]!
    ).rows[0]![TITLE]!;
    expect(title).toBe(padded);
  });
});

describe("страницы листаются по объявленной ёмкости", () => {
  it("двадцать строк ложатся на страницы по ёмкости листа", () => {
    expect(CAP).toBeGreaterThan(0);
    expect(CAP).toBeLessThan(20);
    const built = pages(twenty());
    expect(built.length).toBe(Math.ceil(20 / CAP));
    expect(built.map((s) => tableOf(s).rows.length)).toEqual(
      built.map((_s, i) => Math.min(CAP, 20 - i * CAP))
    );
  });

  it("номера строк остаются позициями выдачи, а не счётчиком страницы", () => {
    const built = pages(twenty());
    expect(tableOf(built[1]!).rows[0]![0]).toBe(String(CAP + 1));
    expect(built.flatMap((s) => tableOf(s).rows.map((r) => r[0]))).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i + 1))
    );
  });

  it("подписи страниц нумеруются 1/N…N/N", () => {
    const built = pages(twenty());
    const total = built.length;
    built.forEach((s, i) => {
      expect(s.title.endsWith(`(${i + 1}/${total})`)).toBe(true);
    });
  });

  it("адрес стоит в своей колонке у каждой строки, а полосы у слайда нет", () => {
    for (const slide of pages(twenty())) {
      const table = tableOf(slide);
      expect(table.rows.map((r) => r[ADDRESS])).toEqual(
        table.rows.map((r) => `site${r[0]}.example.org/materials/${r[0]}`)
      );
      expect(JSON.stringify(slide)).not.toContain("rowAddresses");
    }
  });

  it("доказательства и счётчики страницы собраны из её собственных строк", () => {
    const built = pages(twenty());
    built.forEach((slide, i) => {
      const table = tableOf(slide);
      expect(slide.evidenceRefs).toEqual(
        table.rows.map((r) => `inventory:s${Number(r[0]) - 1}`)
      );
      expect(slide.metrics.displayedCount).toBe(table.rows.length);
      expect(slide.metrics.pageIndex).toBe(i + 1);
      expect(slide.metrics.pageCount).toBe(built.length);
    });
  });

  it("колонок пять, и адрес среди них", () => {
    expect(SERP_TABLE_HEADERS).toEqual(["№", "Ссылка", "Заголовок", "Тип источника", "Оценка"]);
    for (const slide of pages(twenty())) {
      expect(tableOf(slide).headers).toEqual(SERP_TABLE_HEADERS);
      for (const row of tableOf(slide).rows) expect(row).toHaveLength(5);
    }
  });
});

describe("общая разбивка на продолжения режет адреса в такт строкам", () => {
  /*
   * Матрица рисков объявляет ёмкость 3 — на ней и проверяется, что общий
   * пагинатор не оставляет адреса на первой странице, когда строки переехали.
   */
  const MATRIX_CAP = DECK_TEMPLATE_REGISTRY["risk-matrix"].maxTableRowsPerSlide;

  function base(rowCount: number): SlideContentContract {
    const rows = Array.from({ length: rowCount }, (_, i) => [`Тема ${i + 1}`, "Высокий", "1"]);
    const content = {
      table: {
        headers: ["Тема", "Уровень", "Приоритет"],
        rows,
        rowAddresses: rows.map((_r, i) => `site${i + 1}.example.org/theme/${i + 1}`),
      },
    } as unknown as SlideBody;
    return {
      schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
      slideId: "p04_risk_dashboard",
      baseSlotId: "p04_risk_dashboard",
      sectionId: "EXECUTIVE_SUMMARY",
      isContinuation: false,
      continuationOf: null,
      continuationIndex: null,
      templateId: "risk-matrix",
      title: "Матрица комплаенс-рисков",
      content,
      evidenceRefs: [],
      findingIds: [],
      metrics: {},
      visualAssetRefs: [],
    };
  }

  it("семь строк при ёмкости 3 дают 3/3/1, и адреса едут вместе со строками", () => {
    expect(MATRIX_CAP).toBe(3);
    const out = withContinuations(base(7), "risk-matrix");
    expect(out.map((s) => (s.content.table?.rows ?? []).length)).toEqual([3, 3, 1]);
    const addresses = out.flatMap((s) => (s.content.table as unknown as SerpTable).rowAddresses ?? []);
    expect(addresses).toEqual(
      Array.from({ length: 7 }, (_, i) => `site${i + 1}.example.org/theme/${i + 1}`)
    );
    for (const slide of out) {
      const table = slide.content.table as unknown as SerpTable;
      expect(table.rowAddresses).toHaveLength(table.rows.length);
    }
  });

  it("таблица без адресов их и не заводит", () => {
    const withoutAddresses = base(4);
    delete (withoutAddresses.content.table as unknown as SerpTable).rowAddresses;
    for (const slide of withContinuations(withoutAddresses, "risk-matrix")) {
      expect((slide.content.table as unknown as SerpTable).rowAddresses).toBeUndefined();
    }
  });
});
