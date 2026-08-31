/**
 * Раскрой таблиц по мере рендерера.
 *
 * Вопрос «сколько строк помещается на лист» имеет ровно один ответ — код
 * отрисовки. До этого модуля ответ выводился из **худшей законной строки**
 * (адрес 165 знаков самым широким знаком 9 pt, семь нарисованных строк,
 * 1 036 320 EMU) и давал три строки на лист. Замер настоящих строк той же
 * мерой рендерера: медиана строки таблицы выдачи прогона 91 — 350 520 EMU,
 * максимум 624 840, на эталоне-72 максимум 762 000. Лист держал три строки и
 * оставался пустым больше чем наполовину, а двадцать позиций ТОП-20 занимали
 * девять листов.
 *
 * Устройство: черновая дека собирается сидом, меряется, и высоты её строк
 * приезжают сюда. Здесь строки раскладываются по листам — и раскрой уезжает в
 * **построитель**, который режет таблицу, как режет сегодня. Перекладывать
 * строки на сборке нельзя: у каждого листа таблицы свои опоры, свои находки,
 * своя фраза с номерами строк и свои счётчики, и перекладка на сборке была бы
 * логикой построителя, написанной второй раз.
 *
 * Своей формулы высоты строки здесь нет и быть не может — она была бы
 * пересказом переноса глифов на другом языке.
 */

import type { BulletMeasureVerdict } from "./measured-bullet-fit";

/**
 * Суффикс ключа страницы у мерной записи таблицы.
 *
 * Тот же, что в `renderer/orion_golden_render/visual.py`: мера таблицы и мера
 * пути буллетов лежат в одном списке вердикта, и без суффикса перекладка
 * буллетов нашла бы запись таблицы по имени страницы. Форма вердикта и его
 * версия при этом не меняются — это условие отсутствия окна деплоя.
 */
export const TABLE_MEASURE_KEY_SUFFIX = "#table";

/**
 * Ключ цепочки таблицы: слот раздела плюс имя таблицы внутри него.
 *
 * Одного слота мало: в слоте выдачи живут таблица по имени (по одной на
 * поисковик) и таблица дополнительных запросов, и режутся они порознь. Имя
 * таблицы — это движок (`YANDEX`, `GOOGLE`, пустая строка у выдачи без
 * названного поисковика) или `extra` у второй таблицы; движка с таким именем
 * не бывает, столкнуться им негде.
 *
 * Ключ считают обе стороны — построитель и сборщик плана, — поэтому он
 * объявлен здесь один раз.
 */
export function tableCutKey(baseSlotId: string, table: string): string {
  return `${baseSlotId}|${table}`;
}

/** Имя второй таблицы выдачи в ключе раскроя. */
export const EXTRA_QUERIES_TABLE = "extra";

/** Раскрой: ключ цепочки → сколько строк достаётся каждому листу, по порядку. */
export type TableCutPlan = ReadonlyMap<string, number[]>;

/**
 * Разложить строки по листам их измеренными высотами.
 *
 * Пока следующая строка влезает в остаток — кладём, не влезает — начинает
 * следующий лист. Строка, не влезающая на лист даже в одиночку, ложится на
 * свой лист целиком: резать строку значит терять её часть, а таблица режется
 * только между строками.
 */
export function cutRowsByHeight(heights: readonly number[], budget: number): number[] {
  const counts: number[] = [];
  let onSheet = 0;
  let used = 0;
  for (const height of heights) {
    if (onSheet > 0 && used + height > budget) {
      counts.push(onSheet);
      onSheet = 0;
      used = 0;
    }
    onSheet += 1;
    used += height;
  }
  if (onSheet > 0) counts.push(onSheet);
  return counts;
}

/**
 * Нарезать список по готовому раскрою; раскроя нет — по сиду реестра.
 *
 * Раскрой, чья сумма не сходится с числом строк, отвергается целиком: он
 * посчитан не про этот набор строк (черновая дека и настоящая разошлись), и
 * применить его значило бы напечатать не те строки или потерять хвост.
 * Возврат к сиду ничего не теряет — он и есть сегодняшняя раскладка.
 */
