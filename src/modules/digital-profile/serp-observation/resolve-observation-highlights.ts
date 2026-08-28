/**
 * Resolve red-frame highlights for provider-first SerpObservation rows.
 * Reuses Stage S1 theme-grouper; no LLM, no CAPTCHA/proxy.
 */

import { getAdversePatterns, getStrongAdversePatterns } from "../config/finding-themes";
import { buildConsistentThemeGrouping } from "../serp-snapshot/snapshot-consistency";
import type { LoadedResult, ResultView, SerpEngine, SerpLanguage, ThemeGrouping } from "../serp-snapshot/types";
import type { PersistedSerpObservation } from "./types";

/**
 * Площадки, которым красная рамка полагается по самому факту публикации.
 *
 * `rucriminal` — без точки: агрегатор компромата чаще виден перепечаткой, чем
 * своим доменом, и на прогоне Кремлёва строка
 * `x.com/rucriminalinfo/status/…` осталась без рамки, а страница снимка
 * понизила уровень внимания с высокого до среднего. Список читает **адрес
 * целиком**, а не только хост, — этим он и отличается от словаря, который
 * адреса не читает вовсе.
 */
const ADVERSE_DOMAIN_RE =
  /rucriminal|cybercriminal\.|acompromat\.|rucompromat\.|compromat\.|rupep\.|opensanctions\.|ofac\.|justice\.gov|home\.treasury\.gov/i;

/**
 * Мягкие площадки: биографии, реестры, энциклопедии.
 *
 * Словарь по ним не работает — их тексты перечисляют факты чужими словами, и
 * «скандалы» в оглавлении статьи не сигнал площадки, а её жанр. Биографии
 * Forbes и Klerk так получали ложную «Тему N» (PDF 41), а `ru.ruwiki.ru`
 * — «Нежелательный» по слову «скандалы» в заголовке рядом с `ru.wikipedia.org`,
 * оценённой по прочитанной странице: две энциклопедии об одном человеке
 * расходились в оценке из-за формы заголовка.
 */
const SOFT_PROFILE_DOMAIN_RE =
  /forbes\.|klerk\.|tadviser\.|wikipedia\.|ruwiki\.|wikiwand\.|linkedin\.|rusprofile\.|audit-it\.|zachestnyibiznes\.|labyrinth\.|instagram\.|facebook\.|x\.com|twitter\.|youtube\.|imslp\./i;

type ThemeRule = { key: string; title: string; match: RegExp };

const THEME_RULES: ThemeRule[] = [
  {
    key: "criminal",
    title: "Криминальные / судебные материалы",
    match: /rucriminal|cybercriminal|acompromat|compromat|уголов|арест|\bcriminal\b|lawsuit/i,
  },
  {
    key: "sanctions",
    title: "Санкционный контур и связанные лица",
    match: /санкц|sanction|\bofac\b|watchlist|defense\s+industry|оборонн/i,
  },
  {
    key: "pep",
    title: "Сигналы PEP / RCA",
    match: /rupep|\bpep\b|\brca\b/i,
  },
  {
    key: "adverse_media",
    title: "Негативные публикации на агрегаторах",
    match: /негатив|adverse|компромат|нежелат/i,
  },
];

function domainOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function themeForBlob(blob: string): { key: string; title: string } {
  for (const rule of THEME_RULES) {
    if (rule.match.test(blob)) return { key: rule.key, title: rule.title };
  }
  return { key: "other", title: "Потенциально негативные публикации" };
}

/**
 * Drop mojibake / keyboard-mash snippets (seen on some rupep Serper rows:
 * «Аяццмтщшорёп», DOB 11.55.1840) so synthetic SERP stays client-readable.
 */
export function sanitizeSerpSnippet(snippet: string | null | undefined): string {
  const t = String(snippet ?? "").trim();
  if (!t) return "";
  // Impossible calendar month/day (e.g. 11.55.1840, 49.4856)
  if (/\b\d{1,2}\.(?:[3-9]\d|1[3-9]|2[5-9])\.\d{2,4}\b/.test(t)) return "";
  if (/\b(?:Pdg|Ywffp)\b/i.test(t)) return "";
  // Long consonant runs atypical for Russian/English prose
  if (/[бвгджзйклмнпрстфхцчшщъь]{7,}/iu.test(t)) return "";
  if (/[bcdfghjklmnpqrstvwxz]{8,}/i.test(t)) return "";
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if (t.length >= 18 && letters / t.length < 0.5) return "";
  return t;
}

