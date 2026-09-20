/**
 * Prompt 2 — cross-surface finding synthesizer.
 * Consumes composite items + subject resolution + surface analyses and
 * produces an actual VerifiedFindingBundle. Includes contradiction
 * detection, limitations, promotion priorities and exclusion reasons.
 * The same evidence never spawns multiple findings (theme assignment is
 * exclusive, priority-ordered).
 */

import { createHash } from "node:crypto";
import {
  clientSafeDomains,
} from "../../services/composite-serp-merge";
import { pickDistinctTitles } from "./distinct-stories";
import type { RawInventoryItem } from "../types";
import type { RiskLevel } from "../contracts/common";
import {
  FINDING_SCHEMA_VERSION,
  FindingSchema,
  type Finding,
  type FindingContradiction,
  type PromotionPriority,
} from "../contracts/finding";
import {
  VERIFIED_FINDING_BUNDLE_SCHEMA_VERSION,
  VerifiedFindingBundleSchema,
  type VerifiedFindingBundle,
} from "../contracts/verified-finding-bundle";
import type { SubjectResolutionItem } from "../contracts/subject-resolution";
import {
  getFindingThemes,
  isAccusingTheme,
  resolveFindingThemesConfig,
  type ThemeDef,
} from "../../config/finding-themes";
import { domainOf } from "./composite-dataset-builder";
import { mapRegionBucket, mapSurfaceBucket } from "../classic/composite-serp-overlay-merge";
import {
  cutGluedChrome,
  looksLikeCardChrome,
  looksLikeMachineDump,
  looksLikeSearchQuery,
  looksLikeSurfaceBlockHeading,
  looksLikeUiCallToAction,
  pageQuoteForClient,
} from "./client-quote-hygiene";
import { dictionaryHitIsNegated } from "../../config/negated-dictionary-hit";
import { sourceAttribution } from "../client/client-address";
import { sourceQuote } from "../client/client-quote";
import { readableSnippet, resolveItemAdverse, resolveItemReadFavourably } from "./item-adverse";
import {
  allDictionaryHitsAreSubjectContext,
  buildSubjectContextMask,
  type SubjectContextMask,
} from "../../config/subject-context-words";
import type { SubjectAnchors } from "./subject-anchors";
import type {
  ObservationVerdict,
  ObservationVerdictByRef,
} from "../../serp-observation/resolve-observation-highlights";
import { pluralRu } from "../../report/i18n/plural-ru";
import {
  carriesThemeSignal,
  DANGLING_TAIL_RE,
  hasDanglingTail,
  looksLikeBareName,
  looksLikeGeneralization,
  looksLikeIdentityLead,
  looksLikePlatformNavigation,
  looksLikeWholeStatement,
  snippetSentencesAboutSubject,
  subjectMaterialText,
  subjectNameStems,
  textNamesSubject,
  titleNamesAnotherPerson,
} from "./theme-quote";

export { hasDanglingTail } from "./theme-quote";

export type { ThemeDef };

/**
 * Live view of configured themes (REMEDIATION §3.1). Prefer getFindingThemes().
 * Proxy keeps `.find` / `.filter` / indexing working for existing call sites.
 */
export const FINDING_THEMES: ThemeDef[] = new Proxy([] as ThemeDef[], {
  get(_target, prop, receiver) {
    const themes = getFindingThemes();
    if (prop === "length") return themes.length;
    if (typeof prop === "string" && /^\d+$/.test(prop)) return themes[Number(prop)];
    const value = Reflect.get(themes, prop, receiver);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(themes) : value;
  },
});

/** REMEDIATION §3.2 — SUBJECT_MATCH/LIKELY with no theme keyword hit. */
export type UncategorizedMaterial = {
  evidenceRef: string;
  title: string;
  domain: string;
  region: string;
  subjectMatch: "SUBJECT_MATCH" | "LIKELY_SUBJECT";
};

export type UncategorizedMaterialsBlock = {
  version: "uncategorized-materials-v1";
  count: number;
  subjectMatchCount: number;
  likelySubjectCount: number;
  /** Global top-N examples (titles + refs) for operators / LLM theming (3.3). */
  topExamples: UncategorizedMaterial[];
  /** Full ref list (not capped) for §3.3 verification. */
  allEvidenceRefs: string[];
  byRegion: Record<
    string,
    {
      count: number;
      /**
       * Из них подтверждённых. Поле заведено отдельно, потому что строка
       * региона обещает материалы **о субъекте**, а вероятные к ним не
       * относятся: на листе ОАЭ отчёта 85 стояло «Другие материалы о субъекте:
       * 84» при четырёх подтверждённых. Прежние артефакты поля не несут — тогда
       * строка не печатается вовсе, а не печатает смешанное число.
       */
      subjectMatchCount?: number;
      examples: UncategorizedMaterial[];
    }
  >;
};

export type FindingSynthesisResult = {
  bundle: VerifiedFindingBundle;
  ambiguousFindings: Finding[];
  /** evidenceRef -> all themeIds the evidence supports (shared provenance). */
  themeAssignments: Map<string, string[]>;
  /** Not a finding — visible in regional summary only (§3.2). */
  uncategorized: UncategorizedMaterialsBlock;
  stats: {
    subjectMatchEvidence: number;
    likelySubjectEvidence: number;
    ambiguousEvidence: number;
    otherSubjectEvidence: number;
    adverseFindingCount: number;
    uncategorizedCount: number;
  };
};

const UNCATEGORIZED_TOP_N = 12;
const UNCATEGORIZED_PER_REGION_N = 8;

function refOf(item: RawInventoryItem): string {
  return `inventory:${item.inventoryId}`;
}

/**
 * Материал глазами словаря темы: заголовок и сниппет, как у предиката строки —
 * но только те предложения сниппета, что о субъекте.
 *
 * Служебный `classification` сюда не входит по той же причине, по какой он не
 * входит в ответ «негативен ли материал»: у строк выдачи он записан самим
 * предикатом негатива, а у остальных — четвёртым словарём. Адреса нет вовсе:
 * у словаря есть левая граница и нет правой, поэтому раздел сайта в пути
 * (`…/court/…`, `…/investigations/…`) читался как текст публикации и давал
 * нейтральному заголовку криминальную тему.
 *
 * Сниппет читается тем же разбором, из которого берётся цитата
 * (`snippetSentencesAboutSubject`, шаг 0115): после голого имени другого
 * человека и после заголовка перекрёстных ссылок идёт навигация площадки.
 * Материал 2x2.su получал политическую тему из «Другие биографии. Мишустин
 * Михаил Владимирович. Председатель Правительства РФ.» — и её же цитировал.
 * Текст, который даёт тему, и текст, из которого берётся цитата, — один.
 */
function themeMatchText(item: RawInventoryItem, stems: readonly string[]): string {
  return subjectMaterialText(item.title, readableSnippet(item), stems);
}

/**
 * Материал глазами словарей качества утверждения.
 *
 * Адрес здесь остаётся намеренно, и это не то же, что тема материала: у
 * `positivePatterns` доменное слово стоит прямо в списке (`forbes`), и читать
 * им адрес — способ, которым они работают. У темы иначе: её площадки вынесены
 * в собственный список (`ThemeDef.domains`), и словарь темы адреса не видит.
 * Сниппет здесь целиком: словари качества ищут «potential match» и «не
 * подтверждено», и навигация площадки им не мешает.
 */
function itemText(item: RawInventoryItem): string {
  return [item.title, readableSnippet(item), item.classification, item.sourceUrl]
    .filter(Boolean)
    .join(" ");
}

/**
 * PDF-40 G.2b — short framing lead (what was found). The concrete meaning
 * comes from quoted headlines + domains, not from these templates alone.
 */
const CLIENT_THEME_FRAMING: Record<string, string> = {
  criminal_legal:
    "Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами",
  pep_rca_watchlist:
    "Найдены материалы, связывающие субъекта с санкционными и мониторинговыми списками (PEP/RCA)",
  political_exposure:
    "Найдены материалы о политической и публичной экспозиции субъекта",
  offshore_structures:
    "Найдены публикации об офшорных структурах и юрисдикциях с особым режимом",
  corporate_ownership:
    "Найдены материалы о владении компаниями и структуре собственности",
  family_associates:
    "Найдены материалы о семейных и деловых связях субъекта",
  financial_claims:
    "Найдены публикации о финансовых претензиях и долговых спорах",
  business_profile: "Найдены материалы делового и биографического профиля",
  security_scrutiny:
    "Найдены материалы с акцентом на безопасность и оборонный контур",
};

