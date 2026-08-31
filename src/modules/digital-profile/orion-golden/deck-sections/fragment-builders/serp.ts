/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideBody, SlideContentContract } from "../contracts";
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
import { clientAddress } from "../../client/client-address";
import { pluralRu } from "../../../report/i18n/plural-ru";
import {
  freshnessFootnote,
  type MaterialFreshness,
} from "../../../services/report-material-freshness";
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
 * Колонки таблицы выдачи — состав заказан владельцем.
 *
 * Адрес стоит **своей колонкой и печатается целиком**: печатать ссылку и тему
 * заголовка в одной ячейке запрещено прямо. Полосы под строкой больше нет —
 * вместе с колонкой она печатала бы один факт дважды.
 *
 * Прежние пять колонок в отчёте уже были и от них ушли не по вкусу: колонка
 * адреса получала 22 % ширины, туда входило 62 знака, и обрезанная ссылка не
 * открывалась — 17 строк из 50 на эталоне-72 и 60 из 60 в золотом кейсе. Ушли
 * не потому, что колонка плоха, а потому, что её ширину никто не мерил.
 * Теперь мерена: 0.34 листа — 328 px полезных по мере переноса рендерера, и на
 * корпусе адрес ложится в 1…3 строки у 45 строк из 46.
 *
 * Тип источника отвечает на вопрос, ради которого читатель и открывает адрес:
 * запись в санкционном реестре, статья в СМИ и пост в блоге требуют разной
 * реакции, а в таблице выглядят одинаково.
 */
export const SERP_TABLE_HEADERS = ["№", "Ссылка", "Заголовок", "Тип источника", "Оценка"];

/**
 * Колонки второй таблицы выдачи — «Найдено по дополнительным запросам».
 *
 * **Колонки позиции здесь нет вовсе** — ни настоящей, ни порядковой. Порядковый
 * номер в колонке «№» читается как место в выдаче, и это корень всей истории:
 * сводку по трём запросам владелец прочитал как ТОП-20. У второго запроса своя
 * нумерация, сопоставлять её с нумерацией первого нельзя, а показывать номер,
 * который ничего не значит, — значит повторить ту же ошибку под другим именем.
 *
 * Вместо номера — «Найдено по запросу»: единственный вопрос, ради которого
 * строка здесь и стоит.
 */
export const SERP_EXTRA_TABLE_HEADERS = [
  "Ссылка",
  "Заголовок",
  "Найдено по запросу",
  "Тип источника",
  "Оценка",
];

/**
 * Предел ячейки «Найдено по запросу» — по ширине её колонки (0.16 листа, 145 px).
 *
 * 80 знаков ложатся ровно в семь нарисованных строк 9 pt самым широким знаком,
 * а из семистрочной строки и выведена ёмкость листа — то есть запас нулевой, и
 * 85 знаков уже выводят лист за поле на 340 440 EMU.
 *
 * Рез стоит **здесь**, а не подразумевается пределом набора запросов аудита
 * (`MAX_QUERY_CHARS`): тот ограничивает состав аудита, а в деку текст запроса
 * едет другим путём — план сбора строит в том числе «запрос плюс региональная
 * подсказка», и там 80 знаков уже превышены. У адреса и заголовка рез в
 * построителе есть, у запроса его не было.
 */
export const SERP_FOUND_BY_MAX_CHARS = 80;

/** Ячейка «Найдено по запросу»: запрос целиком либо видимый рез многоточием. */
function serpFoundByCell(query: string): string {
  const text = query.trim();
  if (text.length <= SERP_FOUND_BY_MAX_CHARS) return text;
  return `${text.slice(0, SERP_FOUND_BY_MAX_CHARS - 1)}…`;
}

/**
 * Заголовок второй таблицы: она одна на регион, а не на движок.
 *
 * Вопрос «по какой формулировке нашлось» к движку не привязан. Движок при этом
 * не теряется — он остаётся в наблюдении и в провенансе, просто не является
 * осью таблицы.
 */
function serpExtraTableTitle(regionLabel: string, suffix: string): string {
  return `${serpRegionTitle(regionLabel)} — найдено по дополнительным запросам${suffix}`;
}

/**
 * Метка контура с заглавной — так, как её печатают заголовки страниц.
 *
 * «ОАЭ» приходит меткой раздела, «международный» — строчным, и оба вида стоят в
 * начале предложения.
 */
function serpRegionTitle(regionLabel: string): string {
  return regionLabel.charAt(0).toUpperCase() + regionLabel.slice(1);
}

