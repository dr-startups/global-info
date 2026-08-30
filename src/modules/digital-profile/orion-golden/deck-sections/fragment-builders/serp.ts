/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideContentContract } from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import {
  DECK_TEMPLATE_REGISTRY,
  OTHER_SUBJECT_LABEL,
  RED_MARKER_LABEL,
  SIDEBAR_HIGHLIGHT_SLOTS,
  UNVERIFIED_LABEL,
} from "../template-registry";
import type { ScopedFragmentInput } from "../scoped-input";
import { clientNamedSearchEngine, evidenceMaterialKey } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import { linkReadingThemesIntro } from "../../analytics/link-reading-agent";
import { clientSafeDomains } from "../../../services/composite-serp-merge";
import { NOT_FOUND_PATTERNS } from "../../analytics/surface-analyzers";
import { resolveSourceType } from "../../analytics/source-type";
import { getClientTextFieldBudgets } from "../../client/load-client-text-contract";
import type { FragmentBuildOutput, FragmentExtras, PrintedPageRow } from "./shared";
import {
  RISK_ORDER,
  adverseVisualSidebar,
  clientLink,
  VISUAL_ASSET_UNAVAILABLE,
  assetsFor,
  buildPageEvidenceView,
  chunk,
  claimText,
  clampClientText,
  compactRanges,
  coverageContent,
  distribute,
  domainOfUrl,
  emptyStatusForReason,
  evidenceRowWasRead,
  evidenceRowsAdverse,
  evidenceRowsAreOtherSubject,
  fitClientSentences,
  makeSlotSlide,
  packBulletPages,
  pageFindingBlocks,
  pageSourceLine,
  sourceLine,
  normalizeSerpQuery,
  sameSerpQuery,
  serpQueryDisplayForm,
  splitClientParagraphs,
  subjectQueries,
  subjectQueriesLine,
  enumerateRu,
  statusLine,
  uniqueRefs,
  visualSlide,
  withContinuations,
} from "./shared";
import { continuationTitle } from "../continuation-slide";

/** Сколько строк выдачи показывает таблица: глубина аудита, не больше. */
export const SERP_TABLE_TOP_N = 20;

/**
 * Колонки таблицы выдачи.
 *
 * Адреса среди них нет: он печатается полосой во всю ширину листа под своей
 * строкой результата (`rowAddresses`). Колонкой он быть не может — в её 22 %
 * ширины входят 62 знака, а половина адресов корпуса длиннее, и проверяющий
 * получал ссылку, которая не открывается. Тип источника отвечает на вопрос,
 * ради которого читатель и открывает адрес: запись в санкционном реестре,
 * статья в СМИ и пост в блоге требуют разной реакции, а в таблице выглядят
 * одинаково.
 */
export const SERP_TABLE_HEADERS = ["№", "Заголовок", "Тип источника", "Оценка"];

/**
 * Предел заголовка строки — по ширине его колонки (0.59 листа).
 *
 * 95 знаков — столько влезает в две нарисованные строки при 9 pt, и это же
 * половина худшей законной пары, из которой выведена ёмкость листа
 * (`template-registry.ts`, `serp-table`). Рез стоит здесь, а не в рендерере:
 * `_clip_words(text, 200)` резал молча и невидимо для текстового эталона, а
 * подрезанный заголовок — это то, что читает клиент.
 */
const SERP_TITLE_MAX_CHARS = 95;

/** Заголовок строки: рез по границе слова, с многоточием. */
function serpRowTitle(raw: string): string {
  const text = raw.trim();
  if (text.length <= SERP_TITLE_MAX_CHARS) return text;
  const slice = text.slice(0, SERP_TITLE_MAX_CHARS - 1);
  const boundary = slice.lastIndexOf(" ");
  const kept = (boundary > 0 ? slice.slice(0, boundary) : slice).replace(/[\s.,;:—–-]+$/u, "");
  return `${kept}…`;
}

/*
 * Значения колонки «Оценка» живут в реестре шаблонов — рядом с легендой,
 * которая их обещает. Реэкспорт оставлен ради тех, кто и так брал их отсюда.
 */
export { OTHER_SUBJECT_LABEL };

/**
 * Номер колонки с оценкой — считается из заголовков, а не пишется числом.
 *
 * Когда в таблицу добавили «Тип источника», счётчики страницы остались смотреть
 * в четвёртую колонку и считали типы источников вместо оценок: на прогоне 14.08
 * `adverseDisplayed` был нулём на всех страницах выдачи.
 */
const RATING_COLUMN = SERP_TABLE_HEADERS.indexOf("Оценка");

/*
 * Адрес для клиента печатают и таблица выдачи, и фраза «Почему выделено»,
 * поэтому сам печатник переехал к общим помощникам. Реэкспорт оставлен ради
 * тех, кто и так брал его отсюда: печатник один, дверей к нему две.
 */
export { clientLink };

const SERP_ENGINE_LABELS: Record<string, string> = { YANDEX: "Яндекс", GOOGLE: "Google" };
/** «Выдача Яндекса», но «выдача Google»: русское имя склоняется, латинское нет. */
const SERP_ENGINE_LABELS_GENITIVE: Record<string, string> = { YANDEX: "Яндекса", GOOGLE: "Google" };
const SERP_ENGINE_ORDER = ["YANDEX", "GOOGLE"];

/** Поисковик так, как его называет клиентский текст: «Google», «Яндекс». */
export function serpEngineLabel(raw: string | undefined): string | null {
  const engine = normalizeSerpEngine(raw);
  return engine ? SERP_ENGINE_LABELS[engine] ?? engine : null;
}

/** Поисковик в родительном падеже: «выдача Яндекса», «выдача Google». */
export function serpEngineLabelGenitive(raw: string | undefined): string | null {
  const engine = normalizeSerpEngine(raw);
  return engine ? SERP_ENGINE_LABELS_GENITIVE[engine] ?? engine : null;
}

