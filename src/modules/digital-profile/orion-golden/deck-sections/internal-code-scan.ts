/**
 * Внутренние коды не попадают в клиентский документ (шаг 07.8).
 *
 * В деке контрольного прогона на странице профиля стояло:
 *
 *     «Визуальный экспорт страницы в текущем офлайн-наборе недоступен
 *      (VISUAL_ASSET_UNAVAILABLE); содержимое записи приведено в текстовом виде»
 *
 * Отчёт читает человек, а не оператор системы: техническая константа в скобках
 * не сообщает ему ничего и подрывает доверие ко всему документу. Правило общее,
 * а не про один код — иначе следующий такой же появится незамеченным.
 *
 * Модуль чистый: ни сети, ни БД. Правило консервативно и знает про формы,
 * которые в русском и английском тексте законны.
 */

/**
 * Токен вида `SCREAMING_SNAKE_CASE` — форма внутренних кодов проекта
 * (`VISUAL_ASSET_UNAVAILABLE`, `PRE_RENDER_DATA_GATE_FAILED`).
 *
 * Требуется хотя бы одно подчёркивание: одиночные заглавные аббревиатуры
 * («ОГРНИП», «PEP», «OFAC», «KYC») — законная часть текста due diligence.
 */
const INTERNAL_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu;

/**
 * Идентификатор набора данных в нижнем регистре — `ext_gb_coh_psc`,
 * `us_trade_csl`, `ru_billionaires_2021`.
 *
 * Прежде такие имена считались законными: «приходят в нижнем регистре и под
 * правило не подпадают». Решение оказалось неверным — в отчёте 72 они трижды
 * стояли в кавычках как слова источника: «…источники: ext_gb_coh_psc,
 * us_trade_csl, eu_fsf, ru_billionaires_2021, ru_navalny35». Читателю такое имя
 * не сообщает ровно ничего, независимо от регистра.
 *
 * Подчёркивание между буквами и цифрами — надёжный признак: в русской и
 * английской прозе его не бывает. В адресе — бывает, и там оно законно:
 * `banki.ru/news/story/person/leonid_mihelson` это ссылка на материал, а не
 * имя набора. Адреса из проверки исключены целиком.
 *
 * **Форма имени набора неотличима от ника в соцсети,** и это выяснилось на
 * живом прогоне 21.08 (кейс Кремлёв): ворота остановили оплаченный отчёт на
 * последнем шаге из-за `umar_kremlev` и `shara_bullet77` — так подписаны
 * аккаунты, попавшие в заголовки страниц выдачи. В корпусе прогона Ким такие
 * же: `tangerina_kim`, `rbc_ru`, `aleko_n`. Отличить `ru_billionaires_2021` от
 * `umar_kremlev` по форме нельзя.
 *
 * Поэтому нижний регистр **не останавливает сборку** (решение владельца
 * 21.08): он остаётся замечанием в отчёте проверки. Наши собственные коды
 * пишутся ЗАГЛАВНЫМИ и ловятся `INTERNAL_CODE` — их блокировка не тронута.
 */
const DATASET_CODE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu;

/**
 * Адрес в клиентском тексте: таблица выдачи печатает ссылку целиком, и
 * подчёркивание в пути к материалу — часть адреса, а не код.
 */
const URL_LIKE = /(?:https?:\/\/)?(?:[\p{L}\d-]+\.)+[a-z]{2,}(?:\/[^\s|]*)?/giu;

/**
 * Строки, которые выглядят как код, но им не являются.
 *
 * Составные термины due diligence законны и в отчёте нужны.
 */
const ALLOWED = new Set<string>(["ID_CARD", "PEP_RCA"]);

/**
 * Токен нижнего регистра из чужого текста: ник, слаг, имя набора.
 *
 * Отдельной функцией, потому что отвечает на другой вопрос: не «наш ли это
 * код», а «похоже ли на машинное имя». Первый вопрос останавливает сборку,
 * второй — нет.
 */
