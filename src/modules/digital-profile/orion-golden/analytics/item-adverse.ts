/**
 * Инвентарная запись глазами единого предиката «негативна ли строка».
 *
 * Ответ на этот вопрос один на весь отчёт и живёт в `resolveRowAdverse`
 * (`serp-observation/resolve-observation-highlights.ts`). Здесь только перевод:
 * материал корпуса → те пять полей, которые предикат читает, плюс поиск
 * решения по прочитанной странице в карте вердиктов.
 *
 * Модуль отдельный, потому что потребителей у перевода трое — синтез находок,
 * разбор поверхностей и конвейер аналитики. Пока каждый собирал строку сам,
 * они разошлись: один клал в словарь `sourceUrl` и `classification`, второй —
 * `classification` и свою регулярку по нему, третий писал выражение по месту.
 * По замеру 26.08.2026 (до сведения, разрез «предикат деки против синтеза
 * находок») ответы расходились на шести материалах из двадцати семи; после
 * сведения 28.08 счёт другой — семь материалов из 321 сменили оценку, и это
 * разные измерения, а не противоречие.
 */

import type { RawInventoryItem } from "../types";
import {
  pageReadAsFavourable,
  resolveRowAdverse,
  verdictStrength,
  type AdverseRowInput,
  type AnalystDecision,
  type ObservationVerdict,
  type ObservationVerdictByRef,
} from "../../serp-observation/resolve-observation-highlights";
import { serpMaterialKey } from "../../serp-observation/material-key";
import { evidenceRefOf } from "./analysis-scope";
import { sourceTypeFromDomain, type SourceType } from "./source-type";
import { publicDomainOf } from "./public-domain";

/**
 * Площадки, у которых сниппет выдачи — оглавление сайта, а не текст о человеке.
 *
 * Реестр и каталог устроены одинаково: карточка человека перечисляет разделы,
 * которые на ней есть, и поисковик забирает этот перечень в сниппет. На живом
 * прогоне 20.08 (кейс Прохоров) банк получил ключевым риском №1 «Криминальные /
 * судебные материалы» — под находкой стояла одна карточка `bizfiles.org` с
 * двадцатого места Яндекса, страница не читалась, а весь «криминал» был словом
 * «суды» в строке «Сводка информации, аффилированность, финансы, суды».
 * Такой перечень стоит на карточке любого человека на этом сайте.
 *
 * Тип спрашивается у `source-type.ts`, а не задаётся вторым списком доменов:
 * ответ на вопрос «что это за площадка» в проекте уже есть, и он один.
 */
const DIRECTORY_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<SourceType>([
  "База данных / реестр",
  "Агрегатор / каталог",
]);

/**
 * Сниппет наблюдения — или пусто, если читать его как утверждение нельзя.
 *
 * Режется именно сниппет, а не материал целиком: заголовок карточки реестра
 * («Суд взыскал с …») — по-прежнему утверждение, и тему он даёт. Прочитанная
 * страница ничего не теряет и здесь: её темы идут своим путём, через
 * `run-link-verdicts.ts` → `link-theme-clustering.ts`, а в него `itemText` не
 * входит.
 */
export function readableSnippet(item: RawInventoryItem): string | undefined {
  const type = sourceTypeFromDomain(publicDomainOf(item.sourceUrl));
  return type && DIRECTORY_SOURCE_TYPES.has(type) ? undefined : item.snippet;
}

/**
 * Правка аналитика по материалу — одно поле с двумя значениями.
 *
 * В корпусе она живёт двумя флагами (`analystAdverse` / `analystNeutral`), но
 * предикат принимает одно решение: источник снимает противоположный флаг, и
 * состояния «и то, и другое» не существует. Флаги мутируют инвентарь на месте
 * и до сборки рисованных активов, поэтому и построителю рамок читать артефакт
 * заново незачем — он спрашивает эту же функцию.
 */
export function analystDecisionOf(item: RawInventoryItem): AnalystDecision | undefined {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  if (meta.analystNeutral === true) return "NEUTRAL";
  if (meta.analystAdverse === true) return "ADVERSE";
  return undefined;
}