/**
 * Лид второй таблицы: что это за список и почему у него нет номеров.
 *
 * Молчание о номерах здесь опаснее, чем на первой таблице: читатель уже увидел
 * нумерованную двадцатку и по привычке ищет места и тут.
 */
const SERP_EXTRA_LEAD =
  "Здесь материалы, которых нет в таблице по имени: их нашли другие запросы прогона. " +
  "Мест в выдаче у этих строк не показано — у каждого запроса своя нумерация, и сравнивать её с первой таблицей нельзя.";

/**
 * Честное пустое состояние второй таблицы — **с названием контура**.
 *
 * Утверждение здесь региональное, а не про прогон: лист ОАЭ говорил
 * «дополнительных запросов в этом прогоне не было» при том, что семью
 * страницами выше двадцать одна строка России помечена найденной именно
 * дополнительными. Клиент читал утверждение, которое опровергается его же
 * отчётом.
 *
 * Метка контура заодно различает два таких листа: без неё оба региона печатали
 * дословно одно тело, и страница повторялась в отчёте целиком.
 */
function serpExtraNoQueries(regionLabel: string): string {
  return `${regionLabel} — дополнительных запросов в этом контуре не было: вся собранная выдача пришла по основному запросу.`;
}

/** Дополнительные запросы были, но нового не принесли. */
function serpExtraNothingNew(regionLabel: string): string {
  return `${regionLabel} — дополнительные запросы не нашли ничего, чего нет в таблице по имени.`;
}

/**
 * Сколько строк осталось за пределом — словами и с указанием рода.
 *
 * Молчаливое усечение здесь — та же тихая потеря содержимого, ради которой
 * заведён весь этот контур. Род назван, потому что без него читатель вправе
 * заподозрить, что срезали негатив, — а его как раз не срезают никогда.
 */
function serpExtraRemainderLine(count: number): string {
  // Существительное согласуется с числом, сказуемое — нет: при количественном
  // обороте нормой остаётся средний род («ещё 5 материалов осталось»).
  const word = pluralRu(count, "материал", "материала", "материалов");
  return (
    `Ещё ${count} ${word} осталось за пределом таблицы: это нейтральные, непроверенные и материалы ` +
    "о другом лице — нежелательные и вероятные показаны все."
  );
}

/**
 * Продолжение таблицы: лист называет себя номером.
 *
 * Различитель нужен по делу: семь листов второй таблицы печатали дословно один
 * абзац, и у неё, в отличие от первой, нет вывода страницы, который различал бы
 * их сам. Номер листа — единственный факт, который у каждого свой при любых
 * данных: запросы на листах могут совпадать все до одного.
 */
function serpExtraContinuationLine(index: number, count: number): string {
  return `Продолжение таблицы, лист ${index} из ${count}.`;
}

/**
 * Предел заголовка строки — по ширине его колонки (0.27 листа, 257 px полезных).
 *
 * 95 знаков ложатся в пять нарисованных строк при 9 pt даже одним словом, то
 * есть ниже худшей законной строки таблицы, из которой выведена ёмкость листа
 * (её задаёт адрес — `template-registry.ts`, `serp-table`). Рез стоит здесь, а
 * не в рендерере: `_clip_words(text, 200)` резал молча и невидимо для
 * текстового эталона, а подрезанный заголовок — это то, что читает клиент.
 */
const SERP_TITLE_MAX_CHARS = 95;

/**
 * Слова на месте заголовка, которого поисковик не отдал.
 *
 * Формулировка одна на оба случая — заголовка нет вовсе и заголовок оказался
 * адресом строки: для клиента это один и тот же факт, а две разные заглушки в
 * одной таблице читаются как два разных.
 */
export const SERP_TITLE_NOT_GIVEN = "Заголовок не отдан поисковой системой";

/**
 * Отдал ли поисковик заголовок этой строки.
 *
 * Адрес в поле заголовка кладём **мы сами**: адаптер Arsenkin честно пишет
 * `null`, когда карта сниппетов заголовка не содержит, а
 * `canonical-report-prepare.ts` подставляет `title: text || obs.title ||
 * obs.url || obs.key`. Печатник поэтому видит непустой заголовок, и прежнее
 * запасное «(без заголовка)» не срабатывало — оно ждало `undefined`. Замер
 * эталона-72: шесть строк из 46 печатали свой адрес в колонке «Заголовок», и
 * он же стоял под строкой полосой — а теперь стоит в соседней ячейке.
 *
 * Сравнение идёт **существующим** `clientAddress` — единственным ответом
 * проекта на «как выглядит адрес для клиента»; новой нормализации здесь не
 * заводится. Отвергнут более широкий предикат «заголовок начинается с `http`»:
 * он назвал бы неотданным и заголовок с **чужим** адресом внутри (в корпусе
 * такой есть — видео с `title`, начинающимся с `https://t.me/…`), а это другой
 * факт: поисковик заголовок отдал, просто в нём стоит ссылка.
 */
