/**
 * Цитата под темой показывает тему (шаг 0115) — правила, из которых она выбирается.
 *
 * Отчёт Бондарчука 19.09.2026 печатал под «Политические связи / публичная
 * экспозиция» лид Википедии, навигацию сайта о Мишустине («Председатель
 * Правительства РФ.») и заголовок интервью о «Сталинграде»; под «Деловой
 * профиль» — биографию Паулины Андреевой. Владелец: «мы должны клиенту
 * объяснять, какой именно факт/риск отражен в статье».
 *
 * Правило одно: **цитата под темой — та фраза материала, из-за которой материал
 * в теме.** Она несёт сигнал темы, она целая, и она о субъекте. Здесь лежат
 * три предиката и разбор сниппета; сам выбор (страница → сниппет → заголовок)
 * делает `resolveExampleQuote` в синтезаторе находок — его зовут и глобальное
 * утверждение, и региональная сборка, чтобы ответ был один.
 *
 * Модуль чистый: ни сети, ни БД, ни модели. Синтезатор его импортирует, поэтому
 * сам он синтезатор импортировать не может — общие с ним мелочи (висящий хвост)
 * живут здесь и реэкспортируются оттуда.
 */

import { getAdversePatterns, isAccusingTheme, type ThemeDef } from "../../config/finding-themes";
import {
  allDictionaryHitsAreSubjectContext,
  type SubjectContextMask,
} from "../../config/subject-context-words";
import { withoutSourceMarkup } from "../client/client-quote";
import { splitSentences } from "../deck-sections/sentence-split";
import {
  looksLikeCardChrome,
  looksLikeMachineDump,
  looksLikeSearchQuery,
  looksLikeSurfaceBlockHeading,
} from "./client-quote-hygiene";

/**
 * PDF-46 I.1 — JS `\b` does NOT treat Cyrillic as word chars, so «…Путина в»
 * / «…из-за» never matched. Use Unicode letter boundaries + multi-word tails.
 */
export const DANGLING_TAIL_RE =
  /(?:^|[^\p{L}\p{N}_])(?:and|or|of|the|a|an|to|for|with|from|by|over|into|onto|in|on|at|due|и|в|во|на|по|с|со|о|об|из|из-за|для|как|что|за|к|ко|у|от|до|про|при|после|перед)\s*$/iu;

/** True when a cleaned quote/title ends on a hanging preposition/conjunction. */
export function hasDanglingTail(text: string): boolean {
  return DANGLING_TAIL_RE.test(String(text ?? "").trim());
}

/**
 * Обрыв в конце: многоточие поисковика («что отрезано, неизвестно») или
 * многоточие с приклеенной ссылкой площадки «Read more» / «Читать далее» —
 * тизер страницы, который читающая модель взяла за цитату
 * («…of Art Pictures Studio Fyodor...Read more», en.russia.ru).
 */
const SERP_TRUNCATED_RE =
  /(?:\.\.\.|…)\s*(?:read\s+more|читать\s+(?:далее|дальше|полностью)|подробнее|далее)?\s*$/iu;

/** Короче этого фраза — подпись, а не предложение. */
const MIN_STATEMENT_WORDS = 4;

/** Доля кириллицы, начиная с которой фраза считается русской. */
const CYRILLIC_SHARE_RU = 0.4;

/** Слово имени, по которому его узнают в тексте: короче четырёх букв — не различает. */
const MIN_NAME_STEM = 4;

/**
 * Заголовки блоков перекрёстных ссылок: всё после них — навигация площадки, не
 * текст материала.
 *
 * Сниппет Яндекса для 2x2.su кончался «Другие биографии. Мишустин Михаил
 * Владимирович. Председатель Правительства РФ.» — и тему, и цитату материал
 * получил из этих слов. Список общий для русских и английских площадок.
 */
const CROSS_LINK_HEADING_RE =
  /^(?:другие\s+(?:биографии|новости|материалы|статьи)|читайте\s+также|смотрите\s+также|см\.\s*также|похожие\s+(?:материалы|статьи|новости)|ещё\s+по\s+теме|еще\s+по\s+теме|популярное|новости\s+партн[её]ров|read\s+(?:more|also|next)|see\s+also|related(?:\s+(?:articles|stories|news|posts))?|more\s+from)(?!\p{L})/iu;

/**
 * Дата выдачи перед сниппетом: «27 Feb 2014 — », «23 июл. 2026 г. — ».
 *
 * Это подпись поисковика, а не слова материала: в отчёте она печаталась внутри
 * кавычек («27 Nov 2025 — The Petrovsky Art Loft…»).
 */