/**
 * Что решение по прочитанной странице говорит о строке выдачи.
 *
 * Только по прочитанным страницам: непрочитанная решения не приносит, и
 * подставлять вместо него честное «не знаем» модели значило бы гасить
 * словарную метку тем, что страницу не открыли.
 */
export type ObservationVerdict = {
  tone: "adverse" | "neutral" | "supportive";
  /** Есть ли дословная цитата: нежелательный вывод без неё рамку не назначает. */
  quoted: boolean;
  subjectMatch: "subject" | "likely" | "other" | "unclear";
  /** Кластерный ярлык сюжета — язык резюме; без него легенда берёт словарь. */
  themeLabel?: string;
};

/** `evidenceRef → решение по прочитанной странице`. */
export type ObservationVerdictByRef = Record<string, ObservationVerdict>;

/**
 * Насколько сильно решение: у материала оно одно, и это сильнейшее.
 *
 * Одну и ту же страницу могли запросить дважды, и площадка отдала её только со
 * второго раза; среди прочитанных сильнее нежелательный вывод с цитатой — то же
 * правило, по которому таблица выдачи берёт у материала сильнейшую оценку его
 * наблюдений. Иначе нейтральное решение, пришедшее в артефакте первым, молча
 * стирает негатив вместе с цитатой.
 *
 * Правило одно на весь отчёт: по нему выбирают решение и загрузчик входов деки,
 * и раскладка карты решений в аналитике.
 */
export function verdictStrength(v: ObservationVerdict | undefined): 0 | 1 | 2 {
  if (!v) return 0;
  return v.tone === "adverse" && v.quoted ? 2 : 1;
}

/**
 * Собрать карту решений для визуального слоя из артефакта чтения ссылок.
 *
 * Связь краски со словами держится на одном ключе: `evidenceRef` решения обязан
 * совпасть с тем, которым визуальный слой называет строку (`inventory:<id>`).
 * Разъедутся — рамки молча вернутся к словарю: дека соберётся, ворота пройдут,
 * и заметить это будет негде. Поэтому сборка карты — названная функция со
 * своим тестом, а не выражение внутри подготовки отчёта.
 */
export function observationVerdictsForVisuals(artifact: {
  summary?: { themes?: Array<{ theme?: string; evidenceRefs?: string[] }> };
  verdicts?: Array<{
    evidenceRef?: string;
    tone?: string;
    subjectMatch?: string;
    quotes?: Array<{ text?: string }>;
    readFailure?: string;
  }>;
}): ObservationVerdictByRef {
  const themeLabelByRef = new Map<string, string>();
  for (const theme of artifact.summary?.themes ?? []) {
    const label = String(theme.theme ?? "").trim();
    if (!label) continue;
    for (const ref of theme.evidenceRefs ?? []) themeLabelByRef.set(String(ref), label);
  }
  const out: ObservationVerdictByRef = {};
  for (const v of artifact.verdicts ?? []) {
    const ref = String(v.evidenceRef ?? "");
    // Непрочитанная страница решения не приносит — словарь заголовка всё, что
    // о ней есть.
    if (!ref || v.readFailure) continue;
    const label = themeLabelByRef.get(ref);
    out[ref] = {
      tone: (v.tone as ObservationVerdict["tone"]) ?? "neutral",
      quoted: (v.quotes ?? []).some((q) => String(q?.text ?? "").trim().length > 0),
      subjectMatch: (v.subjectMatch as ObservationVerdict["subjectMatch"]) ?? "unclear",
      ...(label ? { themeLabel: label } : {}),
    };
  }
  return out;
}