export function serpTitleWasGiven(title: string | undefined, url: string | undefined): boolean {
  const text = String(title ?? "").trim();
  if (!text) return false;
  const asAddress = clientAddress(text);
  // Заголовок вообще не адрес — значит отдан. `undefined === undefined` иначе
  // назвал бы неотданным любой заголовок у записи без разбираемого адреса.
  if (asAddress === undefined) return true;
  return asAddress !== clientAddress(url);
}

/** Ячейка «Заголовок»: заголовок поисковика либо слова о том, что его нет. */
export function serpRowTitleCell(title: string | undefined, url: string | undefined): string {
  return serpTitleWasGiven(title, url) ? serpRowTitle(String(title).trim()) : SERP_TITLE_NOT_GIVEN;
}

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
 * Запасное правило выбора запроса: работает там, где пометки «это само имя» в
 * данных нет вовсе (наборы, собранные до её появления).
 *
 * Таблица — это одна страница выдачи, а не сводка по всем запросам сразу.
 * Смешав запросы, мы получили бы две строки с позицией 1 и номер, который
 * ничего не значит. Поэтому на каждый поисковик берётся один запрос: сначала
 * тот, что искал субъекта по имени, при равенстве — давший больше материала,
 * а на совсем равных — первый по алфавиту, чтобы отчёт был воспроизводим.
 *
 * **Правило именно запасное.** На пяти равных написаниях ФИО все несут один
 * `subject_lookup`, а счёт материалов у них почти одинаков — то есть решает
 * алфавит. Основной запрос выбирает `mainSerpTableQuery`, и он же говорит,
 * чьё это было решение.
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
 * Основной запрос таблицы и **чьё это решение**.
 *
 * Вопрос один, поэтому и ответ один: пометка данных первым признаком, запасное
 * правило — только когда пометки в наборе нет вовсе. Пока пометка не доезжала
 * до деки, выбор делало запасное правило всегда, а оно на пяти равных
 * написаниях ФИО решает счётом материалов и алфавитом — то есть при другом
 * наборе написаний та же дека показала бы другую двадцатку.
 *
 * `markedByData: false` — это не ошибка, а старый набор: страница обязана
 * сказать, что запрос выбрали мы, вместо того чтобы выдать наше решение за
 * факт данных.
 */