/** Ярлык поисковика в том виде, в котором его можно показать клиенту. */
export function normalizeSerpEngine(raw: string | undefined): string | null {
  return clientNamedSearchEngine(raw);
}

/**
 * Запрос, выдачу по которому показывает таблица поисковика.
 *
 * Таблица — это одна страница выдачи, а не сводка по всем запросам сразу.
 * Смешав запросы, мы получили бы две строки с позицией 1 и номер, который
 * ничего не значит. Поэтому на каждый поисковик берётся один запрос: сначала
 * тот, что искал субъекта по имени, при равенстве — давший больше материала,
 * а на совсем равных — первый по алфавиту, чтобы отчёт был воспроизводим.
 */
export function pickSerpTableQuery(
  rows: Array<{ query?: string; queryPurpose?: string }>
): string | null {
  // Написания одного запроса складываются в один счёт: регистр запроса не
  // меняет, и разведённые по регистру половины делали выбор случайным.
  const stats = new Map<string, { count: number; subject: boolean; spellings: string[] }>();
  for (const r of rows) {
    const q = String(r.query ?? "").trim();
    if (!q) continue;
    const key = normalizeSerpQuery(q);
    const stat = stats.get(key) ?? { count: 0, subject: false, spellings: [] };
    stat.count += 1;
    stat.spellings.push(q);
    if (String(r.queryPurpose ?? "") === "subject_lookup") stat.subject = true;
    stats.set(key, stat);
  }
  if (stats.size === 0) return null;
  const best = [...stats.entries()].sort((a, b) => {
    if (a[1].subject !== b[1].subject) return a[1].subject ? -1 : 1;
    if (a[1].count !== b[1].count) return b[1].count - a[1].count;
    return a[0].localeCompare(b[0], "ru");
  })[0]!;
  return serpQueryDisplayForm(best[1].spellings);
}

/**
 * Чья это нумерация — своя для этого поисковика или чужая.
 *
 * Список Яндекса собирается из выдачи Яндекса, список Google — из Serper.
 * Обогатитель (Arsenkin) в списках не участвует: обогащать в перечне выдачи
 * нечего, а его собственная нумерация — без спецблоков — дырявит таблицу
 * чужими местами. В отчёте 76 таблица «ОАЭ — Google» показала девятнадцать
 * строк, из которых двенадцать несли его нумерацию.
 *
 * Тем же правилом ворота сборки сверяют напечатанное с наблюдениями: два
 * ответа на вопрос «чей это ранг» разошлись бы в первую же неделю.
 */
export function rankSourceBelongsToEngine(
  rankSource: string | undefined,
  engine: string
): boolean {
  const own = ENGINE_RANK_SOURCE[engine];
  if (!rankSource || rankSource === "unknown") return false;
  return own ? own.test(rankSource) : true;
}

const ENGINE_RANK_SOURCE: Record<string, RegExp> = {
  YANDEX: /yandex/i,
  GOOGLE: /serper|google/i,
};

/**
 * Номера, которых в собранной двадцатке нет, — компактным перечнем: «1–3, 5».
 *
 * Пустая строка означает полную таблицу: подпись о потерях появляется только
 * там, где потери есть.
 */
export function missingSerpRanks(printed: readonly number[], topN = SERP_TABLE_TOP_N): string {
  const present = new Set(printed);
  const missing: number[] = [];
  for (let rank = 1; rank <= topN; rank += 1) if (!present.has(rank)) missing.push(rank);
  return compactRanges(missing);
}

/**
 * Заголовок страницы выдачи: чей это поисковик и какую глубину он показывает.
 *
 * Глубина называется **одним** утверждением. «Россия — Google, ТОП-20: позиции 1–8»
 * спорило само с собой: ТОП-20 обещал двадцать строк, а таблица показывала
 * восемь, и недостающие читались как пустые места выдачи, то есть как факт о
 * субъекте. Знаменатель при этом нужен: «позиции 1–8» без него неотличимы от
 * полной выдачи из восьми строк. Почему остального нет, объясняет строка под
 * таблицей (`serpTablePageProse`), а не заголовок.
 *
 * Печатается вычисленный диапазон, а не количество строк: на наборе
 * {4, 6, 7, 8, 9, 10} «собрано 6» и «позиции 4–10» — разные факты.
 *
 * **Вход один — напечатанные позиции.** Пропущенные номера функция считает
 * сама, а «есть ли у строк позиции» выводит из непустого списка. Пока полей
 * было три, рассогласованный кадр печатал «Россия — Google, ТОП-20» над
 * таблицей из трёх строк, а вырожденный (`positional: true` при пустом списке)
 * — «позиции Infinity–-Infinity из ТОП-20»: `Math.min` пустого набора. На живом
 * вызове оба снятых поля выводились из тех же `printedRanks`, поэтому ни одна
 * собранная дека от этого не меняется — снимается возможность, а не поведение.
 *
 * Формулировка живёт здесь и больше нигде, и эталоны её не исполняют: у
 * золотого кейса таблицы полные, у `report-72` — непозиционные. Сторожей два, и
 * они разные: `serp-table-title-names-the-range-once.test.ts` держит саму
 * функцию, а `serp-table-caption-tells-collected-range.test.ts` — проводку
 * «построитель → функция» через `buildSerpFragment`. У веток без метки движка
 * второго нет: до них не доходит его фикстура — она зашивает Google и Яндекс, —
 * и правку в них покраснит только первый файл. Сама ветка при этом живая:
 * `clientNamedSearchEngine` отдаёт `null` любому движку, кроме этих двух, и
 * прогон, например, на Bing печатает клиенту «Россия — выдача, позиции 1–8 из
 * ТОП-20».
 */