/**
 * Явное решение человека по материалу — одно поле с двумя значениями.
 *
 * Два булевых флага допускали бы состояние «и нежелательный, и нейтральный»,
 * которого не существует: источник (`markAdverse` / `markNeutral` в правках
 * аналитика) снимает противоположный флаг. Признак задаётся данными, а не
 * парой названий, которые могут разойтись.
 */
export type AnalystDecision = "ADVERSE" | "NEUTRAL";

/**
 * Строка выдачи так, как её видит предикат негативности.
 *
 * Пять полей: заголовок и сниппет читает словарь, адрес и домен — список
 * площадок, `analystDecision` — решение человека. Больше о строке предикату
 * знать нечего, и это не бедность типа, а условие: пока каждый потребитель
 * приносил свой набор полей, ответов на один вопрос стало пять.
 */
export type AdverseRowInput = {
  url?: string | null;
  domain?: string | null;
  title?: string | null;
  snippet?: string | null;
  /** Правка аналитика по этому материалу; нет правки — нет поля. */
  analystDecision?: AnalystDecision | null;
};

/**
 * Негативна ли строка — один ответ на весь отчёт.
 *
 * Порядок решений:
 *
 * 0. **решение аналитика.** Человек посмотрел материал и отвечает за отчёт;
 *    вердикт — это модель, прочитавшая страницу. Правило «совпадение не
 *    подтверждается автоматически» ставит человека выше машины во всём
 *    продукте. Порядок здесь один на отчёт: синтез находок, разбор
 *    поверхностей и конвейер аналитики спрашивают этот же предикат
 *    (`analytics/item-adverse.ts`), а не заводят свой. Список негативных
 *    площадок решение аналитика перебивает по той же причине: снять метку с
 *    записи санкционного реестра может только человек, и его «нет» обязано
 *    доезжать до листа.
 *
 *    Принадлежность («это однофамилец») решением о негативе **не
 *    подменяется**: это ответ на другой вопрос, он едет своим путём
 *    (`subject-resolution.json` → `subjectDecision`), у аналитика для него своя
 *    правка, и на печати он всё равно сильнее;
 * 1. **прочитанная страница.** Материал о другом лице не подтверждает ничего о
 *    субъекте; нейтральная и благоприятная страница снимают словарную метку;
 *    нежелательная с дословной цитатой ставит её. Нежелательный вывод без
 *    цитаты решения не приносит — то же правило, по которому он понижается в
 *    самом аудите решений, — и ответ отдаётся словарю;
 * 2. **список негативных площадок.** Санкционный реестр и агрегатор компромата
 *    негативны сами по себе: слов словаря в их заголовках может не быть вовсе;
 * 3. **словарь `adversePatterns` из конфига** — по заголовку и сниппету; на
 *    мягких площадках работает только его сильное подмножество
 *    (`strongAdversePatterns`).
 *
 * **Словарь читает текст, а домен отвечает списком, и это разные вопросы.**
 * Платят за смешение разделом сайта в адресе: у словаря есть левая граница, и
 * `…/investigations/kremlev-board` совпадает с корнем `investigat` — заголовок
 * при этом нейтральный. Внутри имени хоста та же граница совпадения не даёт
 * (`theinvestigatornews.com` не негатив), так что дело не в имени площадки.
 *
 * **Принадлежность к теме здесь не участвует.** Тема — это классификация
 * находки, а не сигнал материала: `klerk.ru` входил в доказательства темы
 * «Офшоры» среднего уровня и печатался «Нежелательным» при прочитанной и
 * признанной благоприятной странице с двумя цитатами.
 */
export function resolveRowAdverse(row: AdverseRowInput, verdict?: ObservationVerdict): boolean {
  if (row.analystDecision === "NEUTRAL") return false;
  if (row.analystDecision === "ADVERSE") return true;
  if (verdict) {
    if (verdict.subjectMatch === "other") return false;
    if (verdict.tone === "neutral" || verdict.tone === "supportive") return false;
    if (verdict.tone === "adverse" && verdict.quoted) return true;
  }
  const url = String(row.url ?? "");
  const domain = String(row.domain ?? "") || domainOf(url);
  if (ADVERSE_DOMAIN_RE.test(url) || ADVERSE_DOMAIN_RE.test(domain)) return true;
  const text = `${row.title ?? ""} ${row.snippet ?? ""}`;
  // Мягкая площадка не слепа: сильные слова краснят строку и там. Пост в
  // соцсети «Уголовное дело против …» — сигнал, а «биография, бизнес,
  // скандалы» в оглавлении энциклопедии — жанр.
  if (SOFT_PROFILE_DOMAIN_RE.test(url) || SOFT_PROFILE_DOMAIN_RE.test(domain)) {
    return getStrongAdversePatterns().test(text);
  }
  return getAdversePatterns().test(text);
}