/**
 * Пояснение «почему это важно» — шаблонная присказка темы.
 *
 * Экспортируется, потому что сборщик деки вычищает повторы только по объявленным
 * присказкам ([[boilerplate-commentary]]): всё, чего нет в таком списке,
 * неприкосновенно. Раньше вычистка сравнивала предложения вслепую и снимала
 * цитаты вместе с источниками.
 */
export const CLIENT_THEME_WHY: Record<string, string> = {
  criminal_legal:
    "Для банка или партнёра такие сюжеты обычно становятся первым поводом для расширенной проверки.",
  pep_rca_watchlist:
    "Банки и комплаенс-команды отрабатывают такие сигналы в первую очередь при KYC.",
  political_exposure:
    "Это усиливает вопросы к связям, влиянию и приемлемости контрагента для сделки.",
  offshore_structures:
    "Для KYC это типичный запрос на раскрытие бенефициаров и источников контроля.",
  corporate_ownership:
    "Само по себе владение компаниями претензией не является, но состав долей и историю сделок обычно просят подтвердить документами.",
  family_associates:
    "Риск в том, что негатив вокруг связанных лиц переносится на профиль проверяемого.",
  financial_claims:
    "Банки и инвесторы обычно запрашивают статус обязательств и судебные справки.",
  business_profile:
    "Деловой фон важен для позиционирования, но сам по себе не перекрывает чувствительные темы риска.",
  security_scrutiny:
    "Для международных проверок это зона повышенного внимания.",
};

/**
 * Присказка темы по её идентификатору — с ответом для темы, которой в
 * справочнике нет (файл переопределения вправе завести свою).
 *
 * Спрашивают её двое: глобальное утверждение и региональная пересборка блока
 * темы. Пока второй отбирал присказку регулярным выражением по первому слову
 * строки, две записи из восьми под перечень начал не подходили — «Для KYC…» и
 * «Для международных проверок…», — и страница офшоров у банка оставалась без
 * единственного предложения о том, зачем ей эта тема.
 */
export function clientThemeWhy(themeId: string | undefined): string {
  return (
    (themeId ? CLIENT_THEME_WHY[themeId] : undefined) ??
    "Для банка, инвестора или контрагента это сигнал к углублённой проверке."
  );
}

/** Охват глобального утверждения: весь корпус отчёта. */
export const REPORT_SCOPE_WORDS = "по отчёту";

/**
 * Строка счёта темы — одна формулировка на отчёт.
 *
 * Её печатают и глобальное утверждение (по всему корпусу темы), и региональная
 * страница (по материалам своего региона). Единица счёта у них разная, а
 * предложение обязано быть одним: соседние листы одного раздела, называющие
 * одно и то же двумя разными фразами, читаются как разные сущности.
 */
export function themeScaleLine(count: number, adverseCount: number, scope?: string): string {
  const total = pluralRu(count, "материал", "материала", "материалов");
  /*
   * Охват стоит рядом с числом (шаг 0133).
   *
   * Стр. 9 отчёта Мордашова 20.09.2026: «Корпоративное владение. Всего по
   * теме: 39 материалов». Стр. 15, та же тема: «Всего по теме: 31 материал».
   * Оба числа верны — матрица считает по отчёту, региональная страница по
   * своему региону, — но охват не назван ни там, ни там, и читатель видит
   * спор. Форма предложения остаётся одной: меняется не она, а то, что в ней
   * сказано.
   *
   * Охват необязателен: артефакт прошлого прогона его не несёт, и строка у
   * него остаётся прежней.
   */
  const where = scope ? ` ${scope}` : "";
  return adverseCount > 0
    ? `Всего по теме: ${count} ${total}${where}, с негативным контекстом — ${adverseCount}.`
    : `Всего по теме: ${count} ${total}${where}.`;
}

/**
 * Чего в выдаче не выделено, когда цитаты нет: сути риска у темы риска, сути
 * темы у описательной. Строку печатают и глобальное утверждение, и
 * региональная сборка — слово одно на обоих.
 */
export function themeEssenceWord(theme: ThemeDef | undefined): string {
  return theme && theme.baseRisk === "none" ? "темы" : "риска";
}

/**
 * Пример-свидетельство для клиентского текста.
 *
 * `url` рядом с доменом — не дублирование: источник называется полным адресом
 * («источник (msk1.ru/text/world/2026/02/02/76244926)»), а домен остаётся
 * запасным ответом для материала, у которого адреса нет вовсе.
 */
export type ClaimEvidenceExample = {
  title: string;
  domain: string;
  url?: string;
  /** Откуда фраза: прочитанная страница, предложение сниппета или заголовок (шаг 0115). */
  source?: "page" | "snippet" | "title";
  /**
   * Фраза длиннее бюджета ужата по границе оборота и закрыта нашим многоточием.
   * Признак нужен сборке утверждения: чистка заголовка снимала бы многоточие, и
   * обрывок печатался бы как целая фраза («На выборах он был единственным»).
   */
  truncated?: boolean;
};

const SERP_TRUNCATED_RE = /(?:\.\.\.|…)\s*$/u;
const BIO_SEO_RE = /биограф(?:ия|ии)?|личная жизнь|фото|новости|карьера|wiki(?:pedia)?/iu;
const STRONG_DOMAIN_RE =
  /reuters\.|nytimes\.|justice\.gov|treasury\.gov|ofac\.|europa\.eu|bbc\.|theguardian\.|kommersant\.|rbc\.ru|vedomosti\.|cnbc\.|ft\.com|wsj\.|bloomberg\./iu;

/**
 * Несёт ли тема риск — то есть может ли SEO-биография быть её доказательством.
 *
 * Список идентификаторов рядом с кодом отвечал на этот вопрос вторым голосом и
 * перечислял ровно все темы, кроме делового профиля, — то есть все, у которых
 * уровень не нулевой. Список при этом не видел тем из файла переопределения, а
 * каталог видит: признак живёт там же, где сама тема.
 */
function themeCarriesRisk(theme: ThemeDef): boolean {
  return theme.baseRisk !== "none";
}

/** True for titles that are only a person name (no risk essence). */
function looksLikeBarePersonName(title: string): boolean {
  let t = title.replace(/^[«"]|[»"]$/gu, "").trim();
  // Topic / hub pages: «Given Family - The New York Times»
  t = t.replace(/\s*[-–—]\s*(?:The\s+)?New\s+York\s+Times\s*$/iu, "").trim();
  t = t.replace(/\s*[-–—]\s*[A-Za-z0-9.-]+\.[a-z]{2,}\s*$/iu, "").trim();
  // Инвертированная справочная форма: «Дуров, Павел Валерьевич» — то же голое
  // имя, что и «Павел Валерьевич Дуров», только с запятой (шаг 13, C3).
  t = t.replace(/^([А-ЯЁ][а-яё]+),\s+/u, "$1 ").trim();
  if (/[0-9:/]/u.test(t) || BIO_SEO_RE.test(t)) return false;
  // Latin: Given F. Family / Given Family
  if (/^[A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+){1,2}$/u.test(t)) return true;
  // Cyrillic FIO only: Имя Фамилия / Имя Отчество Фамилия
  if (/^[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}$/u.test(t)) return true;
  return false;
}

/**
 * Определительная фраза: «<Имя> — <кто это>».
 *
 * Энциклопедический зачин отвечает на вопрос «кто это», а не «что произошло»:
 *
 *     «Павел Валерьевич Дуров — российский предприниматель в сфере
 *      информационных технологий, основатель социальной сети "ВКонтакте"»
 *
 * На живом прогоне эта фраза стояла доказательством темы «Офшоры и финансовая
 * прозрачность» под утверждением «Найдены публикации об офшорных и
 * корпоративных структурах владения». Утверждение ложное и опасное: клиент
 * показывает такой отчёт банку (шаг 15, E6).
 *
 * Признак — именно **зачин**: до тире стоит голое имя. Суффикс источника
 * («… — WSJ», «… - The Moscow Times») под правило не подпадает, потому что до
 * тире там целый заголовок, а не имя.
 */
export function looksLikeEncyclopedicLead(title: string): boolean {
  const t = String(title ?? "").replace(/^[«"]|[»"]$/gu, "").trim();
  const m = /^(.{3,80}?)\s+[—–]\s+(.{10,})$/u.exec(t);
  if (!m) return false;
  const [, head, tail] = m;
  // До тире — голое имя; после — описание, а не событие.
  return looksLikeBarePersonName(head!) && /[а-яёa-z]/u.test(tail!);
}

