/**
 * «Найдено по дополнительным запросам» — вторая таблица выдачи.
 *
 * Владелец разделил таблицу выдачи на две, потому что она отвечала на два
 * разных вопроса сразу. Первая говорит «что видно по имени и на каком месте»,
 * вторая — «что вообще есть про человека, чего по имени не видно». Смешивать
 * их запрещено и владельцем, и смыслом: у объединённой таблицы номер строки не
 * значит ничего, и именно так его однажды и прочитали.
 *
 * Поэтому **колонки позиции у второй таблицы нет вовсе** — ни настоящей, ни
 * порядковой, которую примут за настоящую. Вместо неё колонка «Найдено по
 * запросу»: она отвечает на единственный вопрос, ради которого строка там стоит.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_EXTRA_TABLE_HEADERS,
  SERP_FOUND_BY_MAX_CHARS,
  SERP_TABLE_TOP_N,
  buildSerpFragment,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  DECK_TEMPLATE_REGISTRY,
  SERP_EXTRA_TABLE_WORST_ROW_EMU,
  SERP_TABLE_ROW_BUDGET_EMU,
  UNVERIFIED_LABEL,
} from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import { isDataRowTemplate } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

const MAIN = "Глинка Сергей Михайлович";
const EXTRA = "глинка сергей михайлович трансмашхолдинг";
const EXTRA_2 = "сергей глинка бизнес";

/**
 * Честная оговорка движка, у которого по основному запросу раздела нет ни одной
 * строки. Литерал повторён здесь потому, что это клиентский текст: сверять его
 * с самой функцией значило бы сверять код с собой.
 */
const NOT_REGION_MAIN =
  `Основной запрос этого раздела — «${MAIN}»; у этого поисковика по нему в наборе ` +
  "нет ни одной строки, поэтому таблица показывает другой запрос.";

type Row = {
  /** Материал: один и тот же адрес у нескольких наблюдений — одна строка. */
  url: string;
  query?: string;
  engine?: string;
  rank?: number;
  marked?: boolean;
  decision?: string;
  analyst?: string;
  read?: "adverse" | "neutral" | "supportive";
  title?: string;
};