export function findLowercaseCodeLikeTokens(text: string | null | undefined): string[] {
  return collect(text, [DATASET_CODE]);
}

/** Найденные в тексте внутренние коды (без повторов, в порядке появления). */
export function findInternalCodes(text: string | null | undefined): string[] {
  // Маркер находки — служебная связь блока с доказательной базой. Встречается
  // и в скобках в конце блока, и голым — колонкой таблицы матрицы рисков. До
  // бумаги он не доходит ни в том, ни в другом виде: в отчёте 72 строка
  // «finding-» не встречается ни разу, отрисовщик её снимает.
  return collect(text, [INTERNAL_CODE]);
}

/** Общий разбор: маркер находки и адреса снимаются до поиска. */
function collect(text: string | null | undefined, patterns: RegExp[]): string[] {
  const value = String(text ?? "")
    .replace(/\[?finding-[\p{L}\d_-]+\]?/gu, " ")
    .replace(URL_LIKE, " ");
  if (!value.trim()) return [];
  const found: string[] = [];
  for (const re of patterns) {
    for (const m of value.matchAll(re)) {
      const code = m[0];
      if (ALLOWED.has(code) || found.includes(code)) continue;
      found.push(code);
    }
  }
  return found;
}

/**
 * Клиентский текст слайда: то, что человек действительно прочитает.
 *
 * Список ведётся по типу `RendererSlide` (см. `deck-assembler.ts`), а не по
 * памяти. Пока полей было пять из шестнадцати, «замечаний нет» в отчёте
 * проверки не означало «в клиентском тексте кода нет»: вне проверки оставались
 * буллеты — самый содержательный текст отчёта, — все четыре поля панели
 * («что обнаружено», «почему важно», «что проверить», «источник»), статусная
 * строка, легенда, плитки, методика и фразы «Почему выделено».
 */
export interface ClientVisibleSlide {
  slideKey?: string;
  slideId?: string;
  title?: string;
  subtitle?: string;
  narrative?: string;
  bullets?: unknown;
  staticBlocks?: unknown;
  table?: { headers?: unknown; rows?: unknown; rowAddresses?: unknown } | null;
  whatWasFound?: string;
  whyItMatters?: string;
  whatToCheck?: string;
  sourceNote?: string;
  statusNote?: string;
  methodologyNote?: string;
  legend?: unknown;
  kpis?: ReadonlyArray<{ label?: unknown; value?: unknown; tone?: unknown }> | null;
  highlightExplanations?: ReadonlyArray<{ clientReason?: unknown; frameTone?: unknown }> | null;
  /**
   * Машинное поле контракта (`no-organic-data`, `VISUAL_ASSET_UNAVAILABLE`).
   *
   * Объявлено здесь, чтобы было видно, что о нём подумали, и **намеренно не
   * читается**: рендерер его не рисует вовсе (в `renderer/*.py` имя не
   * встречается), а значения там кодовые по замыслу — проверка ловила бы их
   * всегда и на каждой странице пустого состояния.
   */
  emptyStateReason?: string;
}

/** Все строки слайда, доходящие до читателя. */
export function clientVisibleStrings(slide: ClientVisibleSlide): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(push);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(push);
  };
  push(slide.title);
  push(slide.subtitle);
  push(slide.narrative);
  push(slide.bullets);
  push(slide.staticBlocks);
  push(slide.table?.headers);
  push(slide.table?.rows);
  // Адрес печатается ячейкой и попадает сюда со строками. Поле полосы
  // читается только ради старых артефактов: живого входа у него нет.
  push(slide.table?.rowAddresses);
  push(slide.whatWasFound);
  push(slide.whyItMatters);
  push(slide.whatToCheck);
  push(slide.sourceNote);
  push(slide.statusNote);
  push(slide.methodologyNote);
  push(slide.legend);
  // У составных полей берётся только клиентская часть: тон рамки и тон плитки
  // читателю не печатаются, а под правило кода подошли бы.
  for (const k of slide.kpis ?? []) {
    push(k?.label);
    push(k?.value);
  }
  for (const h of slide.highlightExplanations ?? []) push(h?.clientReason);
  return out.filter((s) => s.trim().length > 0);
}