export function cutTableRows<T>(
  list: T[],
  counts: number[] | undefined,
  seedRows: number
): T[][] {
  const total = counts?.reduce((n, x) => n + x, 0) ?? -1;
  if (!counts || total !== list.length) {
    if (seedRows <= 0) return [list];
    const chunks: T[][] = [];
    for (let i = 0; i < list.length; i += seedRows) chunks.push(list.slice(i, i + seedRows));
    return chunks.length > 0 ? chunks : [list];
  }
  const chunks: T[][] = [];
  let taken = 0;
  for (const count of counts) {
    chunks.push(list.slice(taken, taken + count));
    taken += count;
  }
  return chunks;
}

/** Страница черновой деки глазами раскроя. */
export type MeasuredTablePage = {
  slideKey: string;
  baseSlotId: string;
  metrics?: Record<string, number | string>;
  table?: { rows: string[][] };
};

/**
 * Какой таблице принадлежит страница — по машинным признакам, а не по
 * заголовку.
 *
 * `serpExtraQueries` и `serpPositional` построитель ставит именно затем, чтобы
 * страницы этих таблиц находились без разбора слов; по ним же их находят
 * ворота приёмки. Страница без обоих признаков (лист тем, метрик, комплаенса)
 * раскроя не получает: её строки построитель по листам не разводит вовсе.
 */
export function tableCutKeyOfPage(page: MeasuredTablePage): string | undefined {
  const metrics = page.metrics ?? {};
  if (metrics.serpExtraQueries === 1) return tableCutKey(page.baseSlotId, EXTRA_QUERIES_TABLE);
  if (metrics.serpPositional === undefined) return undefined;
  return tableCutKey(page.baseSlotId, String(metrics.serpEngine ?? ""));
}

/**
 * Собрать раскрой из вердикта мерного прогона черновой деки.
 *
 * Строки цепочки складываются в порядке листов, бюджет берётся самый тесный из
 * измеренных: лист, которого в черновой деке ещё нет, никто не мерил, и
 * занижение бюджета стоит лишний лист, а завышение — строку, нарисованную мимо
 * поля.
 *
 * Цепочка, у которой хоть одна страница не померена или померена не той формой
 * («шапка плюс строки»), в план не попадает целиком: раскладывать её по
 * половине измерений значило бы гадать о второй. Так же выглядит и рендерер
 * прошлой версии — он не пишет мер таблиц вовсе, и раскладка остаётся сидовой.
 */
export function collectTableCutPlan(input: {
  slides: ReadonlyArray<MeasuredTablePage>;
  verdict: BulletMeasureVerdict;
}): TableCutPlan {
  const measured = new Map(input.verdict.pages.map((p) => [p.slideKey, p]));
  const chains = new Map<string, { heights: number[]; budget: number; usable: boolean }>();
  for (const slide of input.slides) {
    const key = tableCutKeyOfPage(slide);
    if (!key) continue;
    const rows = slide.table?.rows.length ?? 0;
    if (rows === 0) continue;
    const chain = chains.get(key) ?? {
      heights: [],
      budget: Number.POSITIVE_INFINITY,
      usable: true,
    };
    chains.set(key, chain);
    const page = measured.get(`${slide.slideKey}${TABLE_MEASURE_KEY_SUFFIX}`);
    // Форма меры: шапка плюс строки листа. Полосы запроса между строками эта
    // таблица не рисует; появись они — высоты перестали бы соответствовать
    // строкам, и раскладывать по ним было бы гаданием.
    if (!page || page.itemHeights.length !== rows + 1) {
      chain.usable = false;
      continue;
    }
    chain.heights.push(...page.itemHeights.slice(1));
    chain.budget = Math.min(chain.budget, page.availableHeight - page.itemHeights[0]!);
  }
  const plan = new Map<string, number[]>();
  for (const [key, chain] of chains) {
    if (!chain.usable || chain.budget <= 0 || chain.heights.length === 0) continue;
    plan.set(key, cutRowsByHeight(chain.heights, chain.budget));
  }
  return plan;
}
