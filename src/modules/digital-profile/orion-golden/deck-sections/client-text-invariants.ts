/**
 * Инварианты клиентского текста — проверка **готового документа** (шаг 0139).
 *
 * Дефекты клиентского текста оказались одного вида в новых местах, а не
 * разного вида. Ответ на вопрос «как печатается чужой текст в кавычках» есть
 * с начала (`quoteBody`), но зовут его не все: шаг 0131 добавил его в список
 * признаков, 0137 — в основание рамки, и нашлось третье место. Предикаты
 * цитаты полностью зовёт только `resolveExampleQuote`.
 *
 * Поверхность — около двенадцати построителей на шесть текстовых полей: любая
 * новая комбинация даёт новое место, где предикат можно забыть, и починка
 * места поверхность не уменьшает. Проверка построителя этого не видит; поэтому
 * смотрим на собранную деку и требуем свойства от **каждой** напечатанной
 * строки.
 *
 * Модуль чистый: ни сети, ни базы, ни модели.
 */

import { markupSpaceInQuotes } from "../client/client-quote";
import { looksLikeWholeStatement } from "../analytics/theme-quote";

/** Поля слайда, которые читает клиент. Таблица — своими ячейками. */
type PrintedSlide = {
  slideKey?: string;
  slideId?: string;
  title?: string;
  subtitle?: string;
  narrative?: string;
  bullets?: string[];
  whatWasFound?: string;
  whyItMatters?: string;
  whatToCheck?: string;
  statusNote?: string;
  sourceNote?: string;
  methodologyNote?: string;
  legend?: string[];
  table?: { headers?: string[]; rows?: string[][] };
};

const SCALAR_FIELDS = [
  "title",
  "subtitle",
  "narrative",
  "whatWasFound",
  "whyItMatters",
  "whatToCheck",
  "statusNote",
  "sourceNote",
  "methodologyNote",
] as const;

/**
 * Цитата с источником — то, что клиент читает как слова материала.
 *
 * Строится на каждый вызов: у глобального выражения есть `lastIndex`, и общее
 * на модуль оно однажды начнёт поиск с середины чужой строки.
 */
const sourcedQuotes = (): RegExp => /«([^»]{2,400})»\s*[—–-]\s*источник/gu;



/** Заголовок блока темы: `▪«Тема»` или `«Тема»` первой строкой блока. */
const THEME_BLOCK_RE = /^[▪\s]*«([^»]{3,80})»\s*$/u;

/**
 * Строка счёта блока — её признак один на продукт (см. `themeScaleLine`).
 *
 * Граница слова пишется просмотром вперёд, а не `\b`: в JavaScript `\b`
 * определена на ASCII, и после кириллического «теме» её нет. На этой ловушке
 * проект спотыкался уже дважды (`DANGLING_TAIL_RE`, `ATTRIBUTION_ANCHOR`).
 */
const SCALE_LINE_RE = /^(?:Всего по теме|В корпусе|По теме)(?!\p{L})/u;

/** Ввод к цитатам: после него блок обязан назвать свои числа. */
const QUOTE_INTRO_RE = /^(?:Найдены|Найдено)(?!\p{L})/u;

function fieldsOf(slide: PrintedSlide): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  for (const f of SCALAR_FIELDS) {
    const v = slide[f];
    if (typeof v === "string" && v.trim()) out.push({ field: f, text: v });
  }
  (slide.bullets ?? []).forEach((b, i) => {
    if (typeof b === "string" && b.trim()) out.push({ field: `bullets[${i}]`, text: b });
  });
  (slide.legend ?? []).forEach((b, i) => {
    if (typeof b === "string" && b.trim()) out.push({ field: `legend[${i}]`, text: b });
  });
  for (const row of slide.table?.rows ?? []) {
    row.forEach((cell, i) => {
      if (typeof cell === "string" && cell.trim()) out.push({ field: `table[${i}]`, text: cell });
    });
  }
  return out;
}

/**
 * Нарушения инвариантов на собранной деке. Пустой список — документ их
 * соблюдает; каждая строка называет слайд, поле и что именно не так.
 */
export function clientTextIssues(slides: readonly PrintedSlide[]): string[] {
  const issues: string[] = [];
  for (const slide of slides) {
    const key = slide.slideKey ?? slide.slideId ?? "(без ключа)";
    for (const { field, text } of fieldsOf(slide)) {
      const where = `${key}.${field}`;
      // 1. Кавычка в кавычке — обёртка поверх уже обёрнутого.
      if (/««|»»/u.test(text)) {
        issues.push(`${where}: кавычка в кавычке («« или »»)`);
      }
      /*
       * 2. Пробел разметки внутри кавычек — по ролям знаков, а не по глифам
       *    (шаг 0140). Глиф `“` закрывает русскую пару и открывает
       *    английскую; правило по глифу давало ложное срабатывание на
       *    правильном «„переизбрали“ себе». Ответ у ворот и у чистки один.
       */
      if (markupSpaceInQuotes(text)) {
        issues.push(`${where}: пробел внутри кавычек`);
      }
      // 3. Цитата с источником обязана быть целой фразой.
      for (const m of text.matchAll(sourcedQuotes())) {
        const quote = (m[1] ?? "").trim();
        if (!looksLikeWholeStatement(quote)) {
          issues.push(`${where}: цитата не целая фраза — «${quote.slice(0, 60)}»`);
        }
      }
      // 4. Блок темы называет свои числа.
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      const isThemeBlock = lines.length > 1 && THEME_BLOCK_RE.test(lines[0] ?? "");
      const hasIntro = lines.some((l) => QUOTE_INTRO_RE.test(l));
      if (isThemeBlock && hasIntro && !lines.some((l) => SCALE_LINE_RE.test(l))) {
        issues.push(`${where}: блок темы без строки счёта («${lines[0]}»)`);
      }
    }
  }
  return issues;
}
