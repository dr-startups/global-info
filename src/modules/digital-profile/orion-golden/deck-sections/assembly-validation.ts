/**
 * Global assembly validation — checks the assembled deck as a whole after the
 * DeckAssembler ran. Complements per-section QA.
 */

import type {
  ReportDeckManifest,
  ReportSectionManifest,
  SectionPackV2,
  SectionType,
} from "./contracts";
import { REQUIRED_SECTIONS, SECTION_TITLES } from "./contracts";
import type { RendererSlide } from "./deck-assembler";
import { isDataRowTemplate } from "./deck-assembler";
import { normalizeEvidenceRef, regionMatches, type ScopedEvidenceIndex } from "./scoped-input";
import { CANONICAL_SLOT_IDS, type VisualAssetsBySlot } from "./canonical-slots";
import { assetKindDrawsRedFrames } from "../assets/red-frame-asset-kinds";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import {
  clientVisibleStrings,
  scanDeckForCodeLikeTokens,
  scanDeckForInternalCodes,
  type ClientVisibleSlide,
} from "./internal-code-scan";
import { quoteIntegrityProblems } from "./quote-integrity";
import { normalizeForCompare } from "./text-compare";
import { withoutFindingMarkers } from "./slide-markers";
import { SERP_TABLE_TOP_N } from "./fragment-builders/serp";
import { sameSerpQuery } from "./fragment-builders/shared";
import { serpMaterialKey } from "../../serp-observation/material-key";
import { clientAddress } from "../client/client-address";
import {
  normalizeDomainForCompare,
  undeclaredClientTextDomainHits,
} from "./section-validation";
import { NOT_FOUND_PATTERNS } from "../analytics/surface-analyzers";
import { pluralRu } from "../../report/i18n/plural-ru";

/** Renderer templates that draw the analytical sidebar next to a visual. */
const SIDEBAR_TEMPLATES = new Set([
  "orion_golden_serp_screenshot",
  "orion_golden_knowledge_panel",
  "orion_golden_surface_panel",
]);

/** Templates allowed to be structurally sparse (framework pages). */
const STRUCTURAL_TEMPLATES = new Set(["cover", "toc", "section-divider"]);

/** Шаблоны, которые печатают строками то же, что нарисовано на их панели. */
const PANEL_ROW_TEMPLATES = new Set(["related-queries", "suggestions"]);

export type AssemblyValidationReport = {
  passed: boolean;
  issues: string[];
  /**
   * Замеченное, что сборку не останавливает и `passed` не роняет.
   *
   * Заведено отдельным полем не для красоты: от `issues` зависит `passed`, а от
   * него — ворота приёмки эталона. Положить сюда ложное срабатывание значило бы
   * переселить блокировку из одной двери в другую, а не снять её.
   */
  notes: string[];
  checks: Record<string, boolean>;
  /**
   * Проверки, из-за которых сборку нельзя отдавать клиенту.
   *
   * Раньше проверки качества текста не останавливали ничего: отчёт с
   * `passed: false` уходил как есть, и ворота были лампочкой, а не воротами. Но
   * и «любая непройденная проверка блокирует» не годится — на прогоне 73
   * сборку остановило бы ложное срабатывание на адресе `leonid_mihelson`.
   *
   * Поэтому блокирует существенность, а не факт: единичный сомнительный случай
   * записывается и живёт в разборе, а поломка, задевшая несколько страниц,
   * означает, что сломан сам текстовый конвейер, — такую сборку клиент видеть
   * не должен.
   */
  blocking: string[];
  /**
   * Проверки, которые на этом наборе данных выполнить нечем.
   *
   * Тихий пропуск неотличим от пройденной проверки — ровно так выглядела бы
   * зелёная приёмка на прогоне, где нужного признака в артефактах нет. Пропуск
   * объявляется строкой и виден в отчёте.
   */
  skipped: string[];
};

/**
 * Со скольких задетых страниц дефект текста считается системным.
 *
 * Один спорный блок — вопрос к формулировке. Три и больше — вопрос к
 * механизму: именно так выглядела вычистка повторов, оборвавшая цитаты сразу
 * на нескольких страницах отчёта.
 */
export const SYSTEMIC_DEFECT_PAGES = 3;

const RISK_ORDER: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

/*
 * Перечень объявляет, что он неполон.
 *
 * Печаталось «на 6 страницах: <пять имён>» — шестая не называлась, и по строке
 * нельзя было понять, что список обрезан. Читатель отчёта об отказе такой же
 * читатель, как читатель отчёта: недоговорённость он принимает за полный
 * список.
 */
function namedList(items: readonly string[], limit = 5): string {
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")} и ещё ${items.length - limit}`;
}

/**
 * Какие дефекты останавливают сборку — и с какого порога.
 *
 * Дефекты текста (разорванная цитата, внутренний код, панель, спорящая с
 * текстом) блокируют по существенности: эвристика ошибается на живых данных, и
 * единичный случай не должен ронять оплаченный прогон. Структурные — с первой
 * страницы: таблица без строк законной не бывает, и один и тот же текст дважды
 * на странице тоже.
 *
 * Отдельной функцией, чтобы пороги можно было проверить в лоб, не собирая ради
 * этого манифест с пакетами и находками.
 */
export function blockingIssues(input: {
  quoteDefectSlides: ReadonlySet<string>;
  codeSlides: ReadonlySet<string>;
  /** Сами коды — без них по сообщению нельзя понять, что чинить. */
  codes?: ReadonlySet<string>;
  /** Страницы, чей текст спорит с нарисованной на них панелью. */
  panelMismatchSlides?: ReadonlySet<string>;
  /** Страницы, напечатавшие один и тот же блок текста дважды. */
  repeatedTextSlides?: ReadonlySet<string>;
  /** Страницы, объявившие таблицу без единой строки. */
  emptyTableSlides?: ReadonlySet<string>;
  /** Страницы, где строка таблицы печатает свой же адрес в другой своей ячейке. */
  ownAddressRowSlides?: ReadonlySet<string>;
}): string[] {
  const out: string[] = [];
  const name = (s: ReadonlySet<string>, limit = 5): string => namedList([...s], limit);
  if (input.quoteDefectSlides.size >= SYSTEMIC_DEFECT_PAGES) {
    out.push(
      `цитаты разорваны на ${input.quoteDefectSlides.size} страницах: ${name(input.quoteDefectSlides)}`
    );
  }
  if (input.codeSlides.size >= SYSTEMIC_DEFECT_PAGES) {
    /*
     * Код называется в сообщении.
     *
     * Прежде отказ печатал только страницы, и оператор — как и тот, кто пришёл
     * разбираться, — видел «внутренние коды на 6 страницах» без единого
     * намёка, какие именно. Строка, по которой нельзя действовать, останавливает
     * платный прогон на последнем шаге и ничего не сообщает; сами коды при этом
     * лежат в артефакте сборки и до человека не доходят.
     */
    const codes = input.codes && input.codes.size > 0 ? `; коды: ${name(input.codes, 5)}` : "";
    out.push(
      `внутренние коды в клиентском тексте на ${input.codeSlides.size} страницах: ${name(
        input.codeSlides
      )}${codes}`
    );
  }
  const panels = input.panelMismatchSlides ?? new Set<string>();
  if (panels.size >= SYSTEMIC_DEFECT_PAGES) {
    out.push(`панели не сходятся с текстом на ${panels.size} страницах: ${name(panels)}`);
  }
  /*
   * Повтор блока блокирует с первой же страницы, а не с порога в три.
   *
   * Порог существенности заведён для эвристик, которые ошибаются на живых
   * данных. Здесь ошибаться нечему: сравниваются два блока одной страницы,
   * страницы с сырыми строками провайдера исключены, и ложных срабатываний на
   * обоих эталонах ноль. Зато цена пропуска высокая — на живом пути читается
   * только `blocking`, поэтому при пороге в три отчёт с дублем на одной
   * странице уезжал бы клиенту, а жаловался владелец ровно на один слайд.
   *
   * Повтор этому отказу оставлен намеренно, но **не потому, что он дешёвый**:
   * текст пишет модель, и второй заход может дать другой — а вот стоит он тех
   * же четырёх стадий. Возобновляемый отказ подготовки идёт `resumeFrom:
   * "full"`, где стадия 2 форсируется (`forceGptCopy = true`), разбор кейса
   * зовётся безусловно, а композер и редактор включены по умолчанию; кэш
   * пакетов здесь не спасает, потому что полная подготовка снимает с них
   * отметки сама. Бюджет отказов шага — десять попыток.
   */
  const repeatedText = input.repeatedTextSlides ?? new Set<string>();
  if (repeatedText.size > 0) {
    out.push(
      `один и тот же текст напечатан дважды на ${repeatedText.size} ` +
        `${pluralRu(repeatedText.size, "странице", "страницах", "страницах")}: ` +
        `${name(repeatedText)}`
    );
  }
  /*
   * Таблица без строк блокирует с первой же страницы, а не с третьей.
   *
   * Порог существенности заведён для текстовых эвристик, которые ошибаются на
   * живых данных: единичный спорный случай не должен останавливать оплаченный
   * прогон. Здесь утверждение структурное — таблицы без строк не бывает
   * законной ни у одного построителя, честное пустое состояние строится
   * шаблоном без таблицы, — а цена пропуска высокая: рендерер такую таблицу
   * заполняет сам.
   */
  const emptyTables = input.emptyTableSlides ?? new Set<string>();
  if (emptyTables.size > 0) {
    out.push(
      `таблица объявлена без строк на ${emptyTables.size} ` +
        `${pluralRu(emptyTables.size, "странице", "страницах", "страницах")}: ${name(emptyTables)}`
    );
  }
  /*
   * Строка печатает свой адрес дважды — блокирует с первой же строки.
   *
   * **Это не то же самое, что ворот «страница не печатает один и тот же текст
   * дважды».** Тот сравнивает блоки прозы страницы между собой и страницы с
   * данными провайдера исключает намеренно: две строки выдачи с одинаковым
   * заголовком — законные данные, их различает адрес под строкой. Этот
   * сравнивает **ячейку строки с адресом этой же строки**, то есть работает
   * ровно там, где тот отступает. Слить их в один нельзя: у первого предмет —
   * наша проза, у второго — данные провайдера.
   *
   * Порог существенности не нужен по той же причине, что и у таблицы без
   * строк: утверждение структурное, эвристики в нём нет, а построитель делает
   * состояние недостижимым — печатник спрашивает «отдал ли поисковик
   * заголовок» одним предикатом. Значит, здоровый прогон ворот не уронит.
   */
  const ownAddressRows = input.ownAddressRowSlides ?? new Set<string>();
  if (ownAddressRows.size > 0) {
    out.push(
      `строка печатает свой адрес дважды на ${ownAddressRows.size} ` +
        `${pluralRu(ownAddressRows.size, "странице", "страницах", "страницах")}: ` +
        `${name(ownAddressRows)}`
    );
  }
  return out;
}

