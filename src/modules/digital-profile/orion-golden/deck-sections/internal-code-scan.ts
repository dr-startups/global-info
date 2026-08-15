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
 * английской прозе его не бывает.
 */
const DATASET_CODE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu;

/**
 * Строки, которые выглядят как код, но им не являются.
 *
 * Составные термины due diligence законны и в отчёте нужны.
 */
const ALLOWED = new Set<string>(["ID_CARD", "PEP_RCA"]);

/** Найденные в тексте внутренние коды (без повторов, в порядке появления). */
export function findInternalCodes(text: string | null | undefined): string[] {
  // Маркер находки — служебная связь блока с доказательной базой. Встречается
  // и в скобках в конце блока, и голым — колонкой таблицы матрицы рисков. До
  // бумаги он не доходит ни в том, ни в другом виде: в отчёте 72 строка
  // «finding-» не встречается ни разу, отрисовщик её снимает.
  const value = String(text ?? "").replace(/\[?finding-[\p{L}\d_-]+\]?/gu, " ");
  if (!value.trim()) return [];
  const found: string[] = [];
  for (const re of [INTERNAL_CODE, DATASET_CODE]) {
    for (const m of value.matchAll(re)) {
      const code = m[0];
      if (ALLOWED.has(code) || found.includes(code)) continue;
      found.push(code);
    }
  }
  return found;
}

/** Клиентский текст слайда: то, что человек действительно прочитает. */
export interface ClientVisibleSlide {
  slideKey?: string;
  slideId?: string;
  title?: string;
  subtitle?: string;
  narrative?: string;
  staticBlocks?: unknown;
  table?: { headers?: unknown; rows?: unknown } | null;
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
  push(slide.staticBlocks);
  push(slide.table?.headers);
  push(slide.table?.rows);
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
  const findings: InternalCodeFinding[] = [];
  for (const slide of slides) {
    const name = slide.slideKey ?? slide.slideId ?? "<без имени>";
    for (const text of clientVisibleStrings(slide)) {
      for (const code of findInternalCodes(text)) {
        findings.push({ slide: name, code });
      }
    }
  }
  return findings;
}