export function serpTablePageTitle(input: {
  /** Название региона с заглавной: заголовок начинается им же. */
  region: string;
  /** Поисковик, если его можно назвать клиенту. */
  engineLabel: string | null;
  /**
   * Напечатанные позиции всей таблицы, а не одного её листа.
   *
   * Пустой список — выдача без единой своей позиции: номера строк там порядок
   * сбора, а не места.
   */
  printedRanks: readonly number[];
  /** Номер листа цепочки вида « (1/2)» или пустая строка. */
  suffix: string;
}): string {
  const { region, engineLabel, printedRanks, suffix } = input;
  /*
   * «Движок назван?» — один вопрос, и ответ на него ниже один.
   *
   * Пока подстановка слова «выдача» читала метку на nullish, а хвост
   * непозиционной таблицы — на истинность, пустая строка расходилась между
   * ними и печаталась «Россия — , позиции 1–8 из ТОП-20». Пустая метка — это
   * «движок не назван», ровно как `null`.
   *
   * На месте неназванного движка стоит слово «выдача», и второй раз оно не
   * печатается: «Россия — выдача: собранная выдача» — повтор, а не уточнение.
   */
  const engine = engineLabel || null;
  const unrankedTail = engine ? ": собранная выдача" : "";
  // Пропущенные номера спрашиваются там же, где читаются: отдельная
  // переменная под них означала бы, что «собраны ли позиции» решается дважды —
  // при её вычислении и при выборе ветки.
  const depth =
    printedRanks.length === 0
      ? unrankedTail
      : missingSerpRanks(printedRanks)
        ? `, позиции ${Math.min(...printedRanks)}–${Math.max(...printedRanks)} из ТОП-${SERP_TABLE_TOP_N}`
        : `, ТОП-${SERP_TABLE_TOP_N}`;
  return `${region} — ${engine ?? "выдача"}${depth}${suffix}`;
}

/**
 * Проза страницы выдачи, разложенная по важности печати.
 *
 * Порядок здесь — не оформление, а выбор того, что читатель увидит первым.
 * Перед выводом страницы стоит только то, без чего таблица читается неверно:
 * по какому запросу собрана выдача (иначе номер строки — число без
 * знаменателя, а выделение на снимке соседней страницы выглядит
 * противоречием) и почему в нумерации дыры. Всё остальное — после вывода:
 * тематическая строка это заключение, а перечень запросов — справка.
 *
 * Справка не печатается, когда ничего не добавляет: при единственном запросе
 * прогона она дословно повторяет заголовок выдачи («Показана выдача Google по
 * запросу «X». Выдача проверена по 1 запросу: «X».») и вытесняет с листа
 * вывод.
 */
export function serpTablePageProse(input: {
  /** Название поисковика в родительном падеже: «Яндекса», «Google». */
  engineLabel: string | null;
  query: string | null;
  /** Перечень несобранных номеров; пусто — таблица полная. */
  missing: string;
  /** Справка о наборе запросов прогона и сам набор, по которому она решается. */
  queriesLine?: string;
  subjectQueries?: string[];
}): { head: string; tail?: string } {
  const parts: string[] = [];
  if (input.query) {
    const engine = input.engineLabel ? `выдача ${input.engineLabel}` : "выдача";
    parts.push(`Показана ${engine} по запросу «${input.query}».`);
  }
  if (input.missing) {
    parts.push(
      `Позиции ${input.missing} в собранных данных отсутствуют: эти строки потеряны при сборе, а не пусты в выдаче.`
    );
  }
  const queries = input.subjectQueries ?? [];
  const repeatsTableQuery = queries.length === 1 && sameSerpQuery(queries[0], input.query);
  const tail = input.queriesLine && !repeatsTableQuery ? input.queriesLine : undefined;
  // Заголовка выдачи нет вовсе (набор без запросов) — тогда справка и есть всё,
  // что о запросах известно, и она встаёт первой строкой, как стояла раньше.
  if (!input.query && tail) return { head: tail };
  return { head: parts.join(" "), ...(tail ? { tail } : {}) };
}

/**
 * Одна позиция — один материал.
 *
 * В выдаче не бывает двух третьих строк. В живом отчёте они появились: материал,
 * найденный несколькими запросами, получал подпись одного запроса и номер из
 * другого, и страница показывала две первых позиции и четыре вторых. Позиция
 * теперь считается внутри выбранного запроса, а это — последняя защита на
 * случай данных, где запрос не записан.
 */
export function dropDuplicateRanks<T extends { rank: number }>(rows: T[]): T[] {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (seen.has(row.rank)) return false;
    seen.add(row.rank);
    return true;
  });
}

/** Наблюдения одного материала — в одну строку, в порядке первого появления. */
export function mergeSerpRowsByMaterial(
  refs: string[],
  scoped: ScopedFragmentInput
): Array<{ key: string; refs: string[] }> {
  const order: string[] = [];
  const byKey = new Map<string, string[]>();
  for (const ref of refs) {
    // Ключ материала слоя деки, а не собственный вызов: строка, за которой нет
    // ни адреса, ни домена, сводиться ни с кем не должна — иначе две таких
    // строки склеиваются в одну и вторая теряет свою позицию и свой заголовок.
    const key = evidenceMaterialKey(scoped.evidenceIndex[ref], ref);
    const list = byKey.get(key);
    if (list) {
      list.push(ref);
      continue;
    }
    byKey.set(key, [ref]);
    order.push(key);
  }
  return order.map((key) => ({ key, refs: byKey.get(key)! }));
}