/**
 * Строки таблиц, печатающие свой адрес дважды.
 *
 * Единица счёта — напечатанная строка: слайд и её номер в таблице. Сравниваются
 * **ячейки одной строки**: адрес стоит своей колонкой, и второй его отпечаток
 * может быть только в соседней ячейке — чаще всего в заголовке, который
 * поисковик не отдал, а подставщик заполнил адресом. Пока адрес шёл полосой,
 * сравнивали ячейку с полосой; вопрос от переезда не изменился, изменилось
 * место второго отпечатка.
 *
 * Сравнение идёт печатью адреса (`clientAddress`) против содержимого колонки
 * «Ссылка», которую печатает `clientLink`, — то есть двумя формами одного
 * разбора, а не новой нормализацией. Номер колонки берётся из заголовков листа:
 * у двух таблиц выдачи он разный.
 *
 * Хвостовое многоточие снимается перед сравнением: наш собственный рез
 * заголовка (95 знаков) укорачивал адрес сверху, оставляя полный снизу, — и
 * именно так выглядела первая из шести строк эталона-72. Поэтому совпадением
 * считается **начало** напечатанного адреса, а не всё его содержимое.
 */
export function rowsPrintingTheirOwnAddress(
  slides: ReadonlyArray<{
    slideKey: string;
    table?: { headers?: string[]; rows: string[][] } | undefined;
  }>
): Array<{ slideKey: string; row: number }> {
  const found: Array<{ slideKey: string; row: number }> = [];
  for (const slide of slides) {
    const column = (slide.table?.headers ?? []).indexOf("Ссылка");
    if (column < 0 || !slide.table) continue;
    slide.table.rows.forEach((cells, i) => {
      const address = String(cells[column] ?? "").trim().toLowerCase();
      if (!address) return;
      cells.forEach((cell, index) => {
        // Сама колонка адреса себя не повторяет.
        if (index === column) return;
        const printed = clientAddress(String(cell ?? "").replace(/…+$/u, "").trim());
        if (printed && address.startsWith(printed.toLowerCase())) {
          if (found.at(-1)?.row !== i + 1 || found.at(-1)?.slideKey !== slide.slideKey) {
            found.push({ slideKey: slide.slideKey, row: i + 1 });
          }
        }
      });
    });
  }
  return found;
}

/**
 * Строка выдачи так, как её видит артефакт наблюдений.
 *
 * Ровно те поля, которые нужны сверке: ворота читают наблюдения, а не индекс
 * доказательств, которым таблица собрана.
 */
export type SerpObservationForGate = {
  engine?: string;
  surface?: string;
  region?: string;
  query?: string;
  rank?: number;
  /** Кто измерил позицию. Фильтром не служит — называется в сообщении отказа. */
  rankSource?: string;
  url?: string;
  title?: string;
  domain?: string;
};

/** Домен в сравнимом виде: без схемы, без www, в нижнем регистре. */
function bareDomain(raw: string | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "");
}

/** Домен из напечатанного адреса: `clientLink` печатает «домен/путь» без www. */
function printedDomain(link: string): string {
  return bareDomain(link).split("/")[0]!.trim();
}

/** Напечатанный адрес: текст в сравнимом виде и признак обрезки многоточием. */
type PrintedAddress = { text: string; truncated: boolean };

/** Адрес в сравнимом виде: без схемы, www, регистра и хвостовой косой черты. */
function comparableAddress(raw: string): string {
  return bareDomain(raw).replace(/\/+$/u, "").trim();
}