export interface InternalCodeFinding {
  slide: string;
  code: string;
}

/**
 * Внутренние коды в клиентском тексте деки.
 *
 * Пустой список — обязательное состояние: любой найденный код это дефект
 * текста, а не предупреждение.
 */
export function scanDeckForInternalCodes(
  slides: readonly ClientVisibleSlide[]
): InternalCodeFinding[] {
  return scanDeck(slides, findInternalCodes);
}

/**
 * Внутренние идентификаторы прогона, утёкшие в клиентский текст.
 *
 * Вопрос другой, чем у `findInternalCodes`: не «наш ли это код по форме», а
 * «не уехало ли клиенту имя нашей внутренней сущности». Поэтому и разбор
 * другой — **адреса не вырезаются**. Идентификатор наблюдения умеет попасть
 * в путь напечатанной ссылки (`example.org/materials/obs-9f3a71c2/view`), и
 * именно там его никто не искал: приёмочный скрипт держал этот шаблон у себя
 * и смотрел четыре поля слайда из шестнадцати, а полосу адреса не смотрел
 * вовсе.
 *
 * Прежний разбор снимал `inventory:…` и `evidence:…` перед тем, как их же
 * искать, — альтернатива в шаблоне была мёртвой по построению.
 */
const RUN_IDENTIFIER =
  /orion-canary|cmreamy|reportRunId|datasetId|inventory:|evidence:|obs-[a-z0-9]{6,}/giu;

/** Найденные в тексте внутренние идентификаторы (без повторов). */
export function findLeakedIdentifiers(text: string | null | undefined): string[] {
  // Маркер находки — служебная связь блока с доказательной базой; до бумаги он
  // не доходит, его снимает отрисовщик.
  const value = String(text ?? "").replace(/\[?finding-[\p{L}\d_-]+\]?/gu, " ");
  const found: string[] = [];
  for (const m of value.matchAll(RUN_IDENTIFIER)) {
    if (!found.includes(m[0])) found.push(m[0]);
  }
  return found;
}

/**
 * Машинно выглядящие токены нижнего регистра в клиентском тексте.
 *
 * Замечание, а не приговор: ник в соцсети и имя набора по форме неотличимы, и
 * останавливать оплаченный отчёт на последнем шаге из-за чужой подписи нельзя
 * (решение владельца 21.08, живой прогон Кремлёва).
 */
export function scanDeckForCodeLikeTokens(
  slides: readonly ClientVisibleSlide[]
): InternalCodeFinding[] {
  return scanDeck(slides, findLowercaseCodeLikeTokens);
}

/**
 * Внутренние идентификаторы в клиентском тексте деки.
 *
 * Пустой список — обязательное состояние: `noInternalTokensInClientCopy`
 * приёмки считается по нему, и второго ответа на «что видит клиент» больше
 * нет — поля перечисляет `clientVisibleStrings`, один список на весь проект.
 */
export function scanDeckForLeakedIdentifiers(
  slides: readonly ClientVisibleSlide[]
): InternalCodeFinding[] {
  return scanDeck(slides, findLeakedIdentifiers);
}

function scanDeck(
  slides: readonly ClientVisibleSlide[],
  find: (text: string) => string[]
): InternalCodeFinding[] {
  const findings: InternalCodeFinding[] = [];
  for (const slide of slides) {
    const name = slide.slideKey ?? slide.slideId ?? "<без имени>";
    for (const text of clientVisibleStrings(slide)) {
      for (const code of find(text)) {
        findings.push({ slide: name, code });
      }
    }
  }
  return findings;
}