export function buildSerpFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const [slot] = slotsForFragment(key);
  const organic = scoped.surfaceUnits.filter((u) => u.surface === "organic");
  // NO_RESULTS / «не найден» markers are not real SERP rows — treat as empty
  // so GPT cannot later paint global findings over a phantom table.
  const refs = organic
    .flatMap((u) => u.evidenceRefs)
    .filter((ref) => {
      const e = scoped.evidenceIndex[ref];
      if (!e) return true;
      return !NOT_FOUND_PATTERNS.test(`${e.title ?? ""} ${e.domain ?? ""}`);
    });
  if (refs.length === 0) {
    return {
      slides: [
        makeSlotSlide({
          slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: coverageContent(
            "no-organic-data",
            emptyStatusForReason(scoped, "no-organic-data")
          ),
          evidenceRefs: [],
          findingIds: [],
          emptyStateReason: "no-organic-data",
        }),
      ],
      status: "READY",
    };
  }
  // Шаг 13, D7 — одна и та же страница, найденная несколькими запросами,
  // печаталась как несколько разных «позиций» (ru.wikipedia.org на 1 и 19,
  // instagram.com на 2, 21 и 28), а у одного ролика соседние строки несли
  // противоположные оценки. Материал в таблице один; оценка у него —
  // сильнейшая из всех наблюдений этого материала.
  const merged = mergeSerpRowsByMaterial(refs, scoped);
  /*
   * Набор данных называет источник позиции — свойство набора, а не строки.
   *
   * Построчное «источник не назван — значит, свой» было той лазейкой, через
   * которую в таблицу ОАЭ прогона 76 вошла нумерация обогатителя: признак не
   * доезжал до деки вовсе, и защита пропускала весь набор целиком. Наборы, где
   * источника нет ни у одной строки, собраны до появления признака — они
   * работают как раньше; в смешанном наборе безымянная позиция не печатается.
   */
  const datasetNamesRankSource = refs.some((ref) => {
    const src = scoped.evidenceIndex[ref]?.rankSource;
    return Boolean(src) && src !== "unknown";
  });
  const rankFromOwnEngine = (ref: string, engine: string): boolean => {
    if (!datasetNamesRankSource) return true;
    return rankSourceBelongsToEngine(scoped.evidenceIndex[ref]?.rankSource, engine);
  };
  /**
   * Все запросы, которыми найден материал, а не первый попавшийся.
   *
   * Материал в выдаче виден по нескольким запросам сразу: «suleyman kerimov»,
   * «kerimov suleyman» и «Suleyman Abusaidovich Kerimov» приводят к одной и той
   * же странице. Сведение по материалу оставляло за ним запрос того наблюдения,
   * что оказалось первым, и таблица ТОП-20 показывала семь строк из двадцати.
   * Написания одного запроса считаются одним запросом: регистр — свойство
   * написания, а не запроса.
   */
  const queriesOfRefs = (
    groupRefs: string[]
  ): Array<{ query: string; queryPurpose?: string }> => {
    const out = new Map<string, { query: string; queryPurpose?: string }>();
    for (const ref of groupRefs) {
      const e = scoped.evidenceIndex[ref];
      const q = String(e?.query ?? "").trim();
      if (!q) continue;
      const key = normalizeSerpQuery(q);
      if (!out.has(key)) out.set(key, { query: q, queryPurpose: e?.queryPurpose });
    }
    return [...out.values()];
  };
  /**
   * Входит ли материал в выдачу по выбранному запросу.
   *
   * Наблюдения без записанного запроса относим к любому: у старых наборов
   * данных запроса нет вовсе, и отбрасывать их значит потерять таблицу целиком.
   */
  const groupInQuery = (groupRefs: string[], query: string | null): boolean => {
    if (!query) return true;
    const queries = queriesOfRefs(groupRefs);
    return queries.length === 0 || queries.some((q) => sameSerpQuery(q.query, query));
  };
  /**
   * Позиция материала в выдаче по конкретному запросу и в этом поисковике.
   *
   * Считать её «лучшей по всем наблюдениям» нельзя: материал, найденный
   * несколькими запросами, получал подпись одного запроса и номер из другого —
   * и в таблице появлялись две первых позиции и четыре вторых. В выдаче по
   * одному запросу позиция уникальна, и таблица обязана это сохранять.
   */
  const rankInQuery = (groupRefs: string[], query: string | null, engine: string): number => {
    const rankOf = (ref: string): number | undefined => {
      if (!rankFromOwnEngine(ref, engine)) return undefined;
      const r = scoped.evidenceIndex[ref]?.rank;
      return typeof r === "number" && r > 0 ? r : undefined;
    };
    const best = (candidates: string[]): number => {
      const ranks = candidates.map(rankOf).filter((r): r is number => r !== undefined);
      return ranks.length > 0 ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
    };
    // Запроса нет ни у одного наблюдения таблицы — набор собран до того, как
    // запрос стал сохраняться; тогда позиция это всё, что о материале есть.
    if (!query) return best(groupRefs);
    /*
     * Позиция берётся у наблюдения по этому самому запросу.
     *
     * Раньше к выбранному запросу относили и наблюдения без записанного запроса
     * — ради старых наборов данных. На прогоне 14.08 это дало таблице чужие
     * места: страница Википедии стояла второй по запросу таблицы, но у неё было
     * наблюдение без запроса с позицией 1, и в отчёте она встала первой. В
     * прогоне 76 тем же путём печатался «7 lenta.ru» — ранг безымянной строки
     * агентского сборщика, а настоящая седьмая позиция запроса выбрасывалась
     * как дубль.
     */
    const exact = groupRefs.filter((ref) =>
      sameSerpQuery(scoped.evidenceIndex[ref]?.query, query)
    );
    return exact.length > 0 ? best(exact) : Number.MAX_SAFE_INTEGER;
  };

  // Одна таблица — один поисковик и один запрос: это страница выдачи, которую
  // видит человек. Сводка по всем запросам сразу давала номера, за которыми
  // не стоит ничего: две первых позиции в одном столбце и «36-я строка» там,
  // где аудит обещает ТОП-20.
  //
  // Материалы, у которых поисковик не записан (прогоны до того, как источник
  // стал сохраняться), собираются в таблицу без имени движка. Выбросить их
  // значило бы отдать клиенту пустую страницу там, где выдача есть.
  //
  // Раскладывается по движкам не группа целиком, а её наблюдения: страница,
  // найденная обоими поисковиками, стоит в обеих таблицах со своими номерами.
  // Пока группа уезжала к движку первого наблюдения, второй поисковик получал
  // на её месте дыру.
  const byEngine = new Map<string, Array<{ refs: string[]; engineRefs: string[] }>>();
  for (const group of merged) {
    const refsByEngine = new Map<string, string[]>();
    for (const ref of group.refs) {
      const engine = normalizeSerpEngine(scoped.evidenceIndex[ref]?.engine) ?? "";
      const list = refsByEngine.get(engine) ?? [];
      list.push(ref);
      refsByEngine.set(engine, list);
    }
    for (const [engine, engineRefs] of refsByEngine) {
      const list = byEngine.get(engine) ?? [];
      list.push({ refs: group.refs, engineRefs });
      byEngine.set(engine, list);
    }
  }
  const engineTables = [...byEngine.entries()]
    .sort(
      (a, b) =>
        (SERP_ENGINE_ORDER.indexOf(a[0]) + 1 || 99) - (SERP_ENGINE_ORDER.indexOf(b[0]) + 1 || 99)
    )
    .map(([engine, groups]) => {
      // Запрос выбирается по числу материалов, которые он показал, поэтому в
      // счёт идёт каждая пара «материал — запрос», а не один запрос на материал.
      const query = pickSerpTableQuery(groups.flatMap((g) => queriesOfRefs(g.engineRefs)));
      const scopedGroups = groups.filter((g) => groupInQuery(g.engineRefs, query));
      const ranked = dropDuplicateRanks(
        scopedGroups
          .map((group, index) => ({
            group,
            index,
            rank: rankInQuery(group.engineRefs, query, engine),
          }))
          .filter((x) => x.rank <= SERP_TABLE_TOP_N)
          .sort((a, b) => a.rank - b.rank || a.index - b.index)
      ).slice(0, SERP_TABLE_TOP_N);
      if (ranked.length > 0) return { engine, query, displayed: ranked, positional: true };
      // Прогоны, собранные до того, как позиция стала сохраняться, позиций не
      // несут вовсе. Показать такую выдачу можно, назвать её ТОП-20 — нет:
      // строки нумеруются порядком сбора, и заголовок это признаёт.
      const unranked = scopedGroups
        .map((group, index) => ({ group, index, rank: index + 1 }))
        .slice(0, SERP_TABLE_TOP_N);
      return { engine, query, displayed: unranked, positional: false };
    })
    .filter((t) => t.displayed.length > 0);

  // Материалы без поисковика показываются только когда показывать больше
  // нечего. Рядом с названными таблицами такая страница ничего не сообщает:
  // ни где стоял материал, ни в каком поисковике его видно.
  const namedTables = engineTables.filter((t) => t.engine);
  const tables = namedTables.length > 0 ? namedTables : engineTables;

  /** Строка результата и её адрес: адрес печатается полосой, а не ячейкой. */
  const rowOf = (
    group: { refs: string[] },
    rank: number
  ): { cells: string[]; address: string } => {
    const e = scoped.evidenceIndex[group.refs[0]!] ?? {};
    /*
     * Оценка — собственный сигнал материала, и считает его общий предикат.
     *
     * Раньше строка красилась ещё и по принадлежности к негативной находке —
     * независимо от того, что показала прочитанная страница. В отчёте 72 семь
     * строк первой таблицы из двенадцати оказались «Нежелательными», и это
     * биографии; на прогоне Кремлёва так покраснел klerk.ru, чью страницу
     * прочитали и признали благоприятной с двумя цитатами. Тема — это
     * классификация находки, а не оценка материала.
     *
     * Решение у материала одно, поэтому и берётся оно один раз: наблюдения
     * различаются запросом, а страницу читали не по запросу. Словарь при этом
     * смотрит каждое наблюдение — сниппеты у них разные, и сигнал в любом из
     * них принадлежит материалу.
     */
    const adverse = evidenceRowsAdverse(scoped, group.refs);
    /*
     * «Нейтральный» — это результат проверки, а не её отсутствие.
     *
     * Признак берётся из данных: есть тон прочитанной страницы — страницу
     * открыли и оценили. Отказ чтения тона не оставляет, и такая строка
     * называется «Не проверено» вместе с той, которую не запрашивали вовсе.
     */
    const verified = group.refs.some((ref) => evidenceRowWasRead(scoped.evidenceIndex[ref]));
    const likely = group.refs.some(
      (ref) => scoped.evidenceIndex[ref]?.subjectDecision === "LIKELY_SUBJECT"
    );
    /*
     * Материал о другом лице занимает своё место в выдаче и называется прямо.
     *
     * Аудит обещает ТОП-20 и обязан показать двадцать строк: строка, вычеркнутая
     * из таблицы, оставляет дыру в нумерации, и читатель считает её потерей
     * данных. Однофамилец при этом не должен выглядеть материалом о субъекте —
     * поэтому у него своя оценка, а не «Нейтральный».
     */
    const other = evidenceRowsAreOtherSubject(scoped, group.refs);
    // Red marker must always carry its label; domain comes from evidence URL.
    // LIKELY (§2.1) → «Вероятно» — visible but not confirmed-subject KPI.
    //
    // Непрочтение стоит ниже «Вероятно»: неопределённость принадлежности —
    // более сильная оговорка, чем неоткрытая страница. И ниже «Нежелательного»:
    // непрочитанная строка с негативным сигналом остаётся негативной, глушить
    // сигнал из-за того, что страницу не открыли, — потеря.
    const rating = other
      ? OTHER_SUBJECT_LABEL
      : adverse
        ? RED_MARKER_LABEL
        : likely
          ? "Вероятно"
          : verified
            ? "Нейтральный"
            : UNVERIFIED_LABEL;
    // Номер строки — настоящая позиция в выдаче, а не счётчик строк таблицы.
    // Счётчик выдавал «24-е место в Яндексе» там, где материал стоял третьим
    // по другому запросу.
    return {
      cells: [
        String(rank),
        serpRowTitle(e.title ?? "(без заголовка)"),
        resolveSourceType({ fromVerdict: e.sourceType, domain: e.domain ?? domainOfUrl(e.url) }) ?? "—",
        rating,
      ],
      address: clientLink(e.url, e.domain),
    };
  };
  // §7.1: each continuation page gets its own row-scoped sidebar (not a blank
  // strip of the first page's finding blocks).
  // Ёмкость листа объявлена реестром, и второго числа здесь нет: прежние
  // запасные «12» пережили вывод ёмкости и стали бы тихим вторым ответом.
  // Ноль в реестре значит «не разбивать» — тот же смысл, что у общего
  // пагинатора `withContinuations`.
  const maxRows = DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide;
  const cut = <T,>(list: T[]): T[][] => (maxRows > 0 ? chunk(list, maxRows) : [list]);
  const queriesLine = subjectQueriesLine(scoped);
  const queryList = subjectQueries(scoped);
  // Страницы не смешивают поисковики: каждая таблица листается отдельно и
  // подписана своим поисковиком и запросом.
  const pages: Array<{
    title: string;
    rows: string[][];
    /** Адрес каждой строки этой страницы — полосой под ней. */
    addresses: string[];
    /**
     * Напечатанные строки листа со своими номерами.
     *
     * Ссылки страницы берутся отсюда же: плоский список нужен виду страницы, а
     * номер строки — теме, которая на этом листе называет свою опору.
     */
    printedRows: PrintedPageRow[];
    /** Первые предложения страницы: чья это выдача и чего в ней не хватает. */
    lead: string;
    /** Справка после вывода страницы; печатается не всегда. */
    note?: string;
    engine: string;
    query: string | null;
    /**
     * Номера строк — позиции выдачи, а не порядок сбора.
     *
     * У движка без единой своей позиции таблица честно вырождается в
     * «собранную выдачу», и ворота сверки печати с наблюдениями обязаны
     * отличать её от позиционной: прочитанные как позиции, порядковые номера
     * дали бы «позиция N не подтверждена» на каждой строке здорового прогона.
     */
    positional: boolean;
  }> = [];
  for (const table of tables) {
    const label = serpEngineLabel(table.engine);
    const printed = table.displayed.map((x) => rowOf(x.group, x.rank));
    // Строки, адреса и ссылки режутся одним разрезом: соответствие «строка →
    // адрес» держится индексом, и разъехавшиеся куски остановили бы сборку.
    const rowChunks = cut(printed.map((p) => p.cells));
    const addressChunks = cut(printed.map((p) => p.address));
    const printedRowChunks = cut(
      table.displayed.map((x) => ({ rank: x.rank, refs: x.group.refs }))
    );
    const printedRanks = table.positional ? table.displayed.map((x) => x.rank) : [];
    const missing = table.positional ? missingSerpRanks(printedRanks) : "";
    const prose = serpTablePageProse({
      engineLabel: serpEngineLabelGenitive(table.engine),
      query: table.query,
      missing,
      queriesLine,
      subjectQueries: queryList,
    });
    for (let i = 0; i < rowChunks.length; i += 1) {
      const suffix = rowChunks.length > 1 ? ` (${i + 1}/${rowChunks.length})` : "";
      // Заголовок начинается с региона, и он же начинает предложение: «ОАЭ»
      // приходит меткой раздела, а «международный» — строчным.
      const region = regionLabel.charAt(0).toUpperCase() + regionLabel.slice(1);
      pages.push({
        title: serpTablePageTitle({ region, engineLabel: label, printedRanks, suffix }),
        rows: rowChunks[i] ?? [],
        addresses: addressChunks[i] ?? [],
        printedRows: printedRowChunks[i] ?? [],
        lead: prose.head,
        ...(prose.tail ? { note: prose.tail } : {}),
        engine: table.engine,
        query: table.query,
        positional: table.positional,
      });
    }
  }
  /*
   * Страница тем: о чём именно нежелательные публикации.
   *
   * Эталон отрасли ставит её сразу после списка ссылок и печатает рядом с
   * каждой темой число публикаций. Числа сходятся с метрикой выше — это и
   * делает таблицу проверяемой, а не декоративной.
   *
   * Темы приходят из чтения страниц. Если чтение выключено, страницы нет:
   * рубрики из справочника показывать под таким заголовком нельзя, они не
   * отвечают на вопрос «о чём публикация».
   */
  /*
   * Темы берутся по своему контуру.
   *
   * Свод по всему прогону стоял и на российской странице, и на странице ОАЭ —
   * одинаковый. Российский раздел отвечал на вопрос «о чём публикации в ТОП-20
   * России» числами, в которых половина материала из международной выдачи.
   * Общего свода нет только у старых прогонов — тогда берём его как раньше.
   */
  const regionKey = key.startsWith("RU_") ? "RU" : "UAE";
  const byRegion = scoped.metricSnapshot.linkThemesByRegion?.[regionKey];
  const linkThemes = (byRegion ?? scoped.metricSnapshot.linkThemes ?? []).filter(
    (t) => t.count > 0
  );
  const themesPage =
    linkThemes.length > 0
      ? {
          title: `${regionLabel.charAt(0).toUpperCase()}${regionLabel.slice(1)} — о чём публикации в ТОП-${SERP_TABLE_TOP_N}`,
          rows: linkThemes
            .slice(0, 12)
            .map((t) => [t.theme, String(t.count), String(t.adverseCount)]),
          unread: scoped.metricSnapshot.linkUnreadCount ?? 0,
        }
      : null;

  const slides: SlideContentContract[] = [];
  const baseSlideId = slot.slotId;
  for (let i = 0; i < pages.length; i += 1) {
    const printedRows = pages[i]!.printedRows;
    const pageRefs = printedRows.flatMap((r) => r.refs);
    const pageRows = pages[i]!.rows;
    // Единица этого листа — строка с номером, и тема на нём называет свою опору
    // номерами строк: домены печатают полосы адресов, а перечень в абзаце с
    // ними спорил.
    const view = buildPageEvidenceView(scoped, pageRefs, printedRows);
    // Renderer `orion_golden_search_table` paints only `narrative` above the
    // table (not whatWasFound/bullets when rows exist) — put the §7.1 sidebar
    // conclusion there so the page composition is visible in PDF/PPTX.
    //
    // Домены абзац не называет, и это единственное место, где так: полосы
    // адресов под строками печатают их целиком и все, а перечень в абзаце
    // режется тремя элементами — страница противоречила бы своему же листу.
    const pageBlocks = pageFindingBlocks(scoped, view, { namePageDomains: false });
    const slide = makeSlotSlide({
      slot,
      sectionId,
      title: pages[i]!.title,
      content: {
        table: {
          headers: [...SERP_TABLE_HEADERS],
          rows: pageRows,
          rowAddresses: pages[i]!.addresses,
        },
        ...pageBlocks,
        // Клиент должен видеть, чью выдачу смотрит: без запроса позиция в
        // таблице — число без знаменателя, а противоречие со снимком соседней
        // страницы необъяснимо (см. `docs/etalon-orion-razbor.md`).
        narrative: [pages[i]!.lead, pageBlocks.whatWasFound, pages[i]!.note]
          .filter(Boolean)
          .join(" "),
      },
      evidenceRefs: pageRefs,
      findingIds: view.findings.map((f) => f.findingId),
      metrics: {
        datasetCount: refs.length,
        uniqueMaterials: merged.length,
        displayedCount: pageRows.length,
        adverseDisplayed: pageRows.filter((r) => r[RATING_COLUMN] === RED_MARKER_LABEL).length,
        likelyDisplayed: pageRows.filter((r) => r[RATING_COLUMN] === "Вероятно").length,
        unverifiedDisplayed: pageRows.filter((r) => r[RATING_COLUMN] === UNVERIFIED_LABEL).length,
        otherSubjectDisplayed: pageRows.filter((r) => r[RATING_COLUMN] === OTHER_SUBJECT_LABEL)
          .length,
        pageIndex: i + 1,
        pageCount: pages.length,
        // Движок и запрос таблицы — печатный факт, а не пересчёт: ворота
        // сверяют напечатанные номера с наблюдениями по этой самой паре.
        ...(pages[i]!.engine ? { serpEngine: pages[i]!.engine } : {}),
        ...(pages[i]!.query ? { serpQuery: pages[i]!.query! } : {}),
        serpPositional: pages[i]!.positional ? 1 : 0,
      },
    });
    if (i === 0) {
      slides.push(slide);
    } else {
      slides.push({
        ...slide,
        slideId: `${baseSlideId}__cont${i}`,
        isContinuation: true,
        continuationOf: baseSlideId,
        continuationIndex: i,
      });
    }
  }
  if (themesPage) {
    const adverseTotal = linkThemes.reduce((n, t) => n + t.adverseCount, 0);
    // Утверждение и оговорка о его неполноте — одно целое: оговорка стоит
    // рядом с утверждением, а не там, где для неё нашлось место. Слова
    // собирает агент чтения: они принадлежат тем же числам, что и его отчёт.
    const reading = scoped.metricSnapshot.linkReading;
    slides.push({
      ...makeSlotSlide({
        slot,
        sectionId,
        title: themesPage.title,
        content: {
          narrative: linkReadingThemesIntro({
            report: reading,
            adverseTotal,
            topN: SERP_TABLE_TOP_N,
            unread: themesPage.unread,
          }),
          table: {
            headers: ["Тема", "Публикаций", "Из них нежелательных"],
            rows: themesPage.rows,
          },
        },
        evidenceRefs: [],
        findingIds: [],
        // Машинное зеркало фразы: база и прочитанное существуют числами, а не
        // только словами в предложении.
        metrics: {
          themes: linkThemes.length,
          adverseTotal,
          unread: themesPage.unread,
          ...(reading ? { read: reading.read, requested: reading.requested } : {}),
        },
      }),
      slideId: `${baseSlideId}__themes`,
      isContinuation: true,
      continuationOf: baseSlideId,
      continuationIndex: slides.length,
    });
  }
  return { slides, status: "READY" };
}