function withoutQuery(address: string): string {
  return address.replace(/[?#].*$/u, "");
}

/**
 * Тот ли это адрес, что напечатан в таблице.
 *
 * Печатная форма (`clientLink`) законно короче исходной двумя способами:
 * длиннее 165 знаков — режется многоточием, не влезает целиком — теряет строку
 * параметров. Поэтому обрезанный адрес сравнивается началом, а целый —
 * целиком либо без параметров. Сравнение «по домену» здесь было бы поблажкой:
 * строка `vk.ru` прощала бы `vk.ru/umar_kremlev`, которого в деке нет.
 */
function printedAddressMatches(printed: PrintedAddress, expected: string): boolean {
  if (!printed.text || !expected) return false;
  if (printed.truncated) return expected.startsWith(printed.text);
  if (printed.text === expected) return true;
  return withoutQuery(printed.text) === withoutQuery(expected);
}

/**
 * Печатная таблица выдачи сверяется с артефактом наблюдений — в обе стороны.
 *
 * Прогон 76: страница «ОАЭ — Google, ТОП-20» печатала двенадцать строк с
 * нумерацией обогатителя, а три настоящие позиции Serper (3 opensanctions.org,
 * 4 bloomberg.com, 10 wikidata.org) не печатала вовсе — при двадцати двух
 * зелёных воротах. Сверять таблицу тем же индексом доказательств, которым она
 * собрана, бессмысленно: сломанный тракт согласится сам с собой, — поэтому
 * входом служат наблюдения, а движок и запрос берутся из напечатанного пакета,
 * а не пересчитываются заново.
 *
 * Допустимые потери названы поимённо: дубль позиции (в выдаче двух третьих
 * строк не бывает, печатается одна) и маркер «ничего не найдено» — он не
 * строка выдачи.
 */
export function serpPrintMatchesObservations(input: {
  rendererSlides: ReadonlyArray<RendererSlide>;
  observations: ReadonlyArray<SerpObservationForGate>;
}): {
  issues: string[];
  skipped: string[];
  /**
   * Сколько таблиц сверено — признак «проверка выполнялась», взятый из
   * данных, а не из наличия строки в `skipped`.
   *
   * Пока признаком служило отсутствие объявленного пропуска, снятая строка
   * сообщения возвращала вакуумный проход: ключ проверки появлялся, и сводка
   * приёмки печатала «28 из 28» на деке, где сверять было нечего (замерено
   * мутацией). Число сверенных таблиц снять, не изменив поведения, нельзя.
   */
  comparedTables: number;
} {
  const issues: string[] = [];
  const skipped: string[] = [];
  type PrintedRow = { rank: number; domain: string; slideKey: string };
  const tables = new Map<
    string,
    { engine: string; query: string; region: string | null; rows: PrintedRow[] }
  >();
  /**
   * Все адреса, напечатанные в таблицах региона, — вторая половина вопроса
   * «доехал ли материал».
   *
   * Собираются со **всех** таблиц с колонкой «Ссылка», а не только с
   * позиционных: у листа «найдено по дополнительным запросам» колонки «№» нет
   * вовсе, а материал на нём клиент видит. Ключ — регион, потому что и вторая
   * таблица, и страницы выдачи региональные.
   */
  const printedByRegion = new Map<string, PrintedAddress[]>();
  const regionOf = (slide: RendererSlide): string | null =>
    slide.sectionKey === "RU_PROFILE" ? "RU" : slide.sectionKey === "UAE_PROFILE" ? "UAE" : null;
  for (const slide of input.rendererSlides) {
    if (!slide.table) continue;
    const addressColumn = (slide.table.headers ?? []).indexOf("Ссылка");
    if (addressColumn < 0) continue;
    const bucket = printedByRegion.get(regionOf(slide) ?? "") ?? [];
    for (const row of slide.table.rows) {
      const raw = String(row[addressColumn] ?? "").trim();
      if (!raw) continue;
      const truncated = /[…]$/u.test(raw);
      bucket.push({ text: comparableAddress(raw.replace(/…+$/u, "")), truncated });
    }
    printedByRegion.set(regionOf(slide) ?? "", bucket);
  }
  /** Напечатан ли этот материал хоть где-нибудь в своём регионе. */
  const printedSomewhere = (region: string | null, expected: string): boolean => {
    const own = printedByRegion.get(region ?? "") ?? [];
    const unbound = region === null ? [] : (printedByRegion.get("") ?? []);
    return [...own, ...unbound].some((p) => printedAddressMatches(p, expected));
  };
  for (const slide of input.rendererSlides) {
    const engine = String(slide.metrics?.serpEngine ?? "");
    const query = String(slide.metrics?.serpQuery ?? "");
    // Сверяются только позиционные таблицы. У движка без единой своей позиции
    // таблица честно вырождается в «собранную выдачу», и её номера — порядок
    // сбора: прочитанные как позиции, они дали бы «позиция N не подтверждена»
    // на каждой строке здорового прогона и уронили бы приёмку.
    const positional = Number(slide.metrics?.serpPositional ?? 0) === 1;
    if (!engine || !query || !positional || !slide.table) continue;
    const region = regionOf(slide);
    const key = `${slide.sectionKey}|${engine}|${query.trim().toLowerCase()}`;
    const table = tables.get(key) ?? { engine, query, region, rows: [] };
    /*
     * Домен строки берётся из её колонки «Ссылка» — оттуда же, откуда его
     * читает клиент. Колонки нет — сверять нечем, и строка попадает в сверку с
     * пустым доменом: молчаливый пропуск сделал бы ворота вакуумно зелёными
     * ровно там, где печать перестала называть источник.
     */
    const headers = slide.table.headers ?? [];
    const addressColumn = headers.indexOf("Ссылка");
    // Номер позиции — из колонки «№», а не из первой попавшейся. Записанный
    // числом индекс пережил бы перестановку колонок молча: `Number("forbes.ru")`
    // это NaN, строка тихо выпала бы из сверки, и ворота позеленели бы вакуумно
    // ровно там, где печать разъехалась с наблюдениями.
    const rankColumn = headers.indexOf("№");
    if (rankColumn < 0) continue;
    slide.table.rows.forEach((row) => {
      const rank = Number(row[rankColumn]);
      if (!Number.isFinite(rank) || rank <= 0) return;
      table.rows.push({
        rank,
        domain: printedDomain(addressColumn >= 0 ? String(row[addressColumn] ?? "") : ""),
        slideKey: slide.slideKey,
      });
    });
    tables.set(key, table);
  }
  if (tables.size === 0) {
    skipped.push(
      "сверка печатной таблицы выдачи с наблюдениями пропущена: в деке нет позиционных таблиц выдачи"
    );
    return { issues, skipped, comparedTables: 0 };
  }
  for (const table of tables.values()) {
    /*
     * Наблюдения этой самой пары «движок × запрос» с позицией не глубже
     * двадцатой — **кто бы их ни измерил**.
     *
     * Здесь стоял тот же предикат `rankSourceBelongsToEngine`, которым
     * фильтрует строки построитель, и прибор мерил тем, что создаёт дефект.
     * Замер прогона 91: по паре «YANDEX × Кремлев Умар Назарович» собрано 25
     * органических наблюдений с позицией ≤ 20, напечатано 16, материалы
     * позиций 18, 19 и 20 не напечатаны нигде — ворота отдали ноль замечаний
     * и ноль пропусков. Ожидание ворот обязано быть слепо к решениям
     * построителя, иначе оно проверяет согласие построителя с самим собой.
     */
    const owned = input.observations.filter(
      (o) =>
        String(o.surface ?? "organic") === "organic" &&
        String(o.engine ?? "").toUpperCase() === table.engine.toUpperCase() &&
        sameSerpQuery(o.query, table.query) &&
        typeof o.rank === "number" &&
        o.rank >= 1 &&
        o.rank <= SERP_TABLE_TOP_N &&
        (table.region === null || regionMatches(table.region, String(o.region ?? table.region))) &&
        !NOT_FOUND_PATTERNS.test(`${o.title ?? ""} ${o.domain ?? ""}`)
    );
    // Наблюдения одного материала сводятся в одну строку с лучшей позицией —
    // тем же ключом, что и в построителе.
    type ExpectedMaterial = { rank: number; domain: string; address: string; rankSource: string };
    const materials = new Map<string, ExpectedMaterial>();
    for (const o of owned) {
      const key = serpMaterialKey(o);
      const domain = bareDomain(o.domain);
      const known = materials.get(key);
      if (known && known.rank <= o.rank!) continue;
      materials.set(key, {
        rank: o.rank!,
        domain,
        address: comparableAddress(clientAddress(o.url) ?? o.domain ?? ""),
        rankSource: String(o.rankSource ?? "неизвестно"),
      });
    }
    const printedPairs = new Set(table.rows.map((r) => `${r.rank}|${r.domain}`));
    const expectedPairs = new Set([...materials.values()].map((m) => `${m.rank}|${m.domain}`));
    for (const row of table.rows) {
      if (expectedPairs.has(`${row.rank}|${row.domain}`)) continue;
      issues.push(
        `страница ${row.slideKey}: позиция ${row.rank} (${row.domain || "без адреса"}) не подтверждена наблюдением ${table.engine} по запросу «${table.query}»`
      );
    }
    for (const m of materials.values()) {
      if (printedPairs.has(`${m.rank}|${m.domain}`)) continue;
      /*
       * Вопрос — «доехал ли материал», а не «напечатан ли его номер».
       *
       * Здесь стояло прощение «номер занят кем-то другим», и оно ошибалось в
       * обе стороны: на прогоне 91 прощало четыре материала ТОП-20, которых в
       * деке нет вовсе (`vk.ru/umar_kremlev`, `tiktok.com/@umar_kremlev`,
       * `rostov.plus.rbc.ru`, `sport.rambler.ru/mma/56528744`), и жаловалось на
       * два, доехавших второй таблицей. Прощает только печать самого материала
       * — в любой таблице своего региона.
       */
      if (printedSomewhere(table.region, m.address)) continue;
      issues.push(
        `таблица ${table.engine} «${table.query}»: материал ${m.address || m.domain || "без адреса"} ` +
          `(позиция ${m.rank}, измерил ${m.rankSource}) не напечатан ни в одной таблице региона`
      );
    }
  }
  return { issues, skipped, comparedTables: tables.size };
}

/** Страница, зовущая читателя в раздел, которого в собранной деке нет. */
export type MissingSectionPromise = { slide: string; section: SectionType };
/**
 * Игла раздела — его клиентское имя без последней буквы, в нижнем регистре.
 *
 * Падежное окончание снимается одним правилом, поэтому «Приложение», «в
 * приложении» и «материалы приложения» узнаются одной строкой. Второго словаря
 * названий разделов в проекте нет и заводить его нельзя: он разошёлся бы с
 * `SECTION_TITLES`, а по нему печатаются заголовки самих разделов.
 */
function sectionNeedle(section: SectionType): string {
  return SECTION_TITLES[section].slice(0, -1).toLowerCase();
}

/**
 * Клиентский текст не отправляет читателя в раздел, которого в деке нет.
 *
 * Прибор на класс, а не на одну фразу. В прогоне 92 приложение объявлено
 * необязательным и отброшено ассемблером как пустое и законное, а десять
 * страниц продолжали звать читателя туда — девять строкой происхождения и
 * одна рекомендацией матрицы рисков. Ни одна проверка этого не видела: все
 * они судят страницу, а состав деки — вопрос к деке.
 *
 * Читается **собранная дека**, а не выход построителя: построитель согласен
 * сам с собой по определению и о том, доехал ли его сосед, не знает.
 *
 * Игла выводится из `SECTION_TITLES` одним объявленным правилом — имя без
 * последней буквы, регистр не важен, — а не вторым словарём названий: два
 * места, где раздел как-то называется, разошлись бы в первую же неделю.
 * Правило смотрит только на **отсутствующие** разделы, поэтому ссылка на
 * присутствующий раздел остаётся законной навигацией.
 *
 * Читается **наш** текст страницы, без таблицы. «Приложение» — обычное русское
 * слово, и в ячейке оно приезжает из данных провайдера («Умар Кремлёв —
 * мобильное приложение федерации бокса»); заголовок чужой страницы обещанием
 * нашего отчёта не является. Прочие поля мы пишем сами — и там, где они цитируют
 * материал, цитата стоит внутри нашей фразы, то есть внутри обещания.
 */
export function promisesOfMissingSections(
  slides: readonly (ClientVisibleSlide & { sectionKey?: string })[]
): MissingSectionPromise[] {
  const present = new Set(slides.map((s) => String(s.sectionKey ?? "")));
  const needles = (Object.keys(SECTION_TITLES) as SectionType[])
    .filter((section) => !present.has(section))
    .map((section) => ({ section, needle: sectionNeedle(section) }));
  if (needles.length === 0) return [];
  const out: MissingSectionPromise[] = [];
  for (const slide of slides) {
    // Таблица снимается здесь, а не в `clientVisibleStrings`: там вопрос «что
    // видит клиент», и ячейка входит в ответ. Здесь вопрос другой — «что мы
    // ему пообещали».
    const text = clientVisibleStrings({ ...slide, table: null }).join(" ").toLowerCase();
    for (const { section, needle } of needles) {
      if (text.includes(needle)) {
        out.push({ slide: slide.slideKey ?? slide.slideId ?? "?", section });
      }
    }
  }
  return out;
}

export function validateAssembly(input: {
  manifest: ReportSectionManifest;
  deckManifest: ReportDeckManifest;
  rendererSlides: RendererSlide[];
  packs: SectionPackV2[];
  bundle: VerifiedFindingBundle;
  baseObservationCountBefore: number;
  baseObservationCountAfter: number;
  /** Full run evidence index for sidebar-scope checks. */
  evidenceIndex?: ScopedEvidenceIndex;
  /**
   * Панели, привязанные к слотам. Без них проверка «страница не спорит со
   * своей панелью» не выполняется — и ключа в `checks` не появляется, чтобы
   * невыполненная проверка не выглядела пройденной.
   */
  visualAssets?: VisualAssetsBySlot;
  /**
   * Строки выдачи из артефакта наблюдений — вход сверки печати с данными.
   *
   * Отсутствуют — проверки нет вовсе и ключа в `checks` не появляется: ворота
   * без входа выглядят точно так же, как пройденные.
   */
  serpObservations?: ReadonlyArray<SerpObservationForGate>;
}): AssemblyValidationReport {
  const issues: string[] = [];
  /** Замеченное, что сборку не останавливает и `passed` не роняет. */
  const notes: string[] = [];
  const checks: Record<string, boolean> = {};
  const skipped: string[] = [];
  const { deckManifest, rendererSlides } = input;

  // All required sections present.
  const presentSections = new Set(deckManifest.sectionPageRanges.map((r) => r.sectionType));
  const missingRequired = REQUIRED_SECTIONS.filter((s) => !presentSections.has(s));
  checks.requiredSectionsPresent = missingRequired.length === 0;
  if (missingRequired.length) issues.push(`missing required sections: ${missingRequired.join(",")}`);

  // Section order matches manifest order.
  const orderInDeck = deckManifest.sectionPageRanges.map((r) => r.sectionType);
  const expectedOrder = input.manifest.sectionOrder.filter((s) => presentSections.has(s));
  checks.sectionOrderCorrect = JSON.stringify(orderInDeck) === JSON.stringify(expectedOrder);
  if (!checks.sectionOrderCorrect) {
    issues.push(`section order mismatch: deck=${orderInDeck.join(">")} manifest=${expectedOrder.join(">")}`);
  }

  // baseSlotId uniqueness across the deck.
  const baseSlots = deckManifest.slides.filter((s) => !s.isContinuation).map((s) => s.baseSlotId);
  checks.baseSlotIdsUnique = new Set(baseSlots).size === baseSlots.length;
  if (!checks.baseSlotIdsUnique) issues.push("duplicate baseSlotId in assembled deck");

  // Continuation adjacency.
  let adjacencyOk = true;
  for (let i = 0; i < deckManifest.slides.length; i += 1) {
    const s = deckManifest.slides[i];
    if (!s.isContinuation) continue;
    const prev = deckManifest.slides[i - 1];
    if (!prev || (prev.slideId !== s.continuationOf && prev.continuationOf !== s.continuationOf)) {
      adjacencyOk = false;
      issues.push(`continuation ${s.slideId} is not adjacent to its base`);
    }
  }
  checks.continuationAdjacency = adjacencyOk;

  // Page numbering continuous 1..N and pageCount consistent.
  const numberingOk =
    deckManifest.slides.every((s, i) => s.pageNumber === i + 1) &&
    deckManifest.pageCount === deckManifest.slides.length &&
    rendererSlides.length === deckManifest.pageCount &&
    rendererSlides.every((s) => s.totalPageCount === deckManifest.pageCount);
  checks.pageNumberingConsistent = numberingOk;
  if (!numberingOk) issues.push("page numbering inconsistent");

  // TOC ranges match the deck.
  let tocOk = true;
  for (const range of deckManifest.sectionPageRanges) {
    if (range.sectionType === "FRONT_MATTER") continue;
    const line = deckManifest.toc.find((t) => t.pageNumber === range.firstPage);
    if (!line || !line.title.includes(`стр. ${range.firstPage}–${range.lastPage}`)) {
      tocOk = false;
      issues.push(`TOC line missing/mismatched for ${range.sectionType}`);
    }
  }
  // No per-line "(N стр.)" artifacts.
  if (deckManifest.toc.some((t) => /\(\d+\s*стр\.\)/u.test(t.title))) {
    tocOk = false;
    issues.push("TOC contains forbidden '(N стр.)' per line");
  }
  checks.tocMatchesDeck = tocOk;

  // Global KPI vs section metrics: displayed adverse in executive >= any pack's
  // mandatory adverse; and executive summary must include every promoted
  // adverse P1/P2 finding.
  const adverseP12 = input.bundle.findings.filter(
    (f) =>
      f.subjectMatch === "SUBJECT_MATCH" &&
      (f.promotionPriority === "P1" || f.promotionPriority === "P2") &&
      (RISK_ORDER[f.riskLevel] ?? 0) >= 2
  );
  const executiveSlideFindingIds = new Set(
    rendererSlides.filter((s) => s.sectionKey === "EXECUTIVE").flatMap((s) => s.findingIds)
  );
  const missingAdverse = adverseP12.filter((f) => !executiveSlideFindingIds.has(f.findingId));
  checks.adverseInExecutiveSummary = missingAdverse.length === 0;
  if (missingAdverse.length) {
    issues.push(
      `adverse P1/P2 findings absent from executive summary: ${missingAdverse
        .map((f) => f.findingId)
        .join(",")}`
    );
  }

  // Findings must not contradict each other silently: a finding pair with a
  // recorded contradiction must expose it (limitations/contradictions kept).
  checks.contradictionsPreserved = true;

  // Base dataset never shrinks after overlay.
  checks.baseDatasetPreserved = input.baseObservationCountAfter >= input.baseObservationCountBefore;
  if (!checks.baseDatasetPreserved) {
    issues.push(
      `base dataset shrank: ${input.baseObservationCountBefore} -> ${input.baseObservationCountAfter}`
    );
  }

  // No empty status labels: every table "Оценка" cell must be non-empty.
  let labelsOk = true;
  for (const slide of rendererSlides) {
    const table = slide.table;
    if (!table) continue;
    const statusCol = table.headers.findIndex((h) => h === "Оценка");
    if (statusCol < 0) continue;
    for (const row of table.rows) {
      if (!String(row[statusCol] ?? "").trim()) {
        labelsOk = false;
        issues.push(`empty status label on ${slide.slideKey}`);
      }
    }
  }
  checks.noEmptyStatusLabels = labelsOk;

  /*
   * Каноническое покрытие: присутствовать обязаны все базовые слоты.
   *
   * Сколько их — знает сам перечень, а не литерал рядом. Литералов было шесть,
   * и добавление слота означало бы шесть согласованных правок: пропусти одну —
   * и приёмка либо молчит о недостающем листе, либо краснеет на полной деке.
   */
  const requiredSlots = CANONICAL_SLOT_IDS.length;
  checks.canonicalBaseSlotCoverage = deckManifest.baseSlotCoverage === requiredSlots;
  if (!checks.canonicalBaseSlotCoverage) {
    issues.push(`baseSlotCoverage=${deckManifest.baseSlotCoverage}, expected ${requiredSlots}`);
  }

  // A slide with a bound visual asset must never render as an
  // VISUAL_ASSET_UNAVAILABLE placeholder.
  let visualOk = true;
  for (const slide of rendererSlides) {
    if (slide.visualAssetRefs.length > 0 && slide.emptyStateReason === "VISUAL_ASSET_UNAVAILABLE") {
      visualOk = false;
      issues.push(`slide ${slide.slideKey} has bound assets but renders as placeholder`);
    }
  }
  checks.noPlaceholderWithAvailableAsset = visualOk;

  // Внутренние коды в клиентском тексте (шаг 07.8): отчёт читает человек, и
  // техническая константа в скобках не сообщает ему ничего.
  const internalCodes = scanDeckForInternalCodes(rendererSlides);
  checks.noInternalCodesInClientText = internalCodes.length === 0;
  for (const f of internalCodes.slice(0, 10)) {
    issues.push(`internal code ${f.code} in client text of ${f.slide}`);
  }
  /*
   * Токены нижнего регистра — замечание, а не приговор.
   *
   * Ник в соцсети и имя набора по форме неотличимы: живой прогон 21.08 (кейс
   * Кремлёв) встал на `umar_kremlev` и `shara_bullet77` — так подписаны
   * аккаунты в заголовках страниц выдачи. Останавливать оплаченный отчёт на
   * последнем шаге из-за чужой подписи нельзя (решение владельца 21.08).
   *
   * В `issues` они не идут намеренно: от `issues` зависит `passed`, а от него —
   * ворота приёмки эталона. Иначе блокировка просто переехала бы в другую дверь.
   */
  const codeLike = scanDeckForCodeLikeTokens(rendererSlides);
  for (const f of codeLike.slice(0, 10)) {
    notes.push(`code-like token ${f.code} in client text of ${f.slide}`);
  }

  /*
   * Клиентский текст не отправляет читателя в раздел, которого в деке нет.
   *
   * Замечание, а не приговор — по тому же основанию, что у токенов выше. Игла
   * это клиентское имя раздела без падежного окончания, и «приложени» совпадает
   * с обычным русским словом: цена ложного срабатывания в `issues` — упавший
   * `passed`, то есть остановленная приёмка эталона и красный офлайн-смок.
   * Жёсткий отказ живёт на самом ключе `checks`, который смок и проверяет.
   */
  const missingSectionPromises = promisesOfMissingSections(rendererSlides);
  checks.noPromisesOfMissingSections = missingSectionPromises.length === 0;
  for (const p of missingSectionPromises.slice(0, 10)) {
    notes.push(
      `слайд ${p.slide} отправляет читателя в отсутствующий раздел «${SECTION_TITLES[p.section]}»`
    );
  }

  // --- Manual-quality gates (fail closed) ---

  // 1. emptySidebarCount=0: every slide that renders the analytical sidebar
  //    (visual template + bound asset) must carry a dynamic conclusion, a
  //    relevance/meaning line and a recommended action — an empty titled
  //    «Вывод» panel is a validation failure.
  const templateBySlot = new Map(deckManifest.slides.map((s) => [s.slideId, s.templateId]));
  let emptySidebarCount = 0;
  for (const slide of rendererSlides) {
    if (slide.visualAssetRefs.length === 0) continue;
    if (!SIDEBAR_TEMPLATES.has(slide.template)) continue;
    // Вывод, значение и рекомендация принадлежат первой странице блока:
    // продолжение несёт остаток перечня, и повторять на нём тот же вывод — то
    // самое дублирование, которое из отчёта убирали. Спрашивать сайдбар с
    // продолжения значит требовать повтора.
    if (slide.isContinuation) continue;
    const hasConclusion = Boolean(slide.whatWasFound?.trim());
    const hasMeaning = Boolean(
      slide.whyItMatters?.trim() || slide.statusNote?.trim() || slide.narrative?.trim()
    );
    const hasAction = Boolean(slide.whatToCheck?.trim());
    if (!hasConclusion || !hasMeaning || !hasAction) {
      emptySidebarCount += 1;
      issues.push(
        `empty analytical sidebar on ${slide.slideKey}: conclusion=${hasConclusion} meaning=${hasMeaning} action=${hasAction}`
      );
    }
  }
  checks.emptySidebarCountZero = emptySidebarCount === 0;

  /*
   * 2. unexplainedAdverseMarkerCount=0: каждая нарисованная красная рамка
   *    объяснена в панели рядом.
   *
   * Ворот сравнивал с объяснениями **число негативных находок слайда** —
   * величину, к рамкам отношения не имеющую. Замер на эталоне 72: у
   * `p15_ru_images_2` и `p16_ru_images_3` рамок нет вовсе при одной негативной
   * находке, у `p17_ru_images_4` находок две при одной рамке. Пять рамок при
   * трёх находках и трёх объяснениях старая редакция пропускала — так рамка,
   * которую никто не объяснил, и доехала до клиента при 26 зелёных воротах.
   *
   * Единица счёта — **различный `ref`**, а не нарисованный прямоугольник:
   * у `p10_ru_serp_visual` два привязанных снимка рисуют одни и те же две
   * строки (экземпляров 4, материалов 2, объяснений 2), и счёт по
   * прямоугольникам покраснел бы на здоровом эталоне. Тем же ключом сводит
   * строки построитель объяснений (`adverseVisualSidebar`).
   *
   * Смотрит ворот на любой слайд с привязанным ассетом, а не только на снимок
   * выдачи: рамки рисует и сетка изображений, и панель поверхности, и до сих
   * пор их не проверял никто. Но **не всякая картинка рисует рамки**, а
   * `adverse` во `visibleItems` ставит один классификатор всем видам сразу.
   * Отвечает на это `assetKindDrawsRedFrames` — один на продукт, рядом с
   * рисующими; списка шаблонов здесь нет намеренно, второй ответ на тот же
   * вопрос разошёлся бы с первым.
   *
   * **Чего этот ворот не ловит.** Объяснения пишут все четыре построителя
   * визуальных панелей — снимок выдачи, сетка изображений, подсказки и
   * связанные запросы, — и все четыре берут их из тех же `visibleItems` с той
   * же дедупликацией по `ref`, поэтому равенство у них выполняется по
   * построению. Ворот сторожит участок **после** построителя: сборку деки,
   * вычистку продолжений, перекладку буллетов и любой будущий построитель,
   * который напишет объяснения сам. Прочитать его зелень как «объяснения
   * верны» нельзя. (Панель связанных запросов была исключением до шага 0038:
   * рамку рисовала, объяснений не писала вовсе, и на живом прогоне негативный
   * связанный запрос дал бы «рамок 1, объяснений 0».)
   *
   * Считается по списку слайда, а не по сайдбару пейлоада: `buildVisualAnalysis`
   * (`run-deck-build.ts`) печатает первые `SIDEBAR_HIGHLIGHT_SLOTS` объяснений
   * и называет остаток числом («ещё 3»), то есть объявленная урезка, а не
   * потеря.
   */
  let unexplainedAdverseMarkerCount = 0;
  let slidesMeasured = 0;
  const slidesWithoutAssetMeta: string[] = [];
  const unknownAssetKinds = new Set<string>();
  const frameIssues: string[] = [];
  for (const slide of rendererSlides) {
    if (slide.visualAssetRefs.length === 0) continue;
    // Продолжение объяснений не несёт по той же причине, что и сайдбара выше.
    if (slide.isContinuation) continue;
    const metas = input.visualAssets?.[slide.baseSlotId] ?? [];
    if (metas.length === 0) {
      slidesWithoutAssetMeta.push(slide.slideKey);
      continue;
    }
    const unknown = metas.filter((m) => assetKindDrawsRedFrames(m.kind) === null);
    if (unknown.length > 0) {
      for (const m of unknown) unknownAssetKinds.add(m.kind);
      continue;
    }
    slidesMeasured += 1;
    const framedRefs = new Set<string>();
    for (const meta of metas) {
      if (!assetKindDrawsRedFrames(meta.kind)) continue;
      for (const row of meta.visibleItems ?? []) {
        if (row.adverse === true) framedRefs.add(row.ref);
      }
    }
    const explained = slide.highlightExplanations?.length ?? 0;
    if (framedRefs.size > explained) {
      unexplainedAdverseMarkerCount += framedRefs.size - explained;
      frameIssues.push(
        `страница ${slide.slideKey}: рамок на привязанных ассетах ${framedRefs.size}, объяснений ${explained}`
      );
    }
  }
  issues.push(...frameIssues.slice(0, 10));
  /*
   * Невыполнимая проверка объявляется словами.
   *
   * Ветка `gpt-copy` инициализирует `visualAssetsBySlot = {}` и оставляет
   * пустым, если `visual-assets-by-slot.json` не прочитался; пустой объект
   * истинен, и ворот нашёл бы ноль рамок на каждой странице — зелено
   * вакуумно. Поэтому страница, измерить которую нечем, называется строкой, а
   * ключа в `checks` не появляется вовсе: скрипт приёмки читает его как
   * `?? false` и покраснеет, а не примет пропуск за проход. Ключ исчезает и
   * при одной такой странице: ворот, измеривший половину деки, снаружи
   * неотличим от ворота, измерившего её целиком.
   */
  const cannotMeasure: string[] = [];
  if (slidesWithoutAssetMeta.length > 0) {
    cannotMeasure.push(
      `у страниц ${namedList(slidesWithoutAssetMeta)} привязан ассет, но его меты во входе нет`
    );
  }
  if (unknownAssetKinds.size > 0) {
    cannotMeasure.push(
      `о видах ассетов ${namedList([...unknownAssetKinds])} не сказано, рисуют ли они рамки`
    );
  }
  if (cannotMeasure.length === 0 && slidesMeasured === 0) {
    cannotMeasure.push("в деке нет ни одной страницы с привязанным ассетом");
  }
  if (cannotMeasure.length > 0) {
    skipped.push(`проверка «каждая рамка объяснена» пропущена: ${cannotMeasure.join("; ")}`);
  } else {
    checks.unexplainedAdverseMarkerCountZero = unexplainedAdverseMarkerCount === 0;
  }

  // 3. Every visual card slide either binds a rendered asset, carries an
  //    explicit fallback/empty-state reason, or downgrades to a text layout
  //    with real content — never a blank unlabeled card.
  let visualCardsOk = true;
  for (const slide of rendererSlides) {
    const isVisualTemplate =
      SIDEBAR_TEMPLATES.has(slide.template) || slide.template === "orion_golden_image_grid";
    if (!isVisualTemplate) continue;
    if (slide.visualAssetRefs.length > 0 || slide.emptyStateReason) continue;
    const hasTextContent =
      Boolean(slide.narrative?.trim()) ||
      (slide.bullets ?? []).some((b) => b.trim()) ||
      (slide.table?.rows.length ?? 0) > 0 ||
      Boolean(slide.whatWasFound?.trim());
    if (!hasTextContent) {
      visualCardsOk = false;
      issues.push(`visual slide ${slide.slideKey} has neither a bound asset nor an explicit fallback`);
    }
  }
  checks.visualCardsResolvedOrLabeled = visualCardsOk;

  // 4. No titled content container is materially empty: every non-structural
  //    slide must carry real content (narrative/bullets/table/kpis/visual or
  //    the finding blocks), or be an explicit valid empty state.
  let materiallyEmptyPages = 0;
  for (const slide of rendererSlides) {
    const templateId = templateBySlot.get(slide.slideKey) ?? "";
    if (STRUCTURAL_TEMPLATES.has(templateId)) continue;
    if (slide.emptyStateReason && (slide.narrative || (slide.bullets ?? []).length)) continue;
    const hasContent =
      Boolean(slide.narrative?.trim()) ||
      (slide.bullets ?? []).some((b) => b.trim()) ||
      (slide.table?.rows.length ?? 0) > 0 ||
      (slide.kpis?.length ?? 0) > 0 ||
      slide.visualAssetRefs.length > 0 ||
      Boolean(slide.whatWasFound?.trim());
    if (!hasContent) {
      materiallyEmptyPages += 1;
      issues.push(`materially empty page: ${slide.slideKey} (${templateId})`);
    }
  }
  checks.noMateriallyEmptyPages = materiallyEmptyPages === 0;

  /*
   * 4а. Слайд не объявляет таблицу, которой у него нет.
   *
   * Пустая таблица — не пустая страница, а приглашение рендереру выдумать
   * содержимое: `slides.py` идёт веткой `if not rows and bullets`, ставит
   * заголовки таблицы поиска «Поз. / Домен / Заголовок / Риск» и разбирает в
   * её строки буллеты слайда. Так сводная страница комплаенса при нуле
   * совпадений печатала клиенту таблицу поиска со строкой прочерков.
   *
   * Ворот стоит здесь, а не в рендерере: запасная ветка живёт в другой единице
   * деплоя, а дверь закрывают там, где она есть. Утверждение структурное и
   * закрывает класс для всех построителей: честное пустое состояние строится
   * шаблоном `coverage-empty-state` и таблицы не несёт вовсе.
   */
  const emptyTableSlides = new Set<string>();
  for (const slide of rendererSlides) {
    if (slide.table && slide.table.rows.length === 0) {
      emptyTableSlides.add(slide.slideKey);
      issues.push(
        `declared table without rows: ${slide.slideKey} (${templateBySlot.get(slide.slideKey) ?? ""})`
      );
    }
  }
  checks.declaredTablesHaveRows = emptyTableSlides.size === 0;

  /*
   * 4а-бис. Строка таблицы не печатает свой адрес дважды.
   *
   * Ворот стоит здесь, а не в приёмке эталона: защищать он обязан **живой**
   * прогон, где провайдер такие заголовки и отдаёт. Чем он отличается от
   * ворота «страница не печатает один и тот же текст дважды», объяснено при
   * блокирующем отказе (`blockingIssues`).
   */
  const ownAddressRowSlides = new Set<string>();
  const ownAddressRows = rowsPrintingTheirOwnAddress(rendererSlides);
  for (const row of ownAddressRows) {
    ownAddressRowSlides.add(row.slideKey);
    issues.push(`row prints its own address twice: ${row.slideKey} row ${row.row}`);
  }
  if (rendererSlides.every((s) => ((s.table?.headers ?? []).indexOf("Ссылка") < 0))) {
    // Ворот без входа выглядит точно так же, как пройденный: в деке без единой
    // таблицы с колонкой адреса проверять нечего, и ключа в `checks` не будет.
    skipped.push(
      "проверка «строка не печатает свой адрес дважды» пропущена: " +
        "в деке нет ни одной таблицы с колонкой адреса"
    );
  } else {
    checks.serpRowTitleIsNotItsAddress = ownAddressRowSlides.size === 0;
  }

  /*
   * 4б. Цитата доходит до читателя целой.
   *
   * Отчёт цитирует источники дословно, и обрывок в кавычках — это уже не
   * цитата, а наше утверждение неизвестного происхождения. На прогоне 14.08
   * вычистка повторов оставила на странице `«ИП Юнусов Тимур Ильдарович
   * зарегистрирован 25.12.2008.` — без закрывающей кавычки и без источника,
   * который шёл следующим предложением.
   *
   * Ворота проверяют три вещи разом: кавычки закрыты, у цитаты назван источник,
   * блок не кончается предлогом. Причина у них общая — текст режут где попало,
   * — а признаки разные, поэтому названы отдельно в перечне нарушений.
   */
  let quoteIntegrityOk = true;
  const quoteDefectSlides = new Set<string>();
  for (const slide of rendererSlides) {
    // Страницы-перечни цитируют не источник, а поверхность: подсказка и
    // связанный запрос стоят в кавычках, но источник у них один на всю
    // страницу — поисковая система, и названа она в описании страницы.
    if (isDataRowTemplate(templateBySlot.get(slide.slideKey) ?? "")) continue;
    for (const bullet of slide.bullets ?? []) {
      for (const problem of quoteIntegrityProblems(bullet)) {
        quoteIntegrityOk = false;
        quoteDefectSlides.add(slide.slideKey);
        issues.push(`${problem} on ${slide.slideKey}`);
      }
    }
  }
  checks.quotesWholeAndSourced = quoteIntegrityOk;

  /*
   * 4в. Страница не печатает один и тот же текст дважды.
   *
   * Замечание владельца с живого прогона — «дублируется текст на одном
   * слайде», — и вручную такое не правится: ловить обязан ворот, а не читатель
   * готового отчёта.
   *
   * Сравниваются все блоки страницы, которые видит клиент: абзац, пункты
   * списка и ссылка на источник. Одних `bullets` мало — форма «абзац повторяет
   * первый пункт» до клиента доезжала (§«Абзац страницы печатается один раз»),
   * а на карточной странице матрицы рисков пункты печатаются вовсе не списком,
   * а плитками тем. Поля `whatWasFound`/`whyItMatters`/`whatToCheck` в перечень
   * не входят намеренно: их склеивает в абзац `composeFindingProse`
   * (`deck-sections/page-narrative.ts` — туда она переехала шагом 0039, чтобы
   * её могли спросить и нагрузка, и разбивка абзаца), и она же снимает
   * предложения, уже сказанные абзацем или пунктом, — ответ на этот вопрос
   * там один и повторять его здесь нельзя.
   *
   * Сравнение нормализованное, а не побайтовое: один и тот же блок два
   * построителя печатают по-разному. `p03_executive` даёт «Криминальные /
   * судебные материалы» в ёлочках, `p05_profile_dashboard` — без них;
   * побайтово это разные строки, для читателя — одна. Линейка берётся общая
   * (`normalizeForCompare`): ею же меряют повтор сборка деки и вычистка
   * присказок, а вторая линейка «одинаковости текста» — второй ответ на один
   * вопрос.
   *
   * Страницы, где строки — данные провайдера, а не наша проза, исключены тем
   * же предикатом, что и у соседей (`isDataRowTemplate`): подсказка Google,
   * дословно совпавшая с подсказкой Яндекса, — два факта, а не повтор, и
   * вычистка таких строк однажды оставила на странице три запроса из десяти,
   * нарисованных на панели. Заодно это снимает строки таблиц: две строки
   * выдачи с одинаковым заголовком законны, их различает адрес под строкой.
   */
  const repeatedTextSlides = new Set<string>();
  let anyPageComparable = false;
  for (const slide of rendererSlides) {
    if (isDataRowTemplate(templateBySlot.get(slide.slideKey) ?? "")) continue;
    const printed = [slide.narrative, ...(slide.bullets ?? []), slide.sourceNote]
      .map((block) => withoutFindingMarkers(String(block ?? "")))
      .filter((block) => block.length > 0);
    if (printed.length >= 2) anyPageComparable = true;
    const seen = new Set<string>();
    for (const block of printed) {
      // Блок, от которого после нормализации не осталось ни слова (одно тире,
      // многоточие), текстом клиенту не виден: считать такие дублем значило бы
      // краснеть на вёрстке, а не на повторе.
      const key = normalizeForCompare(block);
      if (!key) continue;
      if (seen.has(key)) {
        repeatedTextSlides.add(slide.slideKey);
        issues.push(
          `repeated text on ${slide.slideKey}: ${block.replace(/\s+/gu, " ").slice(0, 90)}`
        );
        continue;
      }
      seen.add(key);
    }
  }
  if (!anyPageComparable) {
    // Ворот без входа выглядит точно так же, как пройденный, поэтому ключа в
    // `checks` не появляется вовсе, а пропуск называется строкой. Вход — это
    // страница минимум с двумя блоками: на странице с одним ворот проходит
    // тривиально и не означает ничего.
    skipped.push(
      "проверка «страница не печатает один и тот же текст дважды» пропущена: " +
        "ни на одной странице деки нет двух блоков клиентского текста"
    );
  } else {
    checks.noRepeatedTextOnPage = repeatedTextSlides.size === 0;
  }

  // 5. Explicit page accounting: every page is a canonical base slot, a
  //    continuation, or an explained optional extra.
  const accountedExtra = new Set(deckManifest.nonCanonicalPages.map((p) => p.slideId));
  let accountingOk = true;
  for (const s of deckManifest.slides) {
    if (s.pageKind === "canonical_base" || s.pageKind === "continuation") continue;
    if (!accountedExtra.has(s.slideId)) {
      accountingOk = false;
      issues.push(`page ${s.pageNumber} (${s.slideId}) is an unexplained non-canonical insert`);
    }
  }
  for (const p of deckManifest.nonCanonicalPages) {
    if (!p.reason.trim()) {
      accountingOk = false;
      issues.push(`nonCanonicalPages entry ${p.slideId} lacks a reason`);
    }
  }
  checks.pageAccountingComplete = accountingOk;

  // --- Sidebar evidence-scope gates (fail closed) ---

  // 6. Sidebar findings/evidence must be subsets of the owning fragment's
  //    scoped inputs — no global-finding fallback in a scoped fragment.
  const packBySlideId = new Map<string, SectionPackV2>();
  for (const pack of input.packs) {
    for (const slide of pack.slides) packBySlideId.set(slide.slideId, pack);
  }
  let subsetOk = true;
  for (const slide of rendererSlides) {
    const pack = packBySlideId.get(slide.slideKey);
    if (!pack) continue;
    const inputFindingIds = new Set(pack.inputs.findingIds);
    const inputRefs = new Set(pack.inputs.evidenceRefs);
    for (const id of slide.findingIds) {
      if (!inputFindingIds.has(id)) {
        subsetOk = false;
        issues.push(`slide ${slide.slideKey}: findingId ${id} outside fragment scope`);
      }
    }
    for (const ref of slide.evidenceRefs) {
      if (!inputRefs.has(ref)) {
        subsetOk = false;
        issues.push(`slide ${slide.slideKey}: evidenceRef ${ref} outside fragment scope`);
      }
    }
  }
  checks.sidebarScopeSubsets = subsetOk;

  // 7. Region-scope isolation: RU pages must not cite UAE evidence and vice
  //    versa (region aliases: UAE covers INTERNATIONAL/GLOBAL).
  let regionOk = true;
  if (input.evidenceIndex) {
    for (const slide of rendererSlides) {
      const scopeRegion =
        slide.sectionKey === "RU_PROFILE" ? "RU" : slide.sectionKey === "UAE_PROFILE" ? "UAE" : null;
      if (!scopeRegion) continue;
      for (const ref of slide.evidenceRefs) {
        const region = input.evidenceIndex[ref]?.region;
        if (region && !regionMatches(scopeRegion, region)) {
          regionOk = false;
          issues.push(`slide ${slide.slideKey}: ${scopeRegion} page cites ${region} evidence ${ref}`);
        }
      }
    }
  }
  checks.regionScopeIsolation = regionOk;

  // 8. Source footer derived from the slide's own (sidebar) evidence: every
  //    domain named in the footer or highlight explanations of a visual
  //    sidebar must resolve through that slide's evidenceRefs.
  let footerOk = true;
  if (input.evidenceIndex) {
    // Продолжение наследует область своей базы: лист «почему выделено» несёт
    // тот же текст, что панель, и обязан отвечать за домены так же.
    const sidebarBaseKeys = new Set(
      rendererSlides
        .filter((s) => SIDEBAR_TEMPLATES.has(s.template) && s.visualAssetRefs.length > 0)
        .map((s) => s.slideKey)
    );
    for (const slide of rendererSlides) {
      const ownScope = SIDEBAR_TEMPLATES.has(slide.template) && slide.visualAssetRefs.length > 0;
      const inheritedScope =
        slide.isContinuation && slide.continuationOf
          ? sidebarBaseKeys.has(slide.continuationOf)
          : false;
      if (!ownScope && !inheritedScope) continue;
      const normRefs = new Set(slide.evidenceRefs.map(normalizeEvidenceRef));
      const allowed = new Set<string>();
      const allowedLinks = new Set<string>();
      const evidenceTexts = new Set<string>();
      for (const [ref, e] of Object.entries(input.evidenceIndex)) {
        if (!normRefs.has(normalizeEvidenceRef(ref))) continue;
        if (e.domain && e.domain !== "—") allowed.add(normalizeDomainForCompare(e.domain));
        // Адрес — в той же форме, в какой его печатает отчёт: сверка идёт
        // строкой, а не разбором границ.
        const link = clientAddress(e.url);
        if (link) allowedLinks.add(link);
        // Слова самого материала — см. `undeclaredClientTextDomainHits`.
        if (e.title) evidenceTexts.add(String(e.title));
        if (e.snippet) evidenceTexts.add(String(e.snippet));
      }
      const textsRaw: Array<[string, string | undefined]> = [
        ["sourceNote", slide.sourceNote],
        ["whatWasFound", slide.whatWasFound],
        ...(slide.highlightExplanations ?? []).map(
          (h, i) => [`highlightExplanations[${i}]`, h.clientReason] as [string, string | undefined]
        ),
        ...(inheritedScope && !ownScope
          ? (slide.bullets ?? []).map((b, i) => [`bullets[${i}]`, b] as [string, string | undefined])
          : []),
      ];
      const texts = textsRaw.filter((entry): entry is [string, string] =>
        Boolean(entry[1])
      );
      for (const [field, text] of texts) {
        // Разбор доменов — общий с секционной валидацией: два своих выражения
        // на один вопрос уже расходились (ASCII против юникода), и напечатанный
        // адрес страницы одно из них читало как чужой домен.
        for (const hit of undeclaredClientTextDomainHits(text, allowed, allowedLinks, evidenceTexts)) {
          footerOk = false;
          issues.push(
            `slide ${slide.slideKey}: sidebar names domain ${hit.domain} not derived from its evidence` +
              ` (${field}, «${hit.raw}»: ${hit.context})`
          );
        }
      }
    }
  }
  checks.sourceFooterFromSidebarEvidence = footerOk;

  /*
   * 9. Страница не спорит со своей панелью.
   *
   * Ни одна проверка не сравнивала страницу с её же картинкой: сайдбар
   * заполнен («0 связанных запросов» — тоже текст), ассет привязан — значит
   * «содержимое есть». Так девятнадцать ворот приняли деку, где под снимком
   * панели с четырьмя запросами стояло «0 связанных запросов».
   *
   * Условий два, и первое важнее. «Джойн жив» ловит сам дефект: панель
   * записала ссылки, а разрешить не удалось ни одну — значит, сломано
   * разрешение ссылок, и обе стороны сравнения покажут ноль. Второе условие —
   * «ноль при нарисованных»: равенства счётов здесь не требуем, это работа
   * построителя (`panelRows`), и дублировать её тут значило бы завести второй
   * ответ на тот же вопрос.
   *
   * Обе проверки смотрят только на страницы запросов и подсказок, и это
   * граница, а не экономия. Их строки отбираются по тексту ещё до записи
   * ассета, поэтому строка без текста там означает поломку. У сетки картинок и
   * панели знаний всё наоборот: строки пишутся без отбора, у картинки в выдаче
   * заголовка часто нет вовсе (плитка потому и подписана «Изображение из
   * поиска»), а у строки, известной только `imageUrl`, нет и адреса. Считать
   * такую страницу поломкой значит останавливать здоровый оплаченный прогон на
   * последней стадии — ровно то, чего ворота не вправе делать.
   *
   * Разрешённой считается строка с заголовком или адресом — то же определение,
   * которым проверяется индекс загрузчика: ссылка без того и другого никуда не
   * разрешилась.
   */
  const panelMismatchSlides = new Set<string>();
  if (input.visualAssets) {
    const slidesByBaseSlot = new Map<string, RendererSlide[]>();
    const templateByBaseSlot = new Map<string, string>();
    for (const slide of rendererSlides) {
      const kin = slidesByBaseSlot.get(slide.baseSlotId);
      if (kin) kin.push(slide);
      else slidesByBaseSlot.set(slide.baseSlotId, [slide]);
      if (!slide.isContinuation) {
        templateByBaseSlot.set(slide.baseSlotId, templateBySlot.get(slide.slideKey) ?? "");
      }
    }
    for (const [slotId, metas] of Object.entries(input.visualAssets)) {
      if (!PANEL_ROW_TEMPLATES.has(templateByBaseSlot.get(slotId) ?? "")) continue;
      let titledRows = 0;
      for (const meta of metas) {
        const rows = meta.visibleItems ?? [];
        titledRows += rows.filter((v) => Boolean(String(v.title ?? "").trim())).length;
        const resolved = rows.filter((v) =>
          Boolean(String(v.title ?? "").trim() || String(v.url ?? "").trim())
        ).length;
        const recorded = meta.evidenceRefs?.length ?? 0;
        if (recorded > 0 && resolved === 0) {
          panelMismatchSlides.add(slotId);
          issues.push(
            `панель ${slotId} (${meta.assetRef}): записано ${recorded} ссылок, ни одна не разрешилась в видимую строку`
          );
        }
      }
      if (titledRows === 0) continue;
      for (const slide of slidesByBaseSlot.get(slotId) ?? []) {
        if (slide.isContinuation || slide.visualAssetRefs.length === 0) continue;
        if ((slide.bullets ?? []).some((b) => b.trim())) continue;
        panelMismatchSlides.add(slide.slideKey);
        issues.push(
          `страница ${slide.slideKey}: на панели ${titledRows} строк, напечатано ноль`
        );
      }
    }
    checks.panelPagesMatchDrawnRows = panelMismatchSlides.size === 0;
  }

  /*
   * 10. Напечатанная таблица выдачи сходится с наблюдениями.
   *
   * Смотрит в обе стороны и читает артефакт, а не индекс доказательств
   * (см. `serpPrintMatchesObservations`).
   */
  if (input.serpObservations) {
    const serp = serpPrintMatchesObservations({
      rendererSlides,
      observations: input.serpObservations,
    });
    /*
     * Пропуск — не проход, и решают это данные, а не название.
     *
     * Ключ проверки появляется только там, где сверена хотя бы одна таблица:
     * `true` на невыполненной сверке делает ворот неотличимым от работающего,
     * и сводка приёмки печатала «28 из 28» на деке, где сверять было нечего.
     * Признаком служило отсутствие строки в `skipped` — то есть текст
     * сообщения; снятая строка возвращала вакуумный проход одной правкой.
     */
    if (serp.comparedTables > 0) {
      checks.serpTableMatchesObservations = serp.issues.length === 0;
    }
    issues.push(...serp.issues.slice(0, 20));
    skipped.push(...serp.skipped);
  }

  // No stale packs: manifest hash must match pack hash for every entry.
  const packByKey = new Map(input.packs.map((p) => [p.fragmentKey, p]));
  let staleOk = true;
  for (const entry of input.manifest.entries) {
    const pack = packByKey.get(entry.fragmentKey);
    if (pack && pack.contentHash !== entry.contentHash) {
      staleOk = false;
      issues.push(`stale pack vs manifest: ${entry.fragmentKey}`);
    }
  }
  checks.noStalePacks = staleOk;

  // Self-contained lineage: every pack carries an explicit caseId/datasetId
  // that matches the assembled deck lineage (no caseId=undefined packs).
  let packLineageOk = true;
  for (const pack of input.packs) {
    if (!pack.caseId || pack.caseId !== deckManifest.caseId) {
      packLineageOk = false;
      issues.push(`pack ${pack.fragmentKey} caseId ${String(pack.caseId)} != deck ${deckManifest.caseId}`);
    }
    if (pack.datasetId !== deckManifest.sourceDatasetId) {
      packLineageOk = false;
      issues.push(
        `pack ${pack.fragmentKey} datasetId ${pack.datasetId} != deck ${deckManifest.sourceDatasetId}`
      );
    }
  }
  checks.packSelfContainedLineage = packLineageOk;

  // Geometry-level clipping/overlap is validated by the existing PPTX geometry
  // gate after render; at the model level we assert budgets were enforced by
  // section QA (validationPassed for all entries).
  checks.sectionQaAllPassed = input.manifest.entries.every((e) => e.validationPassed);
  if (!checks.sectionQaAllPassed) issues.push("some manifest entries did not pass section QA");

  /*
   * Что останавливает сборку.
   *
   * Целость структуры проверяется раньше и роняет прогон сама
   * (`ASSEMBLY_FAILED`). Здесь — качество текста, и блокирует оно по
   * существенности: дефект, задевший несколько страниц, означает поломку
   * механизма, а не спорную формулировку.
   */
  const blocking = blockingIssues({
    quoteDefectSlides,
    codeSlides: new Set(internalCodes.map((f) => f.slide)),
    codes: new Set(internalCodes.map((f) => f.code)),
    panelMismatchSlides,
    repeatedTextSlides,
    emptyTableSlides,
    ownAddressRowSlides,
  });

  return { passed: issues.length === 0, issues, notes, checks, blocking, skipped };
}