export function mainSerpTableQuery(
  rows: Array<{ query?: string; queryPurpose?: string; subjectNameQuery?: boolean }>
): { query: string | null; markedByData: boolean } {
  const marked = rows.filter((r) => r.subjectNameQuery === true && String(r.query ?? "").trim());
  if (marked.length > 0) {
    // Написаний у помеченного запроса может быть несколько (регистр —
    // свойство написания), и запасное правило сводит их тем же счётом.
    return { query: pickSerpTableQuery(marked), markedByData: true };
  }
  return { query: pickSerpTableQuery(rows), markedByData: false };
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
/**
 * Что означает «№» в позиционной таблице.
 *
 * Спецблоки названы, потому что печатаем мы органику: клиент, сверяющий номер
 * с экраном браузера, иначе решит, что строки съехали.
 */
const SERP_RANKS_ARE_POSITIONS =
  "Позиции — как их вернул поисковик; спецблоки (картинки, видео, новости) в нумерацию не входят.";

/**
 * Что означает «№» в таблице без позиций.
 *
 * Набор, собранный до того, как позиция стала сохраняться, нумеруется порядком
 * сбора. Молчание об этом и прочиталось владельцем как «ТОП-20»: заголовок
 * листа честно говорил «собранная выдача», а абзац страницы состоял из одной
 * фразы про уровень внимания.
 */
const SERP_RANKS_ARE_COLLECTION_ORDER =
  "Номера строк — порядок в собранной сводке, а не места в выдаче.";

/**
 * Кто выбрал запрос этой таблицы.
 *
 * Наборы, собранные до появления пометки «это само имя», не говорят, какой из
 * запросов основной, — и тогда его выбираем мы, по числу материалов, а на
 * равных по алфавиту. Промолчать об этом значит выдать наше решение за факт
 * данных: читатель поймёт заголовок «ТОП-20 по запросу ФИО» как обещание, что
 * именно это написание и есть главное.
 */
const SERP_QUERY_CHOSEN_BY_US =
  "Запрос для этой таблицы выбран нами: в собранных данных не отмечено, какой из запросов основной.";

/**
 * Таблица движка построена не на основном запросе региона.
 *
 * Так бывает, когда поисковик не вернул по основному написанию ничего: пустая
 * выдача, отказ провайдера, квота. Прежде такая страница печатала оговорку
 * «в собранных данных не отмечено, какой из запросов основной» — и это была
 * ложь: отмечено, просто не у строк этого движка. Утверждение здесь
 * прослеживается до наблюдений: у этого поисковика в наборе нет ни одной
 * строки по названному запросу.
 */
function serpQueryIsNotRegionMain(mainQuery: string): string {
  return (
    `Основной запрос этого раздела — «${mainQuery}»; у этого поисковика по нему в наборе ` +
    "нет ни одной строки, поэтому таблица показывает другой запрос."
  );
}

/**
 * Чья это выдача, когда запрос в наборе не записан.
 *
 * Без этой фразы тело страницы не называет поисковик вовсе — его знает только
 * заголовок, — и два листа разных поисковиков с одинаковой темой печатали
 * дословно один текст (эталон-72, страницы 16 и 22). Фраза заодно объясняет,
 * почему запроса нет: молчание об этом читается как «спрашивали неизвестно
 * что».
 */
function serpCollectedWithoutQuery(engineLabel: string): string {
  return `Показана выдача ${engineLabel}; запрос, по которому она собрана, в наборе не записан.`;
}

export function serpTablePageProse(input: {
  /** Название поисковика в родительном падеже: «Яндекса», «Google». */
  engineLabel: string | null;
  query: string | null;
  /**
   * Запрос выбран нами запасным правилом, а не назван пометкой данных.
   *
   * Признак приходит оттуда же, где сделан выбор (`mainSerpTableQuery`):
   * второй ответ на «чьё это решение» разошёлся бы с первым.
   */
  queryChosenByUs?: boolean;
  /**
   * Основной запрос раздела, если таблица построена **не** на нём.
   *
   * Пусто — таблица показывает основной запрос либо основного в данных нет
   * вовсе; тогда об этом говорит `queryChosenByUs`. Две оговорки исключают друг
   * друга: они отвечают на один вопрос «почему здесь этот запрос».
   */
  regionMainQuery?: string | null;
  /** Перечень несобранных номеров; пусто — таблица полная. */
  missing: string;
  /**
   * Номера строк — позиции выдачи или порядок нашей сводки. Ответ известен
   * всегда, поэтому и печатается всегда, но фразы **разные**: одна общая
   * обещала бы позиции там, где их нет.
   */
  positional: boolean;
  /** Даты съёмки материалов; единственный источник — `report-material-freshness`. */
  freshness?: MaterialFreshness | null;
  /** Справка о наборе запросов прогона и сам набор, по которому она решается. */
  queriesLine?: string;
  subjectQueries?: string[];
}): { head: string; tail?: string } {
  const parts: string[] = [];
  if (input.query) {
    const engine = input.engineLabel ? `выдача ${input.engineLabel}` : "выдача";
    parts.push(`Показана ${engine} по запросу «${input.query}».`);
    // Оговорка стоит сразу за названием запроса: она о нём и без него не
    // значит ничего. Оговорок две, и они взаимоисключающие.
    if (input.regionMainQuery) {
      parts.push(serpQueryIsNotRegionMain(input.regionMainQuery));
    } else if (input.queryChosenByUs) {
      parts.push(SERP_QUERY_CHOSEN_BY_US);
    }
  } else if (input.engineLabel) {
    parts.push(serpCollectedWithoutQuery(input.engineLabel));
  }
  /*
   * Дата съёмки — только у `report-material-freshness`, и второго ответа о
   * дате в проекте не заводится. Своё `new Date()` или `generatedAt` пакета
   * сюда попасть не должны: `generatedAt` — время сборки, а не съёмки, и
   * пересборка через месяц напечатала бы клиенту ложную дату.
   *
   * Эпоха-заглушка датой не считается — её отсеивает `isUsableCollectedAt`
   * внутри `freshnessFootnote`. Отвергнут вариант печатать «дата сбора не
   * записана»: это фраза о нашем хранилище, а не об источнике.
   */
  const collected = input.freshness ? freshnessFootnote(input.freshness) : undefined;
  if (collected) parts.push(`${collected[0]!.toUpperCase()}${collected.slice(1)}.`);
  if (input.missing) {
    parts.push(
      `Позиции ${input.missing} в собранных данных отсутствуют: эти строки потеряны при сборе, а не пусты в выдаче.`
    );
  }
  parts.push(input.positional ? SERP_RANKS_ARE_POSITIONS : SERP_RANKS_ARE_COLLECTION_ORDER);
  const queries = input.subjectQueries ?? [];
  const repeatsTableQuery = queries.length === 1 && sameSerpQuery(queries[0], input.query);
  const tail = input.queriesLine && !repeatsTableQuery ? input.queriesLine : undefined;
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
  scoped: ScopedFragmentInput,
  /*
   * Дата съёмки приходит сюда единственным путём — тем же полем, каким её
   * читают исполнительная сводка и страница региона.
   *
   * Необязателен намеренно: без него куска про дату в лиде просто нет — тот же
   * исход, что и при непригодной дате. Двум десяткам юнитов, собирающих
   * фрагмент из голого `scoped`, дата не нужна, и требовать от них пустой
   * объект значило бы менять их ради подписи. Живой путь передаёт `extras`
   * всегда (`section-builders.ts`).
   */
  extras?: Pick<FragmentExtras, "materialFreshness">
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
  ): Array<{ query: string; queryPurpose?: string; subjectNameQuery?: boolean }> => {
    const out = new Map<
      string,
      { query: string; queryPurpose?: string; subjectNameQuery?: boolean }
    >();
    for (const ref of groupRefs) {
      const e = scoped.evidenceIndex[ref];
      const q = String(e?.query ?? "").trim();
      if (!q) continue;
      const key = normalizeSerpQuery(q);
      if (!out.has(key)) {
        out.set(key, {
          query: q,
          queryPurpose: e?.queryPurpose,
          ...(e?.subjectNameQuery ? { subjectNameQuery: true } : {}),
        });
      }
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
  const byEngine = new Map<string, Array<{ key: string; refs: string[]; engineRefs: string[] }>>();
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
      // Ключ материала едет с группой: по нему вторая таблица и узнаёт, что
      // материал уже показан первой.
      list.push({ key: group.key, refs: group.refs, engineRefs });
      byEngine.set(engine, list);
    }
  }
  /*
   * Основной запрос — свойство **раздела**, а не движка.
   *
   * Пометка «это само имя» ставится на строки сбора, и один поисковик может не
   * иметь по основному написанию ни одной: пустая выдача, отказ провайдера,
   * квота. Пока признак считался по строкам одного движка, такая таблица
   * строилась на дополнительном запросе и печатала «в собранных данных не
   * отмечено, какой из запросов основной» — при том, что отмечено. Соседняя
   * страница добавляла второе ложное утверждение: «дополнительных запросов не
   * было», хотя на одном из них и построена таблица.
   */
  const regionMain = mainSerpTableQuery(merged.flatMap((g) => queriesOfRefs(g.refs)));

  const engineTables = [...byEngine.entries()]
    .sort(
      (a, b) =>
        (SERP_ENGINE_ORDER.indexOf(a[0]) + 1 || 99) - (SERP_ENGINE_ORDER.indexOf(b[0]) + 1 || 99)
    )
    .map(([engine, groups]) => {
      // В счёт идёт каждая пара «материал — запрос», а не один запрос на
      // материал: запасное правило считает, сколько материала показал запрос.
      const { query, markedByData } = mainSerpTableQuery(
        groups.flatMap((g) => queriesOfRefs(g.engineRefs))
      );
      /*
       * Почему в этой таблице такой запрос — вопрос один, и ответов на него
       * ровно два, взаимоисключающих: либо в разделе пометки нет вовсе и выбор
       * сделали мы, либо пометка есть, но таблица показывает **не тот** запрос.
       *
       * Второе условие сравнивает сами запросы, а не наличие пометки у строк
       * движка. Пометка сводится по ИЛИ на уровне материала, а не запроса, и
       * набор, где часть строк собрана до её появления, даёт движок с тем же
       * основным запросом и без пометки. Печатать там «у этого поисковика по
       * основному запросу нет ни одной строки» — ложь, которую опровергает
       * предыдущее предложение того же абзаца.
       */
      const regionIsMarked = regionMain.markedByData;
      const showsOtherQuery = Boolean(query) && !sameSerpQuery(query, regionMain.query);
      const queryChosenByUs = Boolean(query) && !regionIsMarked && !markedByData;
      const regionMainQuery = regionIsMarked && showsOtherQuery ? regionMain.query : null;
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
      if (ranked.length > 0) {
        return {
          engine,
          query,
          queryChosenByUs,
          regionMainQuery,
          displayed: ranked,
          positional: true,
        };
      }
      // Прогоны, собранные до того, как позиция стала сохраняться, позиций не
      // несут вовсе. Показать такую выдачу можно, назвать её ТОП-20 — нет:
      // строки нумеруются порядком сбора, и заголовок это признаёт.
      const unranked = scopedGroups
        .map((group, index) => ({ group, index, rank: index + 1 }))
        .slice(0, SERP_TABLE_TOP_N);
      return { engine, query, queryChosenByUs, regionMainQuery, displayed: unranked, positional: false };
    })
    .filter((t) => t.displayed.length > 0);

  // Материалы без поисковика показываются только когда показывать больше
  // нечего. Рядом с названными таблицами такая страница ничего не сообщает:
  // ни где стоял материал, ни в каком поисковике его видно.
  const namedTables = engineTables.filter((t) => t.engine);
  const tables = namedTables.length > 0 ? namedTables : engineTables;

  /**
   * Оценка материала — одна на обе таблицы выдачи.
   *
   * Строка «Нежелательный» во второй таблице обязана считаться тем же
   * предикатом, что и в первой: два ответа на «негативен ли материал»
   * разошлись бы, и потолок второй таблицы срезал бы то, что первая красит.
   */
  const ratingOf = (refs: string[]): string => {
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
    const adverse = evidenceRowsAdverse(scoped, refs);
    /*
     * «Нейтральный» — это результат проверки, а не её отсутствие.
     *
     * Признак берётся из данных: есть тон прочитанной страницы — страницу
     * открыли и оценили. Отказ чтения тона не оставляет, и такая строка
     * называется «Не проверено» вместе с той, которую не запрашивали вовсе.
     */
    const verified = refs.some((ref) => evidenceRowWasRead(scoped.evidenceIndex[ref]));
    const likely = refs.some(
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
    const other = evidenceRowsAreOtherSubject(scoped, refs);
    // Red marker must always carry its label; domain comes from evidence URL.
    // LIKELY (§2.1) → «Вероятно» — visible but not confirmed-subject KPI.
    //
    // Непрочтение стоит ниже «Вероятно»: неопределённость принадлежности —
    // более сильная оговорка, чем неоткрытая страница. И ниже «Нежелательного»:
    // непрочитанная строка с негативным сигналом остаётся негативной, глушить
    // сигнал из-за того, что страницу не открыли, — потеря.
    return other
      ? OTHER_SUBJECT_LABEL
      : adverse
        ? RED_MARKER_LABEL
        : likely
          ? "Вероятно"
          : verified
            ? "Нейтральный"
            : UNVERIFIED_LABEL;
  };

  /** Тип источника материала — тем же разрешителем, что и у второй таблицы. */
  const sourceTypeOf = (e: { sourceType?: string; domain?: string; url?: string }): string =>
    resolveSourceType({ fromVerdict: e.sourceType, domain: e.domain ?? domainOfUrl(e.url) }) ?? "—";

  /** Строка результата: адрес стоит в ней ячейкой, а не полосой под ней. */
  const rowOf = (group: { refs: string[] }, rank: number): string[] => {
    const e = scoped.evidenceIndex[group.refs[0]!] ?? {};
    // Номер строки — настоящая позиция в выдаче, а не счётчик строк таблицы.
    // Счётчик выдавал «24-е место в Яндексе» там, где материал стоял третьим
    // по другому запросу.
    return [
      String(rank),
      clientLink(e.url, e.domain),
      serpRowTitleCell(e.title, e.url),
      sourceTypeOf(e),
      ratingOf(group.refs),
    ];
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
    /** Запрос выбран нами запасным правилом, а не назван пометкой данных. */
    queryChosenByUs: boolean;
    /** Основной запрос раздела, если таблица построена не на нём. */
    regionMainQuery: string | null;
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
    // Строки и их опоры режутся одним разрезом: соответствие «строка → ссылки»
    // держится индексом, и разъехавшиеся куски остановили бы сборку.
    const rowChunks = cut(printed);
    const printedRowChunks = cut(
      table.displayed.map((x) => ({ rank: x.rank, refs: x.group.refs }))
    );
    const printedRanks = table.positional ? table.displayed.map((x) => x.rank) : [];
    const missing = table.positional ? missingSerpRanks(printedRanks) : "";
    const prose = serpTablePageProse({
      engineLabel: serpEngineLabelGenitive(table.engine),
      query: table.query,
      queryChosenByUs: table.queryChosenByUs,
      regionMainQuery: table.regionMainQuery,
      missing,
      positional: table.positional,
      freshness: extras?.materialFreshness ?? null,
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
        printedRows: printedRowChunks[i] ?? [],
        lead: prose.head,
        ...(prose.tail ? { note: prose.tail } : {}),
        engine: table.engine,
        query: table.query,
        queryChosenByUs: table.queryChosenByUs,
        regionMainQuery: table.regionMainQuery,
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
    // Домены абзац не называет, и это единственное место, где так: колонка
    // «Ссылка» печатает адреса целиком и все, а перечень в абзаце режется
    // тремя элементами — страница противоречила бы своей же таблице.
    const pageBlocks = pageFindingBlocks(scoped, view, { namePageDomains: false });
    const slide = makeSlotSlide({
      slot,
      sectionId,
      title: pages[i]!.title,
      content: {
        table: {
          headers: [...SERP_TABLE_HEADERS],
          rows: pageRows,
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

  /*
   * Вторая таблица выдачи — «Найдено по дополнительным запросам».
   *
   * Вопроса два, поэтому и таблицы две. Первая отвечает «что видно по имени и
   * на каком месте», вторая — «что вообще есть про человека, чего по имени не
   * видно». Смешивать их запрещено и владельцем, и смыслом: у объединённой
   * таблицы номер строки не значит ничего, и именно так его однажды и
   * прочитали.
   *
   * Она **одна на регион**, а не на движок: вопрос «по какой формулировке
   * нашлось» к движку не привязан. Движок при этом не теряется — он остаётся в
   * наблюдении и в провенансе, просто не является осью таблицы.
   */
  const datasetHasQueries = refs.some((ref) =>
    String(scoped.evidenceIndex[ref]?.query ?? "").trim()
  );
  if (datasetHasQueries) {
    /*
     * «Дополнительный» — значит «не основной запрос **раздела**».
     *
     * Пока список основных собирался из запросов получившихся таблиц, движок,
     * построивший свою таблицу на дополнительном запросе, объявлял его
     * основным — и вторая таблица отрицала существование дополнительных
     * запросов на том же развороте, где они и работали.
     */
    const mainQueryKeys = new Set(
      regionMain.query ? [normalizeSerpQuery(regionMain.query)] : []
    );
    // Единица сравнения — ключ материала, тот же, каким таблица сводит строки.
    // А региона это **объединение** таблиц обоих движков: материал, стоящий в
    // двадцатке Google, во второй таблице ничего не сообщает, даже если по
    // Яндексу его нашли другим запросом.
    const shownInMainTables = new Set(tables.flatMap((t) => t.displayed.map((x) => x.group.key)));
    /**
     * Лучшая позиция материала по названному запросу — на любом движке.
     *
     * Позиции здесь не печатаются вовсе, поэтому фильтр «своя нумерация» не
     * нужен: число участвует только в выборе запроса и в порядке строк.
     */
    const bestRankForQuery = (groupRefs: string[], query: string): number => {
      const ranks = groupRefs
        .filter((ref) => sameSerpQuery(scoped.evidenceIndex[ref]?.query, query))
        .map((ref) => scoped.evidenceIndex[ref]?.rank)
        .filter((r): r is number => typeof r === "number" && r > 0);
      return ranks.length > 0 ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
    };
    /**
     * Класс строки для потолка и порядка.
     *
     * 0 — «Нежелательный», 1 — «Вероятно»: продукт существует ради того, чтобы
     * негатив находился, значит режем не его. 2 — «Нейтральный», «Не проверено»
     * и «О другом лице»: все три, а не «нейтральное», потому что «Не проверено»
     * это не «Нейтральный» — на корпусе именно оно составляет почти всю вторую
     * таблицу.
     */
    const riskClass = (rating: string): number =>
      rating === RED_MARKER_LABEL ? 0 : rating === "Вероятно" ? 1 : 2;
    const candidates = merged
      .filter((group) => !shownInMainTables.has(group.key))
      .map((group) => {
        const extraQueries = queriesOfRefs(group.refs).filter(
          (q) => !mainQueryKeys.has(normalizeSerpQuery(q.query))
        );
        if (extraQueries.length === 0) return null;
        /*
         * «Найдено по запросу» называет один запрос, и правило выбора живёт
         * здесь, а не в голове: материал, найденный двумя формулировками,
         * подписывается той, по которой он стоял **выше**, а на равных — первой
         * по алфавиту. Без названного правила два прогона дали бы разный текст,
         * и детерминизм эталона покраснел бы.
         */
        const ranked = extraQueries
          .map((q) => ({ query: q.query, rank: bestRankForQuery(group.refs, q.query) }))
          .sort(
            (a, b) =>
              a.rank - b.rank ||
              normalizeSerpQuery(a.query).localeCompare(normalizeSerpQuery(b.query), "ru")
          );
        const best = ranked[0]!;
        const rating = ratingOf(group.refs);
        return {
          key: group.key,
          refs: group.refs,
          foundBy: best.query,
          rank: best.rank,
          rating,
          riskClass: riskClass(rating),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      // Порядок назван: сначала риск, потом позиция по своему запросу, потом
      // ключ материала. Все три — данные, поэтому два прогона дают один текст.
      .sort(
        (a, b) => a.riskClass - b.riskClass || a.rank - b.rank || a.key.localeCompare(b.key, "ru")
      );
    /*
     * Потолок — по риску, а не по числу.
     *
     * Предел берётся у глубины, которую обещает первая таблица
     * (`SERP_TABLE_TOP_N`): дополнение не должно быть больше того, что
     * дополняет. Своего числа здесь не заводится — второй ответ на «какая у нас
     * глубина» разошёлся бы с первым в ближайший же месяц.
     */
    const always = candidates.filter((row) => row.riskClass < 2);
    const capped = candidates.filter((row) => row.riskClass === 2);
    const printedExtra = [...always, ...capped.slice(0, SERP_TABLE_TOP_N)];
    const remainder = Math.max(0, capped.length - SERP_TABLE_TOP_N);
    const extraCells = (row: (typeof candidates)[number]): string[] => {
      const e = scoped.evidenceIndex[row.refs[0]!] ?? {};
      return [
        clientLink(e.url, e.domain),
        serpRowTitleCell(e.title, e.url),
        serpFoundByCell(row.foundBy),
        sourceTypeOf(e),
        row.rating,
      ];
    };
    const extraMax = DECK_TEMPLATE_REGISTRY["serp-extra-queries"].maxTableRowsPerSlide;
    const extraChunks =
      printedExtra.length === 0
        ? []
        : extraMax > 0
          ? chunk(printedExtra, extraMax)
          : [printedExtra];
    const pushExtra = (index: number, count: number, content: SlideBody): void => {
      slides.push({
        ...makeSlotSlide({
          slot,
          sectionId,
          templateId: "serp-extra-queries",
          title: serpExtraTableTitle(regionLabel, count > 1 ? ` (${index + 1}/${count})` : ""),
          content,
          evidenceRefs: extraChunks[index]?.flatMap((row) => row.refs) ?? [],
          findingIds: [],
          metrics: {
            // Машинный признак второй таблицы: по нему её страницы находят и
            // ворота приёмки, и проверки. Разбирать заголовок словами значило бы
            // завести второй ответ на «какая это таблица».
            serpExtraQueries: 1,
            displayedCount: extraChunks[index]?.length ?? 0,
            extraCandidates: candidates.length,
            extraRemainder: remainder,
            pageIndex: index + 1,
            pageCount: Math.max(1, count),
          },
        }),
        slideId: `${baseSlideId}__extra${index + 1}`,
        isContinuation: true,
        continuationOf: baseSlideId,
        continuationIndex: slides.length,
      });
    };
    if (printedExtra.length === 0) {
      /*
       * Пустая таблица не рисуется: страница честного пустого состояния
       * говорит словами, чего не было. Различаются два разных факта —
       * дополнительных запросов не было вовсе и они были, но нового не нашли.
       */
      const hadExtraQueries = merged.some((group) =>
        queriesOfRefs(group.refs).some((q) => !mainQueryKeys.has(normalizeSerpQuery(q.query)))
      );
      pushExtra(0, 1, {
        narrative: hadExtraQueries
          ? serpExtraNothingNew(serpRegionTitle(regionLabel))
          : serpExtraNoQueries(serpRegionTitle(regionLabel)),
      });
    } else {
      extraChunks.forEach((page, i) => {
        /*
         * Абзац листа: объяснение — один раз, остаток — один раз.
         *
         * Семь листов печатали дословно один и тот же абзац, а фраза «Ещё 2
         * материала осталось» на каждом читалась как накопление: клиент
         * складывает семь двоек. Объяснение таблицы принадлежит её первому
         * листу, остаток — последнему, потому что он про то, чего за ним уже
         * нет.
         */
        const last = i === extraChunks.length - 1;
        pushExtra(i, extraChunks.length, {
          table: { headers: [...SERP_EXTRA_TABLE_HEADERS], rows: page.map(extraCells) },
          narrative: [
            i === 0 ? SERP_EXTRA_LEAD : serpExtraContinuationLine(i + 1, extraChunks.length),
            last && remainder > 0 ? serpExtraRemainderLine(remainder) : "",
          ]
            .filter(Boolean)
            .join(" "),
        });
      });
    }
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