/**
 * PDF-48 — reject client quotes that are clearly mid-cut:
 * «…Фамилии,», unbalanced `"…`, subordinate clause without an end.
 */
export function isIncompleteClientQuote(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t || t.length < 12) return true;
  if (/[,;:]$/u.test(t)) return true;
  if (hasDanglingTail(t)) return true;
  if (((t.match(/"/g) ?? []).length) % 2 === 1) return true;
  // Leading subordinate clause that never finishes (provider-truncated snippet).
  if (
    /^(После|Before|After|When|While|During|Согласно|По данным)\b/iu.test(t) &&
    !/[.!?]$/u.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Turn a provider-truncated snippet into a closed headline (no trailing comma/…).
 * e.g. «После публикации расследования ФБК … Фамилии, ...» →
 * «Расследование ФБК об отдыхе … Фамилии».
 */
export function snippetToClientHeadline(snippet: string): string {
  let s = String(snippet ?? "").replace(/\s+/gu, " ").trim();
  s = s.replace(/\s*(?:\.\.\.|…)\s*$/u, "").trim();
  s = s.replace(/[,;:]\s*$/u, "").trim();
  s = s.replace(/^После публикации\s+/iu, "").trim();
  s = s.replace(/^After (?:the )?publication of\s+/iu, "").trim();
  // JS `\b` is ASCII-only — use Unicode letter lookahead for Cyrillic stems.
  s = s.replace(/^расследования(?=$|[^\p{L}])/iu, "Расследование");
  s = s.replace(/^расследование(?=$|[^\p{L}])/iu, "Расследование");
  if (!s) return "";
  s = s.charAt(0).toLocaleUpperCase("ru-RU") + s.slice(1);
  if (s.length < 24 || hasDanglingTail(s) || /[,;:]$/u.test(s)) return "";
  // Headline noun-phrases are allowed; unfinished «После…» clauses are not.
  if (/^(После|Before|After|When|While)\b/iu.test(s) && !/[.!?]$/u.test(s)) return "";
  return s;
}

/**
 * Cap a quote for a bullet line. PDF-45/46/48: prefer the WHOLE title;
 * if over budget or incomplete / dangling / SERP-truncated, return "".
 * Never publish «…visa over» / «…из-за» / «…Фамилии,».
 */
export function quoteForClaim(title: string, budget = 220): string {
  /*
   * Многоточие посреди заголовка — тот же обрыв, что и в конце.
   *
   * Поисковик режет заголовок и приклеивает подпись издания: «Геннадий
   * Тимченко: биография предпринимателя... - Новости Mail». Признак обрыва
   * ловил многоточие только в конце строки, и такой заголовок проходил как
   * целый — в отчёте 75 он стоял в резюме для руководства и в матрице рисков.
   * Всё, что идёт после многоточия, — подпись, а не содержание: отрезаем её и
   * дальше разбираем строку как обычный обрезанный заголовок.
   */
  const raw = String(title ?? "")
    .trim()
    .replace(/(\.\.\.|…)\s*[-–—|·]\s*[^-–—|·]{1,40}$/u, "$1");
  const t = cleanExampleTitle(raw);
  if (!t || t.length < 12 || hasDanglingTail(t) || isIncompleteClientQuote(t)) return "";
  // Навигация площадки остаётся навигацией и после снятия хвоста издания:
  // «Биография · Образование · ДП о персоне.» укорачивалось до двух слов меню
  // и печаталось цитатой (шаг 0121).
  if (looksLikePlatformNavigation(t) || looksLikePlatformNavigation(raw)) return "";
  // Кнопка сервиса и интерфейс карточки — не слова источника: «Проверьте
  // физлицо и исключите риски долгов», «Индивидуальный предприниматель 1
  // Показать историю.» (шаг 0121).
  if (looksLikeUiCallToAction(t) || looksLikeCardChrome(t)) return "";
  // Идентификаторы наборов данных — не слова источника: «…источники:
  // ext_gb_coh_psc, us_trade_csl, eu_fsf» стояло в отчёте цитатой трижды.
  if (looksLikeMachineDump(t)) return "";
  // SERP «…» titles: keep only when clean recovered a complete sentence.
  if (SERP_TRUNCATED_RE.test(raw) && !/[.!?»]$/u.test(t)) return "";
  // Многоточие уцелело внутри строки после чистки — заголовок разорван так,
  // что целого предложения из него не собрать.
  if (/(\.\.\.|…)/u.test(t)) return "";
  if (t.length <= budget) return t;
  const slice = t.slice(0, budget);
  const cut = Math.max(
    slice.lastIndexOf(": "),
    slice.lastIndexOf(". "),
    slice.lastIndexOf(" — "),
    slice.lastIndexOf(" – ")
  );
  // Do NOT cut on ", " — that produces «…Фамилии,» stubs.
  if (cut < budget * 0.55) return "";
  let body = slice.slice(0, cut).trim().replace(/[\s,;:.—–-]+$/u, "").trim();
  if (hasDanglingTail(body)) {
    body = body.replace(DANGLING_TAIL_RE, "").trim().replace(/[\s,;:.—–-]+$/u, "");
  }
  if (!body || body.length < 24 || hasDanglingTail(body) || isIncompleteClientQuote(body)) {
    return "";
  }
  return `${body}…`;
}

/**
 * PDF-44 H.1 — reject bare FIO / SEO-bio / truncated SERP titles that hide risk essence.
 */
export function isWeakExampleTitle(
  title: string,
  opts?: { theme?: ThemeDef }
): boolean {
  const raw = String(title ?? "");
  const t = cleanExampleTitle(raw);
  if (!t || t.length < 12) return true;
  if (/^potential\s+match$/i.test(t) || /^потенциальное совпадение$/i.test(t)) return true;
  if (hasDanglingTail(t) || isIncompleteClientQuote(t)) return true;
  // Строка автодополнения — не публикация: у неё нет ни автора, ни адреса.
  // Правило стояло в композиторе резюме, но приложение строится другим путём, и
  // на живом прогоне «дуров суд сегодня» попало в приложение как доказательство
  // криминальной темы (шаг 15, E5).
  if (looksLikeSearchQuery(t)) return true;
  // Подпись служебного блока выдачи («Картинки по запросу "…"») повторяет
  // запрос и ничего не утверждает: цитировать её как материал нельзя.
  if (looksLikeSurfaceBlockHeading(t)) return true;
  // PDF-46 I.1 — provider-truncated SERP «…»: weak unless a full sentence remains.
  if (SERP_TRUNCATED_RE.test(raw.trim()) && !/[.!?»]$/u.test(t)) return true;

  const themeHit = opts?.theme ? opts.theme.keywords.test(t) : false;

  // Bare / near-bare person name: «Given F. Family», «Имя Фамилия».
  if (!themeHit && looksLikeBarePersonName(t)) {
    return true;
  }

  // SEO biography blurbs as the only “evidence” for an adverse theme.
  if (opts?.theme && themeCarriesRisk(opts.theme) && BIO_SEO_RE.test(t) && !themeHit) {
    return true;
  }

  // Энциклопедический зачин («<Имя> — российский предприниматель…») отвечает
  // на вопрос «кто это», а не «что произошло», и доказательством темы риска
  // быть не может (шаг 15, E6).
  if (opts?.theme && themeCarriesRisk(opts.theme) && !themeHit) {
    if (looksLikeEncyclopedicLead(t)) return true;
  }

  return false;
}

/**
 * PDF-44 H.1 — rank evidence for client quotes (theme hit in title beats snippet-only).
 *
 * Негативность приходит признаком, а не считается здесь заново: её уже
 * посчитал тот, кто собирает находку, — и посчитал с вердиктом прочитанной
 * страницы, которого у ранжировщика нет.
 */
export function scoreExampleForTheme(
  item: RawInventoryItem,
  theme: ThemeDef,
  /**
   * Негативен ли материал. Обязателен намеренно: со значением по умолчанию
   * вызов из двух аргументов молча означал бы «не негатив», а раньше он
   * означал «спроси словарь».
   */
  adverse: boolean
): number {
  const title = cleanExampleTitle(String(item.title ?? ""));
  const snippet = String(item.snippet ?? "").trim();
  const domain = domainOf(item.sourceUrl);
  let score = 0;
  if (theme.keywords.test(title)) score += 8;
  else if (snippet && theme.keywords.test(snippet)) score += 3;
  // Пол-ступени сверх целой шкалы: негативный материал выигрывает у равного по
  // прочим признакам и у того, кто на две ступени выше по длине заголовка, но
  // совпадению темы в заголовке (восемь ступеней) не перечит.
  if (adverse) score += 2.5;
  const tokens = title.split(/\s+/u).filter(Boolean).length;
  if (tokens >= 6) score += 2;
  else if (tokens >= 4) score += 1;
  if (title.length >= 40) score += 1;
  if (STRONG_DOMAIN_RE.test(domain)) score += 1;
  const rawTitle = String(item.title ?? "");
  if (isWeakExampleTitle(rawTitle, { theme }) || isWeakExampleTitle(title, { theme })) {
    // PDF-47 — SERP «…» title that still names the risk theme is recoverable
    // via snippet; do not bury it under bare-FIO penalty.
    if (SERP_TRUNCATED_RE.test(rawTitle.trim()) && theme.keywords.test(rawTitle)) score -= 3;
    else score -= 12;
  }
  if (!title && snippet.length >= 40) score += 1;
  return score;
}

/**
 * Поверхности, у которых нет заголовка публикации.
 *
 * ИИ-ответ, поисковая подсказка и связанный запрос — не статьи: цитировать у
 * них нечего. В поле `title` лежит служебная строка поверхности, и когда она
 * шла в доказательства наравне с заголовками, в отчёт попадали строки вида
 * «AI overview: Имя Фамилия and Компания (RU) #3» — как будто это найденная
 * публикация о субъекте.
 *
 * Тема при этом не пропадает: без цитат утверждение собирается по числу
 * материалов и доменам, а сами поверхности показываются в своих разделах.
 */
const NON_QUOTABLE_EVIDENCE_TYPES = new Set([
  "ai_answer",
  "suggestion",
  "related_query",
  /*
   * Проверка Википедии — наш результат, а не публикация.
   *
   * У записи без статьи заголовок собираем мы сами: «Wikipedia (en): статья не
   * найдена». В отчётах 73 и 75 эта строка стояла в кавычках доказательством
   * темы «Деловой профиль» — отсутствие статьи предъявлялось как найденный
   * материал.
   */
  "wikipedia_check",
]);

/** Бюджет одной цитаты в строке блока темы. */
const CLAIM_QUOTE_BUDGET = 220;

/** Короче этого ужатая фраза не несёт мысли. */
const MIN_FITTED_QUOTE_CHARS = 40;

/**
 * Что нужно знать о материале сверх его текста, чтобы выбрать цитату (шаг 0115).
 */
export type ExampleQuoteContext = {
  /**
   * Написания имени субъекта (`subjectNameVariants`): по ним фраза узнаётся
   * как фраза о нём, а заголовок — как заголовок о другом человеке. Без имён
   * оба правила молчат.
   */
  subjectNames?: readonly string[];
  /** Решение по прочитанной странице материала — с её дословными цитатами. */
  verdict?: ObservationVerdict;
};

/** Материал так, как его видит выбор цитаты: у региональной сборки нет всей записи. */
export type QuotableMaterial = Pick<
  RawInventoryItem,
  "title" | "snippet" | "sourceUrl" | "evidenceType"
>;

const STEMS_CACHE = new WeakMap<readonly string[], string[]>();

/** Основы имени — один раз на список имён: их спрашивают по каждому материалу темы. */
function stemsOf(names: readonly string[] | undefined): string[] {
  if (!names || names.length === 0) return [];
  let stems = STEMS_CACHE.get(names);
  if (!stems) {
    stems = subjectNameStems(names);
    STEMS_CACHE.set(names, stems);
  }
  return stems;
}

/**
 * Предложение длиннее бюджета — ужимается по границе оборота и закрывается
 * многоточием.
 *
 * Правилу «целое или ничего» это не противоречит: многоточие поисковика значит
 * «неизвестно, что отрезано», а наше — «фраза продолжается, адрес рядом».
 * Признак `truncated` едет вместе с фразой: сборка утверждения не чистит её
 * как заголовок и не снимает наше многоточие.
 */
function fitSentence(text: string, budget: number): { text: string; truncated: boolean } | null {
  if (text.length <= budget) return { text, truncated: false };
  const slice = text.slice(0, budget - 1);
  const clause = Math.max(
    slice.lastIndexOf(", "),
    slice.lastIndexOf("; "),
    slice.lastIndexOf(" — "),
    slice.lastIndexOf(" – "),
    slice.lastIndexOf(": ")
  );
  const at = clause >= budget * 0.55 ? clause : slice.lastIndexOf(" ");
  let cut = slice.slice(0, at).replace(/[\s,;:—–-]+$/u, "").trim();
  if (hasDanglingTail(cut)) cut = cut.replace(DANGLING_TAIL_RE, "").trim().replace(/[\s,;:—–-]+$/u, "");
  if (cut.length < MIN_FITTED_QUOTE_CHARS || hasDanglingTail(cut)) return null;
  return { text: `${cut}…`, truncated: true };
}

/**
 * Цитата материала под темой — фраза, из-за которой материал в теме (шаг 0115).
 *
 * Отчёт Бондарчука 19.09.2026 печатал под «Политические связи / публичная
 * экспозиция» лид Википедии, навигацию сайта о Мишустине и заголовок интервью
 * о «Сталинграде»; под «Деловой профиль» — биографию его жены. На вопрос
 * «какой фразой показать тему» отчёт отвечал в двух местах и в обоих не на
 * него: региональная сборка брала первую цитату страницы, а это фрагмент
 * принадлежности (имя рядом с признаком, то есть лид); глобальное утверждение
 * брало первое предложение сниппета с сигналом, даже если сниппет уже перешёл
 * к навигации площадки, и не требовало сигнала у описательной темы.
 *
 * Правило: фраза **несёт сигнал темы** (для всех тем, описательных тоже: у
 * темы, назначенной списком площадок, сигнал — сама площадка), фраза
 * **целая** (`looksLikeWholeStatement`) и фраза **о субъекте**. Порядок:
 * цитата прочитанной страницы (сверена аудитором дословно) → заголовок
 * публикации (её собственная формулировка, если сигнал стоит в нём самом) →
 * предложение сниппета. Нет ни одной — цитаты нет, и блок печатает честную
 * строку без обещания.
 *
 * О субъекте: цитата страницы — если читающая модель признала страницу его
 * страницей (`subjectMatch: subject`), иначе только если называет его;
 * предложение сниппета — пока в сниппете не встретилось голое имя другого
 * человека; заголовок — если не называет другого человека вместо субъекта.
 * Страница, признанная страницей другого человека, не цитируется вовсе.
 *
 * Обрезанное поисковиком предложение сниппета не цитируется и не
 * восстанавливается в «заголовок»: восстановление меняло слова источника
 * («После публикации расследования…» → «Расследование…»), а обрывок без
 * маркера печатался целой фразой («На выборах он был единственным»).
 */
/**
 * Примеры материалов — различимые и содержательные (шаг 0130).
 *
 * Стр. 51 отчёта Мордашова 20.09.2026 печатала «(примеры: Alexey Alexandrovits
 * Mordaschov · Alexey Aleksandrovich MORDASHOV · Alexey Alexandrovits
 * Mordaschov)»: первый и третий совпадают дословно, и все три — варианты
 * написания имени, а не материалы. Стр. 18 — «(примеры: Мордашов, Алексей)».
 *
 * Голое имя примером не бывает по той же причине, что и цитатой: читатель из
 * него не узнаёт ничего. Повтор снимается по нормализованному тексту, чтобы
 * «MORDASHOV» и «Mordashov» не считались разными.
 */
export function distinctExampleTitles(titles: readonly string[], limit = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of titles) {
    const title = String(raw ?? "").replace(/\s+/gu, " ").trim();
    if (!title || looksLikeBareName(title)) continue;
    const key = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Заголовок, годный в цитату: целая фраза и не о другом человеке (шаг 0125).
 *
 * Один ответ на вопрос «можно ли цитировать этот заголовок». Его зовут
 * страницы региона (`resolveExampleQuote`) и сиротская претензия резюме
 * (`canonical-claim-builder`): вторая брала заголовок как есть, и на стр. 6
 * отчёта Абрамовича под политической темой стояло голое имя «Абрамович Роман
 * Аркадьевич». Сигнал темы здесь не проверяется — он у двух вызывающих разный
 * (у претензии тема уже выведена по тексту), а вопрос «фраза ли это» один.
 */
export function quotableTitle(
  title: string,
  stems: readonly string[] = [],
  budget = CLAIM_QUOTE_BUDGET
): string | null {
  const raw = String(title ?? "");
  if (titleNamesAnotherPerson(raw, stems)) return null;
  const q = quoteForClaim(raw, budget);
  return q && looksLikeWholeStatement(q) ? q : null;
}

export function resolveExampleQuote(
  item: QuotableMaterial,
  theme: ThemeDef,
  /**
   * Слова признаков субъекта: совпадение по ним сигналом темы не считается.
   */
  subjectContext?: SubjectContextMask | null,
  ctx?: ExampleQuoteContext
): ClaimEvidenceExample | null {
  if (NON_QUOTABLE_EVIDENCE_TYPES.has(String(item.evidenceType ?? "").toLowerCase())) {
    return null;
  }
  const domain = domainOf(item.sourceUrl);
  const url = String(item.sourceUrl ?? "");
  const stems = stemsOf(ctx?.subjectNames);
  const platformSignal = Boolean(theme.domains?.test(url));
  /*
   * Фраза годится под эту тему, когда она несёт её сигнал и говорит о
   * субъекте (шаг 0125).
   *
   * Лид принадлежности показывает тему только там, где предмет темы — сама
   * биография (`quotesIdentityLead`): в остальных темах слово словаря стоит в
   * перечне занятий («…is a Russian businessman and politician»), то есть
   * называет человека, а не факт. Обобщение о классе лиц не о субъекте вовсе.
   */
  const fits = (text: string): boolean => {
    if (!platformSignal && !carriesThemeSignal(text, theme, subjectContext)) return false;
    if (!theme.quotesIdentityLead && looksLikeIdentityLead(text)) return false;
    return !looksLikeGeneralization(text, stems);
  };
  const carries = fits;
  const example = (
    title: string,
    source: NonNullable<ClaimEvidenceExample["source"]>,
    truncated = false
  ): ClaimEvidenceExample => ({
    title,
    domain,
    url: item.sourceUrl,
    source,
    ...(truncated ? { truncated: true } : {}),
  });

  /*
   * 1. Цитаты прочитанной страницы: целые предложения, сверенные с текстом.
   *
   * Два прохода, и порядок не случайный (шаг 0142). У обвиняющей темы
   * сигналом считается и слово негатива (шаг 0115) — иначе криминальный сюжет,
   * написанный словами обвинения, остался бы без цитаты. Но слово негатива
   * шире темы: на стр. 13 отчёта Фридмана под «Криминальными материалами»
   * встали две цитаты про санкции, где о суде нет ни слова. Поэтому сначала
   * ищется фраза со **своим** словом темы, и только потом — та, что прошла по
   * слову негатива.
   */
  const verdict = ctx?.verdict;
  if (verdict && verdict.subjectMatch !== "other") {
    const ownWord = (text: string): boolean =>
      platformSignal || theme.keywords.test(text);
    for (const pass of [true, false]) {
      for (const raw of verdict.quotes ?? []) {
        const text = pageQuoteForClient(raw);
        if (!text) continue;
        if (verdict.subjectMatch !== "subject" && stems.length > 0 && !textNamesSubject(text, stems)) {
          continue;
        }
        if (!carries(text) || !looksLikeWholeStatement(text)) continue;
        if (pass && !ownWord(text)) continue;
        return example(text, "page");
      }
    }
  }
  // 2. Заголовок — целый, с сигналом, не о другом человеке. Заголовок о
  // другом человеке закрывает материал целиком: его сниппет — о том же.
  const rawTitle = String(item.title ?? "");
  if (titleNamesAnotherPerson(rawTitle, stems)) return null;
  if (!isWeakExampleTitle(rawTitle, { theme })) {
    const q = quotableTitle(rawTitle, stems);
    if (q && carries(q)) return example(q, "title");
  }

  // 3. Предложение сниппета — о субъекте, целое, с сигналом.
  for (const sentence of snippetSentencesAboutSubject(item.snippet, stems)) {
    if (!sentence.aboutSubject || sentence.truncated) continue;
    if (!carries(sentence.text) || !looksLikeWholeStatement(sentence.text)) continue;
    const fitted = fitSentence(sentence.text, CLAIM_QUOTE_BUDGET);
    if (!fitted) continue;
    return example(fitted.text, "snippet", fitted.truncated);
  }
  return null;
}

/** Pick up to 2 ranked, non-weak quotes from a finding evidence bucket. */
export function pickClaimExamples(
  items: RawInventoryItem[],
  theme: ThemeDef,
  adverseItems: RawInventoryItem[] = [],
  subjectContext?: SubjectContextMask | null,
  ctx?: { subjectNames?: readonly string[]; verdictByRef?: ObservationVerdictByRef }
): ClaimEvidenceExample[] {
  const adverseSet = new Set(adverseItems);
  const ranked = [...items].sort(
    (a, b) =>
      scoreExampleForTheme(b, theme, adverseSet.has(b)) -
      scoreExampleForTheme(a, theme, adverseSet.has(a))
  );
  const examples: ClaimEvidenceExample[] = [];
  const seen = new Set<string>();
  for (const i of ranked) {
    const ex = resolveExampleQuote(i, theme, subjectContext, {
      subjectNames: ctx?.subjectNames,
      verdict: ctx?.verdictByRef?.[refOf(i)],
    });
    if (!ex?.title) continue;
    const key = `${ex.title.toLowerCase()}|${ex.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    examples.push(ex);
    if (examples.length >= 2) break;
  }
  return examples;
}

/**
 * PDF-40 G.2b / PDF-44 H — concrete claim: framing (+ domain anchor) → quotes → scale → why.
 * Theme label is prepended by consumers (`themedClaim`).
 */
export function buildClientFacingClaim(input: {
  theme: ThemeDef;
  itemsCount: number;
  adverseCount: number;
  /** Prefer adverse evidence first; title+domain pairs from the corpus. */
  examples: ClaimEvidenceExample[];
  /** @deprecated kept for call-site compat; ignored when examples is set. */
  domains?: string[];
  /** @deprecated kept for call-site compat; ignored when examples is set. */
  titles?: string[];
}): string {
  const baseFraming =
    CLIENT_THEME_FRAMING[input.theme.themeId] ??
    `Найдены публикации по теме «${input.theme.label}»`;
  const why = clientThemeWhy(input.theme.themeId);

  let examples: ClaimEvidenceExample[] = (input.examples ?? [])
    .map((e) => ({
      // Ужатая нами фраза не чистится как заголовок: чистка сняла бы наше
      // многоточие, и обрывок печатался бы целой фразой (шаг 0115).
      title: e.truncated ? e.title : cleanExampleTitle(e.title),
      domain: String(e.domain ?? "")
        .replace(/^www\./iu, "")
        .trim(),
      url: e.url,
      ...(e.truncated ? { truncated: true } : {}),
    }))
    .filter(
      (e) =>
        e.title.length >= 12 &&
        !/^potential\s+match$/i.test(e.title) &&
        !/^потенциальное совпадение$/i.test(e.title) &&
        (e.truncated || !isWeakExampleTitle(e.title, { theme: input.theme }))
    );
  // Compat path: old callers still pass titles/domains separately.
  if (examples.length === 0 && (input.titles?.length || input.domains?.length)) {
    const domains = input.domains ?? [];
    examples = (input.titles ?? [])
      .map((t, i) => ({ title: cleanExampleTitle(t), domain: domains[i] ?? domains[0] ?? "" }))
      .filter(
        (e) => e.title.length >= 12 && !isWeakExampleTitle(e.title, { theme: input.theme })
      );
  }

  // PDF-46/47 — up to 2 full quotes (never mid-cut); second evidence is kept
  // when it adds a distinct risk angle (e.g. FБК/Приходько + Guardian).
  const quoteLines: string[] = [];
  // Два примера — но про разные сюжеты.
  //
  // Здесь стояло `examples.slice(0, 2)`: два первых подряд, без вопроса, не
  // одна ли это публикация. В отчёте о Тинькове (28.07, стр.5) так вышло —
  // «Oleg Tinkov Net Worth…» и «Oleg Tinkov: Oleg Tinkov Net Worth… -
  // Goodreturns» с одного goodreturns.in: одна статья предъявлена как два
  // свидетельства, и читатель видит одно предложение дважды подряд.
  //
  // Правило общее с построителем региональных резюме — оно одно на оба места.
  for (const e of pickDistinctTitles(examples, 2)) {
    const q = e.truncated ? e.title : quoteForClaim(e.title, 220);
    if (!q) continue;
    if (!e.truncated && (isWeakExampleTitle(q, { theme: input.theme }) || hasDanglingTail(q))) {
      continue;
    }
    // Источник называется полным адресом: домен читается как «где-то на сайте
    // есть, ищите сами» (замечание владельца к отчёту 20.08). Демо-имена не
    // называются ни адресом, ни доменом — это внутри `sourceAttribution`.
    quoteLines.push(sourceQuote(q, sourceAttribution({ url: e.url, domain: e.domain })));
  }

  const total = pluralRu(input.itemsCount, "материал", "материала", "материалов");
  const scale = themeScaleLine(input.itemsCount, input.adverseCount, REPORT_SCOPE_WORDS);

  // Domain anchors stay on quote lines («…» — источник domain) — do NOT append
  // «(в т.ч. материалы на …)» to framing: long parentheticals get mid-clipped by
  // the renderer and trip the dangling-bullet QA (PDF-44 render 500 on p4).
  const framing = baseFraming;
  const anchorDomains = [
    ...new Set(
      clientSafeDomains([
        ...examples.map((e) => e.domain),
        ...(input.domains ?? []).map((d) => d.replace(/^www\./iu, "").trim()),
      ])
    ),
  ].slice(0, 2);

  if (quoteLines.length === 0) {
    const domainHint = clientSafeDomains(input.domains ?? []).slice(0, 3).join(", ");
    // У описательной темы нет «сути риска»: «Деловой профиль» с честной
    // строкой про риск читался как претензия (шаг 0115).
    const essence = themeEssenceWord(input.theme);
    const gap = domainHint
      ? `По теме ${input.itemsCount} ${total} в источниках ${domainHint}; отдельный заголовок с сутью ${essence} в выдаче не выделен — сверить первоисточники.`
      : `По теме ${input.itemsCount} ${total}; отдельный заголовок с сутью ${essence} в выдаче не выделен — сверить первоисточники.`;
    return [`${framing}.`, gap, scale, why].join("\n");
  }
  const whereLine =
    anchorDomains.length > 0 ? `Где видно: ${anchorDomains.join(", ")}.` : "";
  return [`${framing}:`, ...quoteLines, scale, whereLine, why].filter(Boolean).join("\n");
}

/**
 * PDF-36 D.5 — SERP headline quoted as a client example: strip raw source
 * suffixes («… | Дзен»), trailing timestamps («- 03.12.25 22:27») and a
 * final fragment the search engine itself truncated with an ellipsis.
 */
/** Названия справочных площадок, приклеиваемые к заголовку карточки. */
const REFERENCE_SOURCE_SUFFIX =
  /\s*[-–—]\s*(?:Википедия|Wikipedia|Wikidata|Циклопедия|Рувики|RuWiki|Энциклопедия[^-–—]*|ПЕРСОНА\s+ТАСС|Telegram\s+Вики|[A-Za-zА-Яа-яЁё ]{0,20}Вики(?:педия)?)\s*$/iu;

/**
 * Кончается ли текст концом предложения, а не точкой внутри числа или инициала.
 *
 * Точка — не всегда граница: «$18.4 billion», «Фонд А.Усманова», «1.4B». Взяв
 * её за конец предложения, восстановление обрезанного заголовка давало
 * «Благотворительный Фонд А.» и «Alisher Usmanov is worth is an estimated
 * $18.» — обрывки, ради устранения которых восстановление и делалось.
 */
export function endsWithSentence(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/[!?…»]$/u.test(t)) return true;
  if (!/\.$/u.test(t)) return false;
  // Десятичный разделитель: «$18.», «1.».
  if (/\d\.$/u.test(t)) return false;
  // Инициал: «Фонд А.», «J.».
  if (/(?:^|[\s(«"])\p{Lu}\.$/u.test(t)) return false;
  return true;
}

export function cleanExampleTitle(raw: string): string {
  // Приклеенная подпись страницы снимается и здесь (шаг 0121): прежде чистка
  // стояла только в гигиене цитат страницы, и заголовок доезжал до отчёта
  // склеенным — «…Сергея Бондарчука-старшегоИсточник: Starface.ru.».
  let t = cutGluedChrome(String(raw ?? "").replace(/\s+/gu, " ").trim());
  // Source suffix after a pipe: "Заголовок | Дзен" / "… | Forbes.ru".
  t = t.replace(/\s*\|\s*[^|]{1,40}$/u, "").trim();
  // Хвост издания или аккаунта после «·»/«•» — «… · mirov101.», «… • Следствие»
  // (шаг 0117): печатался внутри кавычек. Снимается, когда остаётся содержательный
  // заголовок; короткий остаток («Интервью · …») значит, что знак стоит внутри
  // самого заголовка. Сравнение сюжетов (`titleFingerprint`) режет по тем же знакам.
  // Хвостов бывает несколько: «…Automecanica SA • Следствие • Версия для
  // печати» (эталон-72) — снимаются по одному, пока остаётся содержательный
  // заголовок.
  for (let i = 0; i < 3; i += 1) {
    const publisherTail = t.match(/^(.{20,}?)\s*[·•]\s*[^·•]{1,40}$/u);
    if (!publisherTail) break;
    t = publisherTail[1]!.trim();
  }
  // Справочный суффикс через тире: «Дуров, Павел Валерьевич — Википедия».
  // Без этого карточка-справка не опознаётся как голое имя и проходит в
  // доказательства темы, которой не касается: единственным «материалом» об
  // офшорах в отчёте оказалась статья Википедии (шаг 13, C3). Название
  // источника и так печатается отдельно.
  t = t.replace(REFERENCE_SOURCE_SUFFIX, "").trim();
  // Trailing date/time stamps: "- 03.12.25 22:27", "· 02.03.2020".
  t = t.replace(/\s*[-–—·]\s*\d{1,2}\.\d{1,2}\.\d{2,4}(?:\s+\d{1,2}:\d{2})?\s*$/u, "").trim();
  // Nested guillemets break quote parsers: «Экс-владелец «Главстроя»».
  for (let i = 0; i < 3; i += 1) {
    const next = t.replace(/«([^«»]*)«([^»]+)»([^»]*)»/gu, "«$1\"$2\"$3»");
    if (next === t) break;
    t = next;
  }
  // Search engines truncate long titles with an ellipsis: drop the broken
  // last fragment when a complete sentence remains before it.
  const m = t.match(/^(.*[.!?…»])\s*[^.!?…»]*(?:\.\.\.|…)$/u);
  if (m && m[1].length >= 20 && endsWithSentence(m[1].trim())) t = m[1].trim();
  return t.replace(/\s*(?:\.\.\.|…)\s*$/u, "").trim();
}

/**
 * One evidence item may support multiple genuinely different claims: it is
 * matched against EVERY theme, not consumed by the first/highest-priority one.
 *
 * Тему называют два разных ответа: слова темы читают текст материала, площадки
 * темы отвечают по адресу отдельным списком. Смешивать их в одну строку сверки
 * нельзя — раздел сайта в пути тогда становится темой публикации.
 */
function themesFor(
  item: RawInventoryItem,
  /** Страницу прочитали и признали благоприятной (и человек с этим не спорил). */
  favourablyRead: boolean,
  /** Слова признаков субъекта: тему по ним материал не получает. */
  subjectContext: SubjectContextMask | null | undefined,
  /** Основы имени субъекта: по ним сниппет читается до чужого голого имени. */
  stems: readonly string[]
): ThemeDef[] {
  const text = themeMatchText(item, stems);
  const url = String(item.sourceUrl ?? "");
  return getFindingThemes().filter((theme) => {
    // Обвиняющая тема не берёт благоприятно прочитанную страницу — ни в состав,
    // ни в счёт, ни в уровень. Тему назначает словарь по заголовку, а решение
    // вынесено по тексту страницы и знает, что там на самом деле; у ярлыка
    // «Офшорные структуры» цена ошибки прямая — субъекту предлагают убирать
    // материал, который о нём ничего такого не говорит. Описательной темы это
    // не касается: для неё нейтральная публикация и есть доказательство.
    if (favourablyRead && isAccusingTheme(theme)) return false;
    if (theme.domains?.test(url)) return true;
    // Материал, утверждающий отсутствие («не было выставленных претензий»,
    // «обвинения не подтвердились»), темой риска не является: иначе отчёт
    // говорит противоположное источнику. Совпадение по площадке так не
    // снимается — отрицание относится к словам, а не к тому, что это за сайт.
    if (!theme.keywords.test(text)) return false;
    if (dictionaryHitIsNegated(text, theme.keywords)) return false;
    /*
     * Тема, совпавшая **только** словами признаков субъекта, о материале
     * ничего не говорит: это его должность. Так тема «Криминальные / судебные
     * материалы» собрала у председателя суда карточку самого суда, регламент
     * арбитражных судов и его собственное досье
     * (`config/subject-context-words.ts`).
     */
    return !allDictionaryHitsAreSubjectContext(text, theme.keywords, subjectContext);
  });
}

/** Same evidence + same normalized claim must collapse into one contribution. */
export function claimFingerprint(themeId: string, item: RawInventoryItem): string {
  /*
   * Утверждение опознаётся тем, что увидит клиент: домен плюс текст, из
   * которого берётся цитата.
   *
   * По заголовку различать нельзя: поисковик режет его по своей ширине, и один
   * профиль судьи вошёл в криминальную тему дважды — «…— Краснодарский край» и
   * «…— Краснодарский...», два адреса одной страницы (второй — её постраничная
   * навигация). Блок напечатал «Всего по теме: 2 материала» об одной странице.
   */
  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/ё/gu, "е")
      .replace(/[^\p{L}\p{N} ]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  const snippet = normalize(String(item.snippet ?? ""));
  const claim = snippet || normalize(String(item.title ?? ""));
  return `${themeId}|${domainOf(item.sourceUrl)}|${claim}`;
}

function riskFor(theme: ThemeDef, adverseCount: number, total: number): RiskLevel {
  if (theme.baseRisk === "none") return adverseCount > 0 ? "low" : "none";
  if (adverseCount === 0) return theme.baseRisk === "high" ? "medium" : "low";
  if (theme.baseRisk === "high") return adverseCount >= 3 || adverseCount / total > 0.5 ? "critical" : "high";
  return adverseCount >= 3 ? "high" : theme.baseRisk;
}

function promotionFor(risk: RiskLevel, confidence: number): PromotionPriority {
  if ((risk === "critical" || risk === "high") && confidence >= 0.6) return "P1";
  if (risk === "high" || risk === "medium") return "P2";
  if (risk === "low") return "P3";
  return "P3";
}

function detectContradictions(
  themeId: string,
  items: RawInventoryItem[],
  /** Негативные материалы темы — те же, по которым считается её уровень. */
  adverse: RawInventoryItem[]
): { contradictions: FindingContradiction[]; limitations: string[] } {
  const contradictions: FindingContradiction[] = [];
  const limitations: string[] = [];

  const cfg = resolveFindingThemesConfig();
  const unverified = items.filter((i) => cfg.unverifiedClaimPatterns.test(itemText(i)));
  const positive = items.filter((i) => cfg.positivePatterns.test(itemText(i)));

  if (unverified.length > 0) {
    limitations.push(
      `${unverified.length} из ${items.length} сигналов помечены как неподтверждённые (potential match / requires review).`
    );
    if (adverse.length > unverified.length) {
      contradictions.push({
        description:
          "Часть источников подаёт тему как установленную, при этом compliance-сигналы по той же теме явно не верифицированы.",
        evidenceRefs: [...unverified.slice(0, 3), ...adverse.slice(0, 3)].map(refOf),
      });
    }
  }

  const asserting = items.filter((i) => cfg.assertionPatterns.test(itemText(i)));
  const denying = items.filter((i) => cfg.denialPatterns.test(itemText(i)));
  if (asserting.length > 0 && denying.length > 0) {
    contradictions.push({
      description:
        "Источники противоречат друг другу по существу: одни утверждают факт, другие его опровергают.",
      evidenceRefs: [...asserting.slice(0, 2), ...denying.slice(0, 2)].map(refOf),
    });
  }

  if (adverse.length > 0 && positive.length > 0) {
    contradictions.push({
      description:
        "Тональность источников противоречива: одновременно присутствуют негативные материалы и позитивно-биографические публикации.",
      evidenceRefs: [...adverse.slice(0, 2), ...positive.slice(0, 2)].map(refOf),
    });
  }

  const domains = new Set(items.map((i) => domainOf(i.sourceUrl)).filter(Boolean));
  if (domains.size === 1 && items.length > 1) {
    limitations.push(`Все свидетельства темы происходят из одного домена (${[...domains][0]}).`);
  }
  void themeId;

  return { contradictions, limitations };
}

export function synthesizeFindings(input: {
  caseId: string;
  datasetId: string;
  items: RawInventoryItem[];
  resolutionByRef: Map<string, SubjectResolutionItem>;
  sourceHashes: string[];
  /** Coverage-driven limitations, e.g. "images (UAE): NOT_COLLECTED". */
  coverageLimitations?: string[];
  /**
   * Решения по прочитанным страницам. Уровень темы обязан их знать: материал,
   * чью страницу открыли и признали благоприятной, негативом не считается —
   * иначе отчёт предлагает субъекту убирать то, что говорит о нём хорошо.
   */
  verdictByRef?: ObservationVerdictByRef;
  /**
   * Признаки субъекта, названные оператором.
   *
   * Из них строится маска слов, которыми написан он сам: они не дают ни темы,
   * ни негатива. Без признаков маски нет и поведение прежнее.
   */
  subjectAnchors?: SubjectAnchors | null;
  /**
   * Написания имени субъекта (`subjectNameVariants`).
   *
   * По ним сниппет читается до голого имени другого человека, а цитата темы
   * узнаётся как фраза о субъекте (шаг 0115). Без имён оба правила молчат и
   * поведение прежнее.
   */
  subjectNames?: readonly string[];
}): FindingSynthesisResult {
  const subjectContext = buildSubjectContextMask(input.subjectAnchors);
  const nameStems = subjectNameStems(input.subjectNames ?? []);
  const themeAssignments = new Map<string, string[]>();
  const byDecisionTheme = new Map<string, RawInventoryItem[]>(); // `${decision}|${themeId}`
  const seenClaimFingerprints = new Map<string, Set<string>>(); // `${decision}|${themeId}` -> fingerprints
  const uncategorizedItems: UncategorizedMaterial[] = [];
  const seenUncategorizedRefs = new Set<string>();

  let subjectMatchEvidence = 0;
  let likelySubjectEvidence = 0;
  let ambiguousEvidence = 0;
  let otherSubjectEvidence = 0;

  for (const item of input.items) {
    const ref = refOf(item);
    const resolution = input.resolutionByRef.get(ref);
    const decision = resolution?.decision ?? "INSUFFICIENT_IDENTIFIERS";
    if (decision === "SUBJECT_MATCH") subjectMatchEvidence += 1;
    else if (decision === "LIKELY_SUBJECT") likelySubjectEvidence += 1;
    else if (decision === "AMBIGUOUS") ambiguousEvidence += 1;
    else if (decision === "OTHER_SUBJECT") otherSubjectEvidence += 1;

    // Multi-theme: evidence supports every distinct claim it matches;
    // duplicates of the same normalized claim within a theme collapse.
    // SUBJECT_MATCH/LIKELY without keyword hits → uncategorized (§3.2), not a
    // finding (never enters the risk matrix). AMBIGUOUS without hits still gets
    // a review theme so they reach «Требует подтверждения» / appendix (§2.1).
    let themes = themesFor(
      item,
      resolveItemReadFavourably(item, input.verdictByRef),
      subjectContext,
      nameStems
    );
    if (themes.length === 0) {
      if (decision === "SUBJECT_MATCH" || decision === "LIKELY_SUBJECT") {
        if (!seenUncategorizedRefs.has(ref)) {
          seenUncategorizedRefs.add(ref);
          uncategorizedItems.push({
            evidenceRef: ref,
            title: String(item.title ?? "").trim() || "(без заголовка)",
            domain: domainOf(item.sourceUrl) || "—",
            region: mapRegionBucket(item.region),
            subjectMatch: decision,
          });
        }
        continue;
      }
      if (decision === "AMBIGUOUS") {
        const fallback = FINDING_THEMES.find((t) => t.themeId === "business_profile");
        if (fallback) themes = [fallback];
      }
    }
    for (const theme of themes) {
      const key = `${decision}|${theme.themeId}`;
      const fp = claimFingerprint(theme.themeId, item);
      const fingerprints = seenClaimFingerprints.get(key) ?? new Set<string>();
      if (fingerprints.has(fp)) continue; // same evidence identity + same claim
      fingerprints.add(fp);
      seenClaimFingerprints.set(key, fingerprints);

      const assigned = themeAssignments.get(ref) ?? [];
      if (!assigned.includes(theme.themeId)) assigned.push(theme.themeId);
      themeAssignments.set(ref, assigned);

      const bucket = byDecisionTheme.get(key) ?? [];
      bucket.push(item);
      byDecisionTheme.set(key, bucket);
    }
  }

  const byRegion: UncategorizedMaterialsBlock["byRegion"] = {};
  for (const row of uncategorizedItems) {
    const bucket = byRegion[row.region] ?? { count: 0, subjectMatchCount: 0, examples: [] };
    bucket.count += 1;
    if (row.subjectMatch === "SUBJECT_MATCH") {
      bucket.subjectMatchCount = (bucket.subjectMatchCount ?? 0) + 1;
    }
    if (bucket.examples.length < UNCATEGORIZED_PER_REGION_N) {
      bucket.examples.push(row);
    } else if (row.subjectMatch === "SUBJECT_MATCH") {
      // Подтверждённый материал вытесняет вероятный: примеры печатает строка
      // «о субъекте», и вероятные в неё всё равно не попадут.
      const spare = bucket.examples.findIndex((e) => e.subjectMatch !== "SUBJECT_MATCH");
      if (spare >= 0) bucket.examples[spare] = row;
    }
    byRegion[row.region] = bucket;
  }
  const uncategorized: UncategorizedMaterialsBlock = {
    version: "uncategorized-materials-v1",
    count: uncategorizedItems.length,
    subjectMatchCount: uncategorizedItems.filter((r) => r.subjectMatch === "SUBJECT_MATCH")
      .length,
    likelySubjectCount: uncategorizedItems.filter((r) => r.subjectMatch === "LIKELY_SUBJECT")
      .length,
    topExamples: uncategorizedItems.slice(0, UNCATEGORIZED_TOP_N),
    allEvidenceRefs: uncategorizedItems.map((r) => r.evidenceRef),
    byRegion,
  };

  const makeFinding = (
    themeId: string,
    items: RawInventoryItem[],
    subjectMatch: "SUBJECT_MATCH" | "LIKELY_SUBJECT" | "AMBIGUOUS" | "OTHER_SUBJECT"
  ): Finding => {
    const theme = FINDING_THEMES.find((t) => t.themeId === themeId)!;
    const adverseItems = items.filter((i) =>
      resolveItemAdverse(i, input.verdictByRef, subjectContext)
    );
    const risk = riskFor(theme, adverseItems.length, items.length);
    const evidenceRefs = items.map(refOf);
    const domains = [...new Set(items.map((i) => domainOf(i.sourceUrl)).filter(Boolean))];
    const providers = [...new Set(items.map((i) => String(i.provider ?? "unknown").toLowerCase()))];
    const regions = [...new Set(items.map((i) => mapRegionBucket(i.region)))];
    const surfaces = [
      ...new Set(
        items.map((i) =>
          mapSurfaceBucket(
            String(((i.rawMetadata ?? {}) as Record<string, unknown>).surface ?? i.evidenceType)
          )
        )
      ),
    ];
    const { contradictions, limitations } = detectContradictions(themeId, items, adverseItems);
    if (subjectMatch === "AMBIGUOUS") {
      limitations.push("Принадлежность части свидетельств проверяемому лицу не установлена однозначно.");
    }
    if (subjectMatch === "LIKELY_SUBJECT") {
      limitations.push(
        "Принадлежность вероятна по фамилии и контексту, но не подтверждена однозначно — требуется проверка."
      );
    }
    for (const l of input.coverageLimitations ?? []) limitations.push(l);

    const sourceDiversity = Math.min(domains.length / 3, 1);
    const confidence =
      subjectMatch === "SUBJECT_MATCH"
        ? Math.min(0.55 + 0.3 * sourceDiversity + (adverseItems.length > 0 ? 0.05 : 0.1), 0.95)
        : subjectMatch === "LIKELY_SUBJECT"
          ? Math.min(0.45 + 0.2 * sourceDiversity, 0.7)
          : 0.35;

    // PDF-44 H.1/H.2 — rank by theme substance; never quote bare FIO / SEO-bio.
    const examples = pickClaimExamples(items, theme, adverseItems, subjectContext, {
      subjectNames: input.subjectNames,
      verdictByRef: input.verdictByRef,
    });

    // PDF-40 G.2b — concrete quotes + domains; theme prepended by consumers.
    const claim = buildClientFacingClaim({
      theme,
      itemsCount: items.length,
      adverseCount: adverseItems.length,
      examples,
      domains,
    });

    return FindingSchema.parse({
      schemaVersion: FINDING_SCHEMA_VERSION,
      caseId: input.caseId,
      datasetId: input.datasetId,
      sourceHashes: input.sourceHashes,
      evidenceRefs,
      findingId: `finding-${themeId}-${subjectMatch.toLowerCase()}-${createHash("sha1")
        .update(evidenceRefs.sort().join("|"))
        .digest("hex")
        .slice(0, 8)}`,
      theme: theme.label,
      claim,
      subjectMatch,
      riskLevel: risk,
      confidence,
      regions,
      sourceDomains: domains,
      providers,
      recommendedAction: theme.recommendedAction,
      contradictions,
      limitations: [...new Set(limitations)],
      promotionPriority:
        subjectMatch === "SUBJECT_MATCH" ? promotionFor(risk, confidence) : "APPENDIX",
      surfaceKinds: surfaces,
    });
  };

  const verified: Finding[] = [];
  const likelyFindings: Finding[] = [];
  const ambiguousFindings: Finding[] = [];
  const excludedFindings: Finding[] = [];

  for (const [key, items] of byDecisionTheme) {
    const [decision, themeId] = key.split("|");
    if (decision === "SUBJECT_MATCH") verified.push(makeFinding(themeId, items, "SUBJECT_MATCH"));
    else if (decision === "LIKELY_SUBJECT")
      likelyFindings.push(makeFinding(themeId, items, "LIKELY_SUBJECT"));
    else if (decision === "AMBIGUOUS") ambiguousFindings.push(makeFinding(themeId, items, "AMBIGUOUS"));
    else if (decision === "OTHER_SUBJECT") excludedFindings.push(makeFinding(themeId, items, "OTHER_SUBJECT"));
  }

  const sortByPriority = (a: Finding, b: Finding) => {
    const order: Record<string, number> = { P1: 0, P2: 1, P3: 2, APPENDIX: 3 };
    const d = (order[a.promotionPriority] ?? 9) - (order[b.promotionPriority] ?? 9);
    return d !== 0 ? d : a.findingId.localeCompare(b.findingId);
  };
  verified.sort(sortByPriority);
  likelyFindings.sort(sortByPriority);
  ambiguousFindings.sort(sortByPriority);

  const exclusionReasons: Record<string, string> = {};
  for (const f of excludedFindings) {
    exclusionReasons[f.findingId] = "OTHER_SUBJECT: свидетельства относятся к другому лицу";
  }

  const bundle: VerifiedFindingBundle = VerifiedFindingBundleSchema.parse({
    schemaVersion: VERIFIED_FINDING_BUNDLE_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    // KPI / confirmed evidence: SUBJECT_MATCH only (§2.1 invariant).
    evidenceRefs: verified.flatMap((f) => f.evidenceRefs),
    kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
    // LIKELY stays in the bundle for matrix «Требует подтверждения», not KPI.
    findings: [...verified, ...likelyFindings, ...excludedFindings],
    excludedFindingIds: excludedFindings.map((f) => f.findingId),
    exclusionReasons,
  });

  return {
    bundle,
    ambiguousFindings,
    themeAssignments,
    uncategorized,
    stats: {
      subjectMatchEvidence,
      likelySubjectEvidence,
      ambiguousEvidence,
      otherSubjectEvidence,
      adverseFindingCount: verified.filter((f) =>
        ["medium", "high", "critical"].includes(f.riskLevel)
      ).length,
      uncategorizedCount: uncategorized.count,
    },
  };
}