const SERP_DATE_STAMP_RE = /^\s*\d{1,2}\s+\p{L}{3,10}\.?\s+\d{4}(?:\s*г\.)?\s*[—–-]\s+/u;

/** Голое имя: два-три слова с заглавной, кириллицей или латиницей. */
const BARE_NAME_CYR_RE = /^[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}$/u;
const BARE_NAME_LAT_RE = /^[A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+){1,2}$/u;

function normalizeForNames(text: string): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/ё/gu, "е");
}

/**
 * Основы слов имени субъекта — по ним имя узнаётся в любом падеже.
 *
 * «Бондарчук Фёдор Сергеевич» → `бондарчук`, `федор`, `сергеевич`; «Дерипаска»
 * → `дерипаск` (Дерипаски, Дерипаске); латиница — как есть, без диакритики
 * («Holmström» → `holmstrom`). Слова короче четырёх букв не различают и
 * основами не становятся.
 */
export function subjectNameStems(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    for (const token of normalizeForNames(name).split(/[^\p{L}-]+/u)) {
      if (token.length < MIN_NAME_STEM) continue;
      const stem = /^[а-я-]+$/u.test(token) ? token.replace(/[аяуюеоыи]$/u, "") : token;
      if (stem.length >= MIN_NAME_STEM) out.add(stem);
    }
  }
  return [...out];
}

/** Назван ли субъект в тексте — любой основой имени в начале слова. */
export function textNamesSubject(text: string, stems: readonly string[]): boolean {
  if (stems.length === 0) return false;
  const hay = normalizeForNames(text);
  return stems.some((stem) => new RegExp(`(?<!\\p{L})${escapeRe(stem)}`, "u").test(hay));
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function cyrillicShare(text: string): number {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (!letters) return 0;
  return letters.replace(/[^\p{Script=Cyrillic}]/gu, "").length / letters.length;
}

/** Голое имя человека — строка целиком, без хвостовой пунктуации. */
export function looksLikeBareName(text: string): boolean {
  const t = String(text ?? "")
    .replace(/^[«"„(]+|[»"“).!?]+$/gu, "")
    .trim()
    // Анкетная форма с запятой: «Дуров, Павел Валерьевич».
    .replace(/^([А-ЯЁ][а-яё]+),\s+/u, "$1 ");
  return BARE_NAME_CYR_RE.test(t) || BARE_NAME_LAT_RE.test(t);
}

/**
 * Целая ли это фраза, а не подпись, обрывок или выгрузка.
 *
 * Не короче четырёх слов: «Владелец ИП.», «Семья и дети.», «Председатель
 * Правительства РФ.» — подписи полей и навигации, из них читатель не узнаёт
 * ничего. У русской фразы есть слово с маленькой буквы — у подписи из одних
 * заглавных его нет (заголовки латиницей набирают с заглавных, к ним правило
 * не относится; текст без строчных вовсе — капслок — тоже). Начинается не с
 * маленькой буквы — иначе это середина предложения. Без запятой и двоеточия в
 * конце, без висящего предлога, без обрыва в конце (многоточие поисковика,
 * «...Read more»).
 */