/**
 * Негативна ли строка и о чём она — для тех, кому нужен ещё и ярлык темы.
 *
 * Негативность отдана `resolveRowAdverse`; здесь выбирается только имя сюжета:
 * ярлык кластера прочитанной страницы, а без него — рубрика справочника.
 */
export function classifyObservationHighlight(
  obs: PersistedSerpObservation,
  verdict?: ObservationVerdict,
  /**
   * Решение аналитика по этому материалу.
   *
   * Отдельным аргументом, потому что наблюдение его не несёт: правки живут на
   * элементе инвентаря, а рисованные активы строятся из него. Не передали —
   * поведение прежнее.
   */
  analystDecision?: AnalystDecision | null
): {
  isHighlighted: boolean;
  riskTheme: string | null;
  themeTitle: string | null;
} {
  if (!resolveRowAdverse({ ...obs, analystDecision }, verdict)) {
    return { isHighlighted: false, riskTheme: null, themeTitle: null };
  }
  if (verdict?.tone === "adverse" && verdict.quoted) {
    const label = verdict.themeLabel?.trim();
    if (label) return { isHighlighted: true, riskTheme: label.toLowerCase(), themeTitle: label };
  }
  const url = obs.url ?? "";
  const domain = obs.domain ?? domainOf(url);
  const theme = themeForBlob(`${obs.title ?? ""} ${obs.snippet ?? ""} ${url} ${domain}`);
  return { isHighlighted: true, riskTheme: theme.key, themeTitle: theme.title };
}

function toLoadedResult(
  obs: PersistedSerpObservation,
  verdictByRef?: ObservationVerdictByRef
): LoadedResult {
  const hl = classifyObservationHighlight(obs, verdictByRef?.[obs.id]);
  const engine: SerpEngine = obs.engine === "YANDEX" ? "YANDEX" : "GOOGLE";
  return {
    id: obs.id,
    engine,
    rank: obs.rank,
    title: obs.title,
    url: obs.url ?? "",
    domain: obs.domain,
    snippet: obs.snippet,
    classification: hl.isHighlighted ? "ADVERSE_MEDIA" : "NEUTRAL",
    riskTheme: hl.riskTheme,
    region: obs.region,
    language: obs.language,
    source: obs.provider,
    createdAt: obs.capturedAt,
    isHighlighted: hl.isHighlighted,
    themeTitle: hl.themeTitle,
  };
}

export function buildObservationThemeGrouping(
  observations: PersistedSerpObservation[],
  language: SerpLanguage = "ru",
  verdictByRef?: ObservationVerdictByRef
): { loaded: LoadedResult[]; grouping: ThemeGrouping } {
  const loaded = observations.map((o) => toLoadedResult(o, verdictByRef));
  const grouping = buildConsistentThemeGrouping(loaded, language);
  return { loaded, grouping };
}

export function observationToResultView(
  obs: PersistedSerpObservation,
  grouping: ThemeGrouping,
  verdictByRef?: ObservationVerdictByRef
): ResultView {
  const loaded = toLoadedResult(obs, verdictByRef);
  const mark = grouping.highlights.get(obs.id);
  return {
    rank: obs.rank,
    title: obs.title ?? obs.domain ?? "Результат поиска",
    url: obs.url ?? "",
    domain: obs.domain ?? domainOf(obs.url),
    snippet: sanitizeSerpSnippet(obs.snippet),
    classification: loaded.classification,
    isHighlighted: Boolean(mark) || loaded.isHighlighted,
    themeNumber: mark?.themeNumber,
    themeLabel: mark?.themeLabel,
  };
}