/** Материал так, как его видит предикат строки. */
function adverseRowOf(item: RawInventoryItem): AdverseRowInput {
  return {
    url: item.sourceUrl,
    title: item.title,
    snippet: readableSnippet(item),
    analystDecision: analystDecisionOf(item),
  };
}

/**
 * Какой материал стоит за инвентарной записью — тем же ключом, что у деки.
 *
 * Запись без адреса материалом ни с кем не делится: у карточки комплаенс-базы
 * адреса нет, а заголовок — имя субъекта, одинаковое у всех баз, и одно решение
 * сняло бы совпадение сразу у трёх — прямо против правила «совпадение по
 * комплаенсу не подтверждается автоматически».
 */
function materialKeyOf(item: RawInventoryItem): string {
  const ref = evidenceRefOf(item);
  if (!item.sourceUrl) return ref;
  return serpMaterialKey({ url: item.sourceUrl, title: item.title }, ref);
}

/**
 * Разложить решения по прочитанным страницам на все ссылки своего материала.
 *
 * Читаем мы страницы, а не строки: список ссылок на чтение дедуплицирован по
 * адресу (`linksToRead`), поэтому у страницы, найденной двумя запросами или
 * двумя движками, решение ровно одно — на первой ссылке. Дека это правило уже
 * знает (`applyLinkVerdictsToEvidence`), и без него на прогоне Кремлёва строка
 * таблицы ОАЭ печаталась «Нейтральной» при красной рамке на том же адресе двумя
 * листами дальше. Аналитика, считающая иначе, вернула бы тот же спор: «негативных: 1»
 * в таблице метрик над чистой строкой таблицы выдачи.
 *
 * Раскладка делается один раз, в конвейере, и потребители получают уже готовую
 * карту — иначе ответ на «какое решение у этого материала» появился бы у
 * каждого свой.
 */
export function spreadVerdictsOverMaterials(
  items: RawInventoryItem[],
  verdictByRef: ObservationVerdictByRef
): ObservationVerdictByRef {
  const strongest = new Map<string, ObservationVerdict>();
  for (const item of items) {
    const own = verdictByRef[evidenceRefOf(item)];
    if (!own) continue;
    const key = materialKeyOf(item);
    const prev = strongest.get(key);
    if (!prev || verdictStrength(own) > verdictStrength(prev)) strongest.set(key, own);
  }
  const out: ObservationVerdictByRef = {};
  for (const item of items) {
    const verdict = strongest.get(materialKeyOf(item));
    if (verdict) out[evidenceRefOf(item)] = verdict;
  }
  return out;
}

/**
 * Негативен ли материал — тем же ответом, каким дека красит строку выдачи.
 *
 * `classification` в этот ответ не входит намеренно: у строк выдачи он и есть
 * этот же предикат под другим именем (`resolve-observation-highlights.ts`
 * пишет `ADVERSE_MEDIA` ровно по нему), а у остальных материалов — четвёртый
 * словарь из `risk-classifier/`. Мерить негатив ярлыком, который сам записан
 * предикатом негатива, значит проверять дефект тем, что его создаёт.
 */
export function resolveItemAdverse(
  item: RawInventoryItem,
  verdictByRef?: ObservationVerdictByRef
): boolean {
  return resolveRowAdverse(adverseRowOf(item), verdictByRef?.[evidenceRefOf(item)]);
}

/**
 * Прочитали ли страницу материала и признали ли её благоприятной.
 *
 * Тот же перевод инвентарной записи, что и у `resolveItemAdverse`, — ответ
 * общий с декой и живёт в `pageReadAsFavourable`. Дека спрашивает его о
 * нарисованной строке, аналитика о материале корпуса, а решение одно: может ли
 * обвиняющая тема на этот материал опираться.
 */
export function resolveItemReadFavourably(
  item: RawInventoryItem,
  verdictByRef?: ObservationVerdictByRef
): boolean {
  return pageReadAsFavourable({
    tone: verdictByRef?.[evidenceRefOf(item)]?.tone,
    analystDecision: analystDecisionOf(item),
  });
}