export function looksLikeWholeStatement(text: string): boolean {
  const t = withoutSourceMarkup(String(text ?? "")).replace(/\s+/gu, " ").trim();
  if (!t) return false;
  // Фраза с маленькой буквы — середина предложения: читающая модель взяла
  // цитату не с начала («producer, actor, founder and co-founder of…»).
  if (/^[«"„(]*\p{Ll}/u.test(t)) return false;
  if (/[,;:]$/u.test(t)) return false;
  if (SERP_TRUNCATED_RE.test(t)) return false;
  if (hasDanglingTail(t)) return false;
  if (
    looksLikeMachineDump(t) ||
    looksLikeCardChrome(t) ||
    looksLikeSearchQuery(t) ||
    looksLikeSurfaceBlockHeading(t)
  ) {
    return false;
  }
  const words = t.split(" ").filter((w) => /\p{L}/u.test(w));
  if (words.length < MIN_STATEMENT_WORDS) return false;
  if (cyrillicShare(t) >= CYRILLIC_SHARE_RU && /\p{Ll}/u.test(t)) {
    const hasLowerWord = words.some((w) => /^\p{Ll}{3,}/u.test(w.replace(/^[«"„(]+/u, "")));
    if (!hasLowerWord) return false;
  }
  return true;
}

/**
 * Называет ли заголовок другого человека вместо субъекта.
 *
 * «Paulina Andreeva - Biography - IMDb» стояла цитатой делового профиля
 * Бондарчука: в теме материал оказался по слову «Biography», а заголовок — о
 * его жене. Признак — голое имя в одном из сегментов заголовка (до тире, до
 * вертикальной черты), не содержащее основы имени субъекта. Имён субъекта нет
 * — судить не по чему, заголовок остаётся.
 *
 * Последний сегмент заголовка из двух и более — подпись издания, и она тоже
 * бывает двумя словами с заглавной: «… - Highways Today», «… - Аргументы
 * Недели» (эталон-72). Человек в заголовке стоит впереди, издание — сзади;
 * хвост не судится.
 */
export function titleNamesAnotherPerson(title: string, stems: readonly string[]): boolean {
  if (stems.length === 0) return false;
  const segments = String(title ?? "")
    .split(/\s+[-–—|·]\s+|:\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const judged = segments.length >= 2 ? segments.slice(0, -1) : segments;
  return judged.some((s) => looksLikeBareName(s) && !textNamesSubject(s, stems));
}

export type SnippetSentence = {
  text: string;
  /** О субъекте ли фраза — или о человеке, чьё голое имя стояло перед ней. */
  aboutSubject: boolean;
  /** Последнее предложение сниппета, обрезанного поисковиком. */
  truncated: boolean;
};

/**
 * Предложения сниппета с пометкой, о ком они.
 *
 * Сниппет — о субъекте, пока в нём не встретилось голое имя другого человека:
 * после него до следующего упоминания субъекта идут чужие строки (навигация
 * «Другие биографии. Мишустин Михаил Владимирович. Председатель Правительства
 * РФ.»). Заголовок блока перекрёстных ссылок кончает текст материала вовсе.
 * Дата выдачи в начале снимается: она не слова материала.
 */
export function snippetSentencesAboutSubject(
  snippet: string | undefined,
  stems: readonly string[]
): SnippetSentence[] {
  const flat = String(snippet ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(SERP_DATE_STAMP_RE, "");
  if (!flat) return [];
  const truncatedTail = SERP_TRUNCATED_RE.test(flat);
  const sentences = splitSentences(flat);
  const out: SnippetSentence[] = [];
  let about = true;
  for (const [i, raw] of sentences.entries()) {
    const text = raw.trim();
    if (!text) continue;
    if (CROSS_LINK_HEADING_RE.test(text)) break;
    // Имён субъекта нет — голое имя судить не по чему, и сниппет остаётся о
    // субъекте: правило молчит, а не выключает всё после первого имени.
    if (looksLikeBareName(text)) {
      if (stems.length > 0) about = textNamesSubject(text, stems);
    } else if (textNamesSubject(text, stems)) {
      about = true;
    }
    out.push({
      text,
      aboutSubject: about,
      truncated: truncatedTail && i === sentences.length - 1,
    });
  }
  return out;
}

/**
 * Текст материала о субъекте — то, что читает словарь темы и из чего берётся
 * цитата: заголовок и предложения сниппета, которые о нём.
 */
export function subjectMaterialText(
  title: string | undefined,
  snippet: string | undefined,
  stems: readonly string[]
): string {
  const own = snippetSentencesAboutSubject(snippet, stems)
    .filter((s) => s.aboutSubject)
    .map((s) => s.text);
  return [String(title ?? "").trim(), ...own].filter(Boolean).join(" ");
}

/**
 * Несёт ли текст сигнал темы — не считая слов, которыми написан сам субъект.
 *
 * Слово «Судьи» в заголовке профиля на портале о судьях совпадает с темой
 * «Криминальные / судебные материалы», но о материале не говорит ничего: это
 * должность субъекта (`config/subject-context-words.ts`).
 *
 * У обвиняющей темы сигналом служит и слово негатива: криминальный сюжет
 * пишут словами обвинения, не только словами суда. Описательная тема
 * («Политические связи», «Деловой профиль», «Корпоративное владение»)
 * показывается только своими словами — негатив о ней ничего не говорит.
 */
export function carriesThemeSignal(
  text: string,
  theme: ThemeDef,
  subjectContext?: SubjectContextMask | null
): boolean {
  const value = String(text ?? "");
  if (!value.trim()) return false;
  if (theme.keywords.test(value)) {
    if (!allDictionaryHitsAreSubjectContext(value, theme.keywords, subjectContext)) return true;
  }
  if (!isAccusingTheme(theme)) return false;
  const adverse = getAdversePatterns();
  return (
    adverse.test(value) && !allDictionaryHitsAreSubjectContext(value, adverse, subjectContext)
  );
}