function scoped(rows: Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  rows.forEach((row, i) => {
    const ref = `i${i + 1}`;
    evidenceIndex[ref] = {
      // Заголовок привязан к материалу, а не к месту в массиве: иначе
      // перестановка входа меняет данные, и проверка детерминизма сравнивала бы
      // два разных корпуса.
      title: row.title ?? `Материал ${new URL(row.url).hostname}`,
      url: row.url,
      domain: new URL(row.url).hostname,
      region: "RU",
      engine: row.engine ?? "YANDEX",
      ...(row.rank ? { rank: row.rank, rankSource: row.engine === "GOOGLE" ? "serper" : "yandex" } : {}),
      ...(row.query ? { query: row.query, queryPurpose: "subject_lookup" } : {}),
      ...(row.marked ? { subjectNameQuery: true } : {}),
      ...(row.analyst ? { analystDecision: row.analyst } : {}),
      ...(row.read ? { readVerdictTone: row.read } : {}),
      subjectDecision: row.decision ?? "SUBJECT_MATCH",
    };
    refs.push(ref);
  });
  return {
    findings: [],
    surfaceUnits: [{ surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs }],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function slidesOf(rows: Row[]): SlideContentContract[] {
  return buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped(rows)).slides;
}

/** Листы второй таблицы: их называет собственная метрика, а не порядок. */
function extraSlides(rows: Row[]): SlideContentContract[] {
  return slidesOf(rows).filter((s) => s.metrics?.serpExtraQueries === 1);
}

function extraRows(rows: Row[]): string[][] {
  return extraSlides(rows).flatMap((s) => s.content.table?.rows ?? []);
}

/**
 * Номер колонки — из заголовков построителя, и **лениво**: пока набор
 * заголовков не появился, падает каждая проверка со своим сообщением, а не
 * весь файл целиком на разборе.
 */
const col = (name: string): number => SERP_EXTRA_TABLE_HEADERS.indexOf(name);

/** Двадцать строк по основному запросу — полная таблица А. */
function mainTable(): Row[] {
  return Array.from({ length: 20 }, (_, i) => ({
    url: `https://main-${i + 1}.ru/a`,
    query: MAIN,
    rank: i + 1,
    marked: true,
  }));
}

describe("вторая таблица выдачи не имеет колонки позиции", () => {
  const rows = [...mainTable(), { url: "https://extra-1.ru/a", query: EXTRA, rank: 3 }];

  it("колонки те, что заказал владелец, и номера среди них нет", () => {
    expect(SERP_EXTRA_TABLE_HEADERS).toEqual([
      "Ссылка",
      "Заголовок",
      "Найдено по запросу",
      "Тип источника",
      "Оценка",
    ]);
    expect(SERP_EXTRA_TABLE_HEADERS).not.toContain("№");
    const [slide] = extraSlides(rows);
    expect(slide?.content.table?.headers).toEqual([...SERP_EXTRA_TABLE_HEADERS]);
  });

  it("ни одна ячейка строки не является порядковым номером", () => {
    for (const row of extraRows(rows)) {
      expect(row).toHaveLength(5);
      // Голое число прочитали бы как место в выдаче — ровно та ошибка, из-за
      // которой таблицу и разделили.
      for (const cell of row) expect(cell).not.toMatch(/^\s*\d+\s*$/u);
    }
  });

  it("страница второй таблицы классифицирована как страница данных", () => {
    /*
     * Строки второй таблицы — данные провайдера, и повторы в них законны: у
     * одиннадцати материалов подряд «Найдено по запросу» называет одну и ту же
     * формулировку.
     *
     * Проверка закрепляет **классификацию**, а не действующую защиту: все трое
     * читателей перечня смотрят буллеты и прозу, которых у этой страницы нет,
     * поэтому сегодня запись ничего не меняет. Понадобится она в тот день,
     * когда у страницы появится список.
     */
    expect(isDataRowTemplate("serp-extra-queries")).toBe(true);
    expect(isDataRowTemplate("serp-table")).toBe(true);
  });

  it("staticBlocks реестра перечисляют те же пять колонок", () => {
    expect(DECK_TEMPLATE_REGISTRY["serp-extra-queries"].staticBlocks).toEqual([
      "Найдено по дополнительным запросам",
      ...SERP_EXTRA_TABLE_HEADERS,
    ]);
  });
});

describe("вторая таблица показывает только то, чего нет в первой", () => {
  it("материал из первой таблицы во вторую не попадает", () => {
    const rows: Row[] = [
      ...mainTable(),
      // Тот же материал, что и первая строка А, найден ещё и дополнительным
      // запросом: он уже показан, и повторять его нечем.
      { url: "https://main-1.ru/a", query: EXTRA, rank: 2 },
    ];
    expect(extraRows(rows)).toHaveLength(0);
  });

  it("материал, найденный только дополнительным запросом, присутствует", () => {
    const rows: Row[] = [...mainTable(), { url: "https://extra-1.ru/a", query: EXTRA, rank: 4 }];
    const printed = extraRows(rows);
    expect(printed).toHaveLength(1);
    expect(printed[0]![col("Ссылка")]).toBe("extra-1.ru/a");
    expect(printed[0]![col("Найдено по запросу")]).toBe(EXTRA);
  });

  it("А региона — объединение движков: материал из таблицы Google во вторую не идёт", () => {
    const rows: Row[] = [
      // Основная двадцатка Google.
      ...Array.from({ length: 5 }, (_, i) => ({
        url: `https://g-${i + 1}.ru/a`,
        query: MAIN,
        rank: i + 1,
        engine: "GOOGLE",
        marked: true,
      })),
      // Основная двадцатка Яндекса — другие материалы.
      ...Array.from({ length: 5 }, (_, i) => ({
        url: `https://y-${i + 1}.ru/a`,
        query: MAIN,
        rank: i + 1,
        engine: "YANDEX",
        marked: true,
      })),
      // Тот же материал, что стоит в таблице Google, найден Яндексом по
      // дополнительному запросу. В А региона он есть, значит в Б его нет.
      { url: "https://g-1.ru/a", query: EXTRA, rank: 7, engine: "YANDEX" },
    ];
    expect(extraRows(rows).map((r) => r[col("Ссылка")])).not.toContain("g-1.ru/a");
  });

  it("таблица одна на регион, а не на движок", () => {
    const rows: Row[] = [
      ...mainTable(),
      // У Google своя двадцатка по основному запросу — иначе его таблица
      // построилась бы на дополнительном, и тот стал бы основным для региона.
      ...Array.from({ length: 3 }, (_, i) => ({
        url: `https://g-main-${i + 1}.ru/a`,
        query: MAIN,
        rank: i + 1,
        engine: "GOOGLE",
        marked: true,
      })),
      { url: "https://extra-y.ru/a", query: EXTRA, rank: 3, engine: "YANDEX" },
      { url: "https://extra-g.ru/a", query: EXTRA, rank: 4, engine: "GOOGLE" },
    ];
    // Обе строки — в одной таблице, и заголовок у неё один на регион.
    const slides = extraSlides(rows);
    expect(slides).toHaveLength(1);
    expect(slides[0]!.title).toBe("Россия — найдено по дополнительным запросам");
    expect(extraRows(rows).map((r) => r[col("Ссылка")]).sort()).toEqual([
      "extra-g.ru/a",
      "extra-y.ru/a",
    ]);
  });
});

describe("«Найдено по запросу» называет запрос и делает это одинаково дважды", () => {
  const rows: Row[] = [
    ...mainTable(),
    // Один материал найден двумя дополнительными запросами: выше он стоял по
    // второму.
    { url: "https://both.ru/a", query: EXTRA, rank: 9 },
    { url: "https://both.ru/a", query: EXTRA_2, rank: 2 },
  ];

  it("при нескольких кандидатах называется тот, по которому материал стоял выше", () => {
    const printed = extraRows(rows);
    expect(printed).toHaveLength(1);
    expect(printed[0]![col("Найдено по запросу")]).toBe(EXTRA_2);
  });

  it("выбор не зависит от порядка входа", () => {
    const reversed = [...rows].reverse();
    expect(extraRows(reversed)).toEqual(extraRows(rows));
  });
});

describe("пустое множество даёт честные слова, а не пустую таблицу", () => {
  it("когда дополнительных запросов в прогоне не было", () => {
    const [slide] = extraSlides(mainTable());
    expect(slide).toBeDefined();
    expect(slide!.content.table).toBeUndefined();
    expect(String(slide!.content.narrative ?? "")).toContain(
      "дополнительных запросов в этом контуре не было"
    );
  });

  it("а при отсутствии запросов в данных вторая таблица не появляется вовсе", () => {
    // Сравнивать не с чем: первая таблица в таком наборе непозиционная.
    const rows: Row[] = Array.from({ length: 4 }, (_, i) => ({ url: `https://n-${i}.ru/a` }));
    expect(extraSlides(rows)).toHaveLength(0);
  });
});

describe("потолок второй таблицы — по риску, а не по числу", () => {
  /** N материалов одного рода, найденных дополнительным запросом. */
  function filler(count: number, kind: "adverse" | "likely" | "neutral" | "unread" | "other"): Row[] {
    return Array.from({ length: count }, (_, i) => ({
      url: `https://${kind}-${i + 1}.ru/a`,
      query: EXTRA,
      rank: i + 1,
      ...(kind === "adverse" ? { analyst: "ADVERSE" } : {}),
      ...(kind === "likely" ? { decision: "LIKELY_SUBJECT" } : {}),
      ...(kind === "neutral" ? { read: "neutral" as const } : {}),
      ...(kind === "other" ? { decision: "OTHER_SUBJECT" } : {}),
    }));
  }

  it("«Нежелательный» и «Вероятно» печатаются всегда, даже когда их больше предела", () => {
    const rows = [...mainTable(), ...filler(SERP_TABLE_TOP_N + 5, "adverse"), ...filler(4, "likely")];
    const printed = extraRows(rows);
    expect(printed.filter((r) => r[col("Оценка")] === "Нежелательный")).toHaveLength(SERP_TABLE_TOP_N + 5);
    expect(printed.filter((r) => r[col("Оценка")] === "Вероятно")).toHaveLength(4);
  });

  it("остальные три значения шкалы срезаются по пределу — и все три участвуют", () => {
    for (const kind of ["neutral", "unread", "other"] as const) {
      const rows = [...mainTable(), ...filler(SERP_TABLE_TOP_N + 6, kind)];
      const printed = extraRows(rows);
      expect(printed, kind).toHaveLength(SERP_TABLE_TOP_N);
    }
  });

  it("предел читается из глубины таблицы А, а не записан своим числом", () => {
    const rows = [...mainTable(), ...filler(SERP_TABLE_TOP_N + 6, "unread")];
    expect(extraRows(rows).filter((r) => r[col("Оценка")] === UNVERIFIED_LABEL)).toHaveLength(
      SERP_TABLE_TOP_N
    );
  });

  it("страница называет остаток словами и его род", () => {
    const rows = [...mainTable(), ...filler(SERP_TABLE_TOP_N + 6, "unread")];
    const text = extraSlides(rows)
      .map((s) => String(s.content.narrative ?? ""))
      .join(" ");
    expect(text).toContain("Ещё 6 материалов осталось за пределом таблицы");
    expect(text).toContain("нежелательные и вероятные показаны все");
  });

  it("молчаливого усечения нет: без остатка фразы про остаток тоже нет", () => {
    const rows = [...mainTable(), ...filler(3, "unread")];
    const text = extraSlides(rows)
      .map((s) => String(s.content.narrative ?? ""))
      .join(" ");
    expect(text).not.toContain("за пределом таблицы");
  });

  it("порядок внутри срезаемой части детерминирован", () => {
    const rows = [...mainTable(), ...filler(SERP_TABLE_TOP_N + 6, "unread")];
    expect(extraRows(rows)).toEqual(extraRows([...rows]));
    expect(extraRows([...rows].reverse())).toEqual(extraRows(rows));
  });
});

describe("страницы не печатают утверждений, которые опровергает соседний лист", () => {
  /**
   * Регион, где по основному написанию собрал только один движок.
   *
   * Живой исход: второй поисковик не вернул ничего по имени (пустая выдача,
   * отказ провайдера, квота). Его таблица А строится на дополнительном
   * запросе — и обе страницы разворота начинают врать: первая говорит, что в
   * данных не отмечено, какой запрос основной (отмечено, просто не у её
   * строк), вторая — что дополнительных запросов не было (есть, на одном из
   * них построена соседняя таблица).
   */
  function oneEngineMissedMain(): Row[] {
    return [
      ...[1, 2, 3].map((rank) => ({
        url: `https://y-${rank}.ru/a`,
        query: MAIN,
        rank,
        marked: true,
        engine: "YANDEX",
      })),
      ...[1, 2, 3].map((rank) => ({
        url: `https://g-${rank}.ru/a`,
        query: EXTRA,
        rank,
        engine: "GOOGLE",
      })),
    ];
  }

  it("движок без основного запроса не выдаёт наш выбор за отсутствие пометки", () => {
    const pages = slidesOf(oneEngineMissedMain()).filter(
      (s) => s.metrics?.serpExtraQueries !== 1 && s.metrics?.serpEngine === "GOOGLE"
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const text = String(page.content.narrative ?? "");
      expect(text).not.toContain("в собранных данных не отмечено");
      /*
       * Утверждение положительное, а не только отрицательное. Пока проверялось
       * одно отсутствие ложной оговорки, «ленивая починка» — не печатать
       * оговорку никогда — проходила проверку насквозь. Имя запроса в абзаце
       * доказательством тоже не служит: оно стоит в справке о наборе запросов.
       */
      expect(text).toContain(NOT_REGION_MAIN);
    }
  });

  it("движок с теми же строками, но без пометки, оговорки не печатает", () => {
    /*
     * Пометка сводится по ИЛИ на уровне материала, а не запроса: набор, где
     * часть строк собрана до её появления, легко даёт движок с **тем же**
     * основным запросом и без пометки. Печатать там «у этого поисковика по
     * основному запросу в наборе нет ни одной строки» — ложь, которую
     * опровергает предыдущее предложение того же абзаца: строки есть, они
     * напечатаны ниже, и никакого «другого запроса» таблица не показывает.
     */
    const rows: Row[] = [
      ...[1, 2, 3].map((rank) => ({
        url: `https://y-${rank}.ru/a`,
        query: MAIN,
        rank,
        marked: true,
        engine: "YANDEX",
      })),
      ...[1, 2].map((rank) => ({
        url: `https://g-${rank}.ru/a`,
        query: MAIN,
        rank,
        engine: "GOOGLE",
      })),
    ];
    const google = slidesOf(rows).filter(
      (s) => s.metrics?.serpExtraQueries !== 1 && s.metrics?.serpEngine === "GOOGLE"
    );
    expect(google.length).toBeGreaterThan(0);
    for (const page of google) {
      const text = String(page.content.narrative ?? "");
      expect(text).not.toContain("нет ни одной строки");
      expect(text).not.toContain("в собранных данных не отмечено");
    }
  });

  it("вторая таблица не отрицает запросы, на которых построена соседняя", () => {
    const text = extraSlides(oneEngineMissedMain())
      .map((s) => String(s.content.narrative ?? ""))
      .join(" ");
    expect(text).not.toContain("Дополнительных запросов");
  });
});

describe("честное пустое состояние называет свой регион", () => {
  function emptyStateOf(key: "RU_SERP" | "UAE_SERP", region: string): SlideContentContract {
    const rows = mainTable();
    const built = buildSerpFragment(
      key,
      key === "RU_SERP" ? "RU_PROFILE" : "UAE_PROFILE",
      region,
      scoped(rows)
    ).slides.filter((s) => s.metrics?.serpExtraQueries === 1);
    return built[0]!;
  }

  it("не говорит «в этом прогоне» о том, что верно только для региона", () => {
    const ru = emptyStateOf("RU_SERP", "Россия");
    expect(String(ru.content.narrative ?? "")).not.toContain("в этом прогоне");
  });

  it("тела двух регионов различаются, а не совпадают дословно", () => {
    const ru = String(emptyStateOf("RU_SERP", "Россия").content.narrative ?? "");
    const uae = String(emptyStateOf("UAE_SERP", "ОАЭ / международный").content.narrative ?? "");
    expect(ru).not.toBe(uae);
    // Метка контура печатается как есть: склонять произвольную метку нечем.
    expect(ru).toContain("Россия");
    expect(uae).toContain("ОАЭ");
  });

  it("ветка «нашли, но нового нет» печатается своими словами", () => {
    // Дополнительный запрос есть, но весь его материал уже стоит в таблице А.
    const rows: Row[] = [
      ...mainTable(),
      { url: "https://main-1.ru/a", query: EXTRA, rank: 2 },
    ];
    const text = extraSlides(rows)
      .map((s) => String(s.content.narrative ?? ""))
      .join(" ");
    expect(text).toContain("не нашли ничего");
    expect(text).not.toContain("не было");
  });
});

describe("листы второй таблицы не повторяют друг друга дословно", () => {
  const many = [
    ...mainTable(),
    ...Array.from({ length: 24 }, (_, i) => ({
      url: `https://many-${i + 1}.ru/a`,
      query: EXTRA,
      rank: i + 1,
    })),
  ];

  it("фраза остатка печатается один раз, на последнем листе", () => {
    const pages = extraSlides(many);
    expect(pages.length).toBeGreaterThan(1);
    const withRemainder = pages.filter((s) =>
      String(s.content.narrative ?? "").includes("за пределом таблицы")
    );
    expect(withRemainder).toHaveLength(1);
    expect(withRemainder[0]).toBe(pages[pages.length - 1]);
  });

  it("абзацы листов различаются между собой", () => {
    const texts = extraSlides(many).map((s) => String(s.content.narrative ?? ""));
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("остаток согласован по-русски при любом числе", () => {
    const line = extraSlides(many)
      .map((s) => String(s.content.narrative ?? ""))
      .find((t) => t.includes("за пределом таблицы"))!;
    expect(line).toMatch(/Ещё \d+ материал(|а|ов) осталось за пределом таблицы/u);
  });
});

describe("длина запроса в колонке ограничена печатью, а не надеждой", () => {
  it("запрос длиннее предела режется видимо, а не растягивает лист", () => {
    const long = `${"Ю".repeat(120)}`;
    const rows: Row[] = [...mainTable(), { url: "https://long-q.ru/a", query: long, rank: 1 }];
    const cell = extraRows(rows)[0]![col("Найдено по запросу")]!;
    expect(cell.length).toBeLessThanOrEqual(SERP_FOUND_BY_MAX_CHARS);
    expect(cell.endsWith("…")).toBe(true);
  });

  it("запрос на самом пределе не трогается", () => {
    const exact = "Ю".repeat(SERP_FOUND_BY_MAX_CHARS);
    const rows: Row[] = [...mainTable(), { url: "https://exact-q.ru/a", query: exact, rank: 1 }];
    expect(extraRows(rows)[0]![col("Найдено по запросу")]).toBe(exact);
  });
});

describe("ёмкость второй таблицы выведена делением, как и первой", () => {
  it("равна частному своего бюджета и своей худшей строки", () => {
    expect(DECK_TEMPLATE_REGISTRY["serp-extra-queries"].maxTableRowsPerSlide).toBe(
      Math.floor(SERP_TABLE_ROW_BUDGET_EMU / SERP_EXTRA_TABLE_WORST_ROW_EMU)
    );
    expect(DECK_TEMPLATE_REGISTRY["serp-extra-queries"].maxTableRowsPerSlide).toBe(3);
  });

  it("листает строки по этому числу, а не по числу первой таблицы", () => {
    const cap = DECK_TEMPLATE_REGISTRY["serp-extra-queries"].maxTableRowsPerSlide;
    const rows: Row[] = [
      ...mainTable(),
      ...Array.from({ length: 7 }, (_, i) => ({
        url: `https://cap-${i + 1}.ru/a`,
        query: EXTRA,
        rank: i + 1,
      })),
    ];
    expect(extraSlides(rows).map((s) => s.content.table?.rows.length)).toEqual([cap, cap, 1]);
  });
});