export function buildSerpScreenshotFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const [slot] = slotsForFragment(key);
  const screenshots = Object.entries(scoped.evidenceIndex).filter(
    ([, e]) => e.kind === "serp_screenshot"
  );
  // Rows actually rendered on the bound snapshot, with the SAME red-frame
  // marking the snapshot generator produced. Sidebar copy is derived from
  // these rows only — never from region- or bundle-level findings.
  //
  // Разбор один на всю страницу: и строки, и объяснения, и число выделенного
  // берутся из него. Рядом стоял второй перебор `visibleItems`, отвечавший на
  // тот же вопрос своими словами; пока оба ответа совпадали, это было просто
  // лишней работой, но любая правка одного из них разводила подпись с текстом.
  const sidebar = adverseVisualSidebar(slot.slotId, extras, scoped);
  const visibleRows = sidebar.visibleRows;
  const boundAssetRefs = assetsFor(extras, slot.slotId);
  // Fail-closed: no bound visual → never invent «на этом снимке / деловые материалы».
  if (boundAssetRefs.length === 0 && visibleRows.length === 0) {
    const slide = visualSlide({
      slot,
      sectionId,
      extras,
      scoped,
      content: {
        narrative: `Снимок первой страницы выдачи (${regionLabel}) недоступен в текущем наборе.`,
        whatWasFound:
          "Визуальный снимок выдачи недоступен; текстовые выводы по содержимому снимка не формируются.",
        whyItMatters:
          "Без снимка нельзя подтвердить, что именно видит пользователь на первой странице в этом регионе.",
        whatToCheck:
          "Повторить сбор скриншота выдачи или сверить органическую таблицу результатов на соседних страницах.",
        sourceNote: "Источник: снимок поисковой выдачи недоступен.",
      },
      evidenceRefs: screenshots.map(([ref]) => ref),
      findingIds: [],
      metrics: { screenshots: screenshots.length, adverseHighlights: 0 },
      noUnderlyingData: false,
    });
    return { slides: [slide], status: "READY" };
  }
  // Объяснение на каждую строку в рамке — тем же разбором, что у панелей и
  // сеток изображений: фразу «Почему выделено» пишет один помощник.
  const explanations = sidebar.explanations;
  const explainedFindings = [...sidebar.explainedFindings];
  const explainedDomains = sidebar.explainedDomains;
  const explainedRefs = sidebar.explainedRefs;
  explainedFindings.sort((a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0));
  const top = explainedFindings[0];

  // Engine coverage limitation visible on the snapshot itself (e.g. Google
  // holds the highlighted result while the Yandex panel has no stored rows).
  const engines = new Set(visibleRows.map((v) => (v.engine ?? "").toUpperCase()).filter(Boolean));
  const engineNote = !engines.has("YANDEX")
    ? " Выделенные результаты — в выдаче Google; по Яндексу сохранённых результатов в наборе нет."
    : !engines.has("GOOGLE")
      ? " Выделенные результаты — в выдаче Яндекса; по Google сохранённых результатов в наборе нет."
      : "";

  // Headline: page-specific summary of what is framed on THIS snapshot —
  // details per theme live in the highlight explanations (no duplication).
  const headlineDomains = explainedDomains.slice(0, 4);
  // Ветка и число — из одного списка: у каждой выделенной строки ровно одно
  // объяснение, и «выделено N» обязано считать то же, чем страница объясняет.
  const whatWasFound = explanations.length
    ? clampClientText(
        `На снимке выделено результатов повышенного внимания: ${explanations.length}` +
          (headlineDomains.length
            ? ` (${headlineDomains.join(", ")}${explainedDomains.length > headlineDomains.length ? " и др." : ""})`
            : "") +
          "; остальные результаты — нейтральные или деловые.",
        400
      )
    : visibleRows.length > 0
      ? "Выделенных результатов повышенного внимания на этом снимке нет; зафиксированы деловые и справочные материалы."
      : "На снимке нет сохранённых строк выдачи для описания состава страницы.";

  const neutralVisibleDomains = [
    ...new Set(clientSafeDomains(visibleRows.map((v) => v.domain))),
  ].slice(0, 3);
  // The sidebar footer is narrow: cap the listed domains so the note always
  // ends with a complete phrase instead of clipping mid-sentence.
  // Перечисление через `enumerateRu`: союз перед последним доменом отличает
  // предложение от выгрузки списка (тот же приём, что в pageSourceLine).
  const sourceNote = explainedDomains.length
    ? `Источники на снимке — ${enumerateRu(explainedDomains)}.`
    : neutralVisibleDomains.length
      ? `Видимые на снимке источники — ${enumerateRu(neutralVisibleDomains)}.`
      : "Источник — снимок поисковой выдачи.";

  const slide = visualSlide({
    slot,
    sectionId,
    extras,
    scoped,
    content: {
      narrative: `Состояние первой страницы выдачи (${regionLabel}).${engineNote}`,
      whatWasFound,
      // Coverage limitation is part of "why it matters": it is rendered in the
      // sidebar on adverse pages, unlike the narrative (dropped there).
      whyItMatters: clampClientText(
        (explanations.length
          ? `Выделенные материалы (${explanations.length}) видны при первичной проверке субъекта в этом регионе.`
          : "Первая страница выдачи не формирует негативного фона вокруг субъекта в этом регионе.") +
          engineNote,
        320
      ),
      whatToCheck: clampClientText(
        top?.recommendedAction ?? "Проверить первоисточники выделенных результатов.",
        220
      ),
      statusNote: statusLine(top),
      sourceNote,
      // Every red highlight on the snapshot is explained by the finding whose
      // evidence that row is — strictly page-scoped.
      highlightExplanations: explanations.length ? explanations : undefined,
    },
    evidenceRefs: [
      ...new Set([
        ...screenshots.map(([ref]) => ref),
        ...sidebar.gridRefs,
        ...explainedRefs,
      ]),
    ],
    findingIds: explainedFindings.map((f) => f.findingId),
    metrics: {
      screenshots: screenshots.length,
      adverseHighlights: explanations.length,
    },
    noUnderlyingData: false,
  });

  /*
   * «Под каждым выделенным результатом» выполняется буквально.
   *
   * Боковая панель рисует две фразы по бюджету узкой колонки — это ёмкость
   * рендерера, а не решение построителя. Значит, третья фраза и всё, что из
   * первых двух не поместилось (прежде всего адрес, по которому утверждение
   * проверяют), обязаны уйти на отдельный лист. Полный список фраз при этом
   * остаётся на базовом слайде: проверка «объяснение на каждую находку»
   * считает по нему.
   */
  const needsContinuation =
    sidebar.phrases.length > SIDEBAR_HIGHLIGHT_SLOTS ||
    sidebar.phrases.some((p) => !p.sidebarComplete);
  const slides: SlideContentContract[] = [slide];
  if (explanations.length > 0 && needsContinuation) {
    const budget = getClientTextFieldBudgets().bullet;
    const bullets = sidebar.phrases.map((p) => clampClientText(p.full, budget));
    const cont = DECK_TEMPLATE_REGISTRY["continuation"];
    const pages = packBulletPages(
      bullets,
      cont.maxBulletsPerSlide,
      cont.maxBulletsPerSlide,
      cont.layout.itemCharBudget
    );
    pages.forEach((page, i) => {
      slides.push({
        ...slide,
        slideId: `${slot.slotId}__why${i + 1}`,
        isContinuation: true,
        continuationOf: slot.slotId,
        continuationIndex: i + 1,
        templateId: "continuation",
        title:
          pages.length > 1
            ? continuationTitle(`${slot.title}: почему выделено`, i + 1, pages.length)
            : `${slot.title}: почему выделено`,
        subtitle: undefined,
        // Лист несёт только фразы: вывод, рекомендация и подпись источников
        // принадлежат базовому слайду и повторять их незачем.
        content: { bullets: page },
        visualAssetRefs: [],
        evidenceRefs: explainedRefs,
        findingIds: explainedFindings.map((f) => f.findingId),
        metrics: { adverseHighlights: explanations.length },
      });
    });
  }
  return { slides, status: "READY" };
}
